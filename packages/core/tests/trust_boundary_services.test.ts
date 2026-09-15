import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ApprovalService,
  GitHubSubmissionService,
  ContributionPrService,
  GitHubClient,
  ContributionRunManager,
  validatePhaseGate,
} from "../src/index.js";

describe("Trust Boundary: Approval & Submission Services with Provenance Gates", () => {
  it("rejects generic save trying to autoAdvance to privileged phases", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-priv-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "evidence",
          { fake: "data" },
          "EVIDENCE_COLLECTED",
        );
      }).toThrow("PrivilegedPhaseViolationError");

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "governance",
          { fake: "data" },
          "GOVERNANCE_AUDITED",
        );
      }).toThrow("PrivilegedPhaseViolationError");

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "submission",
          { fake: "data" },
          "PR_SUBMITTED",
        );
      }).toThrow("PrivilegedPhaseViolationError");

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "result",
          { fake: "data" },
          "COMPLETED",
        );
      }).toThrow("PrivilegedPhaseViolationError");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("ApprovalService binds patch & evidence hashes and detects TOCTOU mutations", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-approval-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      // Save initial patch and evidence
      manager.saveArtifact(manifest.runId, "patch", "diff original");
      manager.saveArtifact(manifest.runId, "evidence", { test: "passed" });

      const approvalService = new ApprovalService(manager);
      const approval = approvalService.recordApproval({
        runId: manifest.runId,
        approvedBy: "alice",
      });

      expect(approval.runId).toBe(manifest.runId);
      expect(approval.patchSha256).toBeDefined();
      expect(approval.approvedBy).toBe("alice");

      // Verify integrity before mutation
      const check1 = approvalService.verifyApprovalIntegrity(manifest.runId);
      expect(check1.valid).toBe(true);

      // Now mutate the patch (TOCTOU attack)
      manager.saveArtifact(manifest.runId, "patch", "diff mutated maliciously");

      // Verification must fail!
      const check2 = approvalService.verifyApprovalIntegrity(manifest.runId);
      expect(check2.valid).toBe(false);
      expect(check2.reason).toContain("TOCTOU violation");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("PR_SUBMITTED requires verified SubmissionArtifact produced by submission service", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-submission-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      manager.saveArtifact(manifest.runId, "workspace", {
        workspacePath: "/tmp",
      });
      manager.saveArtifact(manifest.runId, "evidence", {
        redEvidence: {
          command: "test",
          exitCode: 1,
          sourceTreeSha256: "hash1",
          capturedAt: "now",
          assertionMatched: true,
          assertionMatchedFingerprint: "fp",
        },
        greenEvidence: {
          command: "test",
          exitCode: 0,
          outputSnippet: "pass",
          passed: true,
          sourceTreeSha256: "hash2",
          capturedAt: "now",
          treeChangedComparedToRed: true,
          treeHashMatchesRed: false,
          stressLoopPassed: true,
          allTestsPassing: true,
          assertionMatchedFingerprint: "fp",
        },
        reproductionVerified: true,
        allTestsPassing: true,
      });
      manager.saveArtifact(manifest.runId, "governance", {
        overallScore: 95,
        weakestDimension: { dimension: "imp", score: 90 },
        technicalGate: { status: "PASS", passed: true },
        approvalGate: { status: "APPROVED", approved: true },
        isGatedPassed: true,
        requiresHumanApproval: false,
        rfcGatePassed: true,
        diffLineCount: 10,
        antiAiCheckPassed: true,
        flaggedAiPhrases: [],
        remediationSuggestions: [],
      });

      // Advance to GOVERNANCE_AUDITED
      manager.updateRunPhase(manifest.runId, "GOVERNANCE_AUDITED");

      // Fake or missing submission artifact cannot advance to PR_SUBMITTED
      const summaryWithoutSub = manager.getRun(manifest.runId)!;
      const resGate = validatePhaseGate(summaryWithoutSub, "PR_SUBMITTED");
      expect(resGate.ok).toBe(false);
      expect(resGate.error?.message).toContain("submission");

      // Record valid ApprovalArtifact prior to submission authorization
      const approvalService = new ApprovalService(manager);
      approvalService.recordApproval({
        runId: manifest.runId,
        approvedBy: "reviewer",
        approvalMode: "explicit_human",
      });

      // Now use GitHubSubmissionService mock/double
      const mockPrService = {
        submitPullRequest: async () => ({
          prNumber: 42,
          prUrl: "https://github.com/org/repo/pull/42",
          branchUrl: "https://github.com/org/repo/tree/fix",
          isDraft: false,
          status: "SUCCESS" as const,
        }),
      } as unknown as ContributionPrService;

      const mockClient = {
        octokit: {
          rest: {
            pulls: {
              get: async () => ({
                data: { head: { sha: "real_head_sha" } },
              }),
            },
          },
        },
      } as unknown as GitHubClient;

      const submissionService = new GitHubSubmissionService(
        mockPrService,
        mockClient,
        manager,
      );

      // Authorize submission (creates SubmissionPermit)
      const permit = submissionService.authorizeSubmission(
        manifest.runId,
        "org",
        "repo",
      );

      const submitted = await submissionService.submitAndVerifyPullRequest({
        runId: manifest.runId,
        permit,
        submissionOptions: {
          upstreamOwner: "org",
          upstreamRepo: "repo",
          title: "fix: bug",
          body: "pr body",
          branchName: "fix",
          files: [],
          commitMessage: "fix: bug",
        },
      });

      expect(submitted.submissionArtifact.verified).toBe(true);
      expect(submitted.submissionArtifact.prNumber).toBe(42);

      const summaryAfterSub = manager.getRun(manifest.runId)!;
      expect(summaryAfterSub.manifest.currentPhase).toBe("PR_SUBMITTED");
      expect(summaryAfterSub.artifacts.submission).toBeDefined();

      // Next phase COMPLETED can now proceed because SubmissionArtifact is valid
      const nextPhaseSummary = {
        ...summaryAfterSub,
        artifacts: {
          ...summaryAfterSub.artifacts,
          result: {
            prNumber: 42,
            prUrl: "https://github.com/org/repo/pull/42",
            submission: submitted.submissionArtifact,
          },
        },
      };
      const validCompletedGate = validatePhaseGate(
        nextPhaseSummary,
        "COMPLETED",
      );
      expect(validCompletedGate.ok).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
