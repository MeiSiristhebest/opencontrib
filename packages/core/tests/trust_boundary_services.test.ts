import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import {
  ApprovalService,
  GitHubSubmissionService,
  ContributionPrService,
  GitHubClient,
  ContributionRunManager,
  SubmissionIntentService,
  validatePhaseGate,
} from "../src/index.js";
import { createTrustedApprovalAuthority } from "../src/governance/approval-authority.js";
import { GovernanceService } from "../src/governance/governance-service.js";

const testApprovalAuthority = () =>
  createTrustedApprovalAuthority({
    issueApproval: () => ({
      approvedBy: "test-authority",
      approvalMode: "explicit_human",
    }),
  });

function seedGovernanceReadyRun(
  manager: ContributionRunManager,
  runId: string,
  body = "pr body",
): void {
  manager.saveArtifact(
    runId,
    "workspace",
    {
      workspacePath: "/tmp",
      branchName: "fixture-branch",
    },
    "WORKSPACE_PREPARED",
  );
  manager.saveArtifact(
    runId,
    "patch",
    JSON.stringify({
      title: "fix: bug",
      summary: "fix",
      rationale: "reproduce and correct the defect",
      targetFiles: [{ path: "src/fix.ts", reason: "correct defect" }],
      files: [
        {
          path: "src/fix.ts",
          operation: "MODIFY",
          content: "fixed",
          explanation: "correct defect",
        },
      ],
      implementationSteps: ["apply fix"],
      regressionTestPlan: ["bun test"],
      estimatedDiffLines: 1,
    }),
  );
  const testIdentity = {
    normalizedCommand: "bun test regression.test.ts",
    testFiles: [{ path: "regression.test.ts", sha256: "same" }],
    identitySha256: "identity-same",
  };
  saveCanonicalArtifact(
    manager,
    runId,
    "evidence",
    {
      baselineTestedAt: "2026-01-01T00:00:00.000Z",
      baselineFlakyTests: [],
      stressLoopRuns: 1,
      stressLoopPassed: true,
      handleLeakCheckPassed: true,
      passedUnitTestsCount: 1,
      failedUnitTestsCount: 0,
      reproductionVerified: true,
      allTestsPassing: true,
      redEvidence: {
        command: "bun test regression.test.ts",
        observedOutputSnippet: "failed",
        exitCode: 1,
        sourceTreeSha256: "before",
        capturedAt: "2026-01-01T00:00:00.000Z",
        assertionMatched: true,
        assertionMatchedFingerprint: "fp",
        testIdentity,
      },
      greenEvidence: {
        command: "bun test regression.test.ts",
        exitCode: 0,
        outputSnippet: "passed",
        passed: true,
        sourceTreeSha256: "after",
        capturedAt: "2026-01-01T00:01:00.000Z",
        treeChangedComparedToRed: true,
        treeHashMatchesRed: false,
        stressLoopPassed: true,
        allTestsPassing: true,
        assertionMatchedFingerprint: "fp",
        testIdentity,
      },
    },
    "EVIDENCE_COLLECTED",
  );
  manager.saveArtifact(runId, "pr_draft", body);
  new GovernanceService(manager).audit(runId, {
    prTitle: "fix: bug",
    prBody: body,
    subagentScore: 100,
  });
}

describe("Trust Boundary: Approval & Submission Services with Provenance Gates", () => {
  it("rejects generic save trying to autoAdvance to privileged phases or write authoritative artifacts", () => {
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
      }).toThrow(
        /AuthoritativeArtifactViolationError|PrivilegedPhaseViolationError/,
      );

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "governance",
          { fake: "data" },
          "GOVERNANCE_AUDITED",
        );
      }).toThrow(
        /AuthoritativeArtifactViolationError|PrivilegedPhaseViolationError/,
      );

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "submission",
          { fake: "data" },
          "PR_SUBMITTED",
        );
      }).toThrow(
        /AuthoritativeArtifactViolationError|PrivilegedPhaseViolationError/,
      );

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "result",
          { fake: "data" },
          "COMPLETED",
        );
      }).toThrow(
        /AuthoritativeArtifactViolationError|PrivilegedPhaseViolationError/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("ApprovalService binds patch & evidence hashes and detects TOCTOU mutations", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-approval-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      seedGovernanceReadyRun(manager, manifest.runId, "body");

      // Create submission intent
      const intentService = new SubmissionIntentService(manager);
      const intent = intentService.createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "body",
      });

      const approvalService = new ApprovalService(manager, testApprovalAuthority());
      const approval = approvalService.recordApproval({
        runId: manifest.runId,
        approvedBy: "alice",
        expectedIntentSha256: intent.intentSha256,
      });

      expect(approval.runId).toBe(manifest.runId);
      expect(approval.patchSha256).toBeDefined();
      expect(approval.intentSha256).toBe(intent.intentSha256);
      expect(approval.approvedBy).toBe("test-authority");

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

      seedGovernanceReadyRun(manager, manifest.runId);

      // Fake or missing submission artifact cannot advance to PR_SUBMITTED
      const summaryWithoutSub = manager.getRun(manifest.runId)!;
      const resGate = validatePhaseGate(summaryWithoutSub, "PR_SUBMITTED");
      expect(resGate.ok).toBe(false);
      expect(resGate.error?.message).toContain("submission");

      // Create submission intent
      const intentService = new SubmissionIntentService(manager);
      const intent = intentService.createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "pr body",
      });

      // Record valid ApprovalArtifact prior to submission authorization
      const approvalService = new ApprovalService(manager, testApprovalAuthority());
      approvalService.recordApproval({
        runId: manifest.runId,
        approvedBy: "reviewer",
        approvalMode: "explicit_human",
        expectedIntentSha256: intent.intentSha256,
      });

      // Now use GitHubSubmissionService mock/double
      const mockPrService = {
        submitPullRequest: async () => ({
          prNumber: 42,
          prUrl: "https://github.com/org/repo/pull/42",
          branchUrl: "https://github.com/org/repo/tree/fix",
          isDraft: false,
          commitSha: "real_head_sha",
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
            runId: manifest.runId,
            prNumber: 42,
            prUrl: "https://github.com/org/repo/pull/42",
            submissionVerified: true,
            submission: submitted.submissionArtifact,
            completedAt: new Date().toISOString(),
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
