import { describe, it, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContributionRunManager,
  ApprovalService,
  GitHubSubmissionService,
  SubmissionVerificationError,
  validatePhaseGate,
  type ContributionPrService,
  type GitHubClient,
} from "../src/index.js";

describe("Adversarial Pen-Testing: P0 Trust Boundaries & Invariants", () => {
  it("Attack 1: Agent substitutes RED test command A with different GREEN test command B", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-1-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      // Hand-craft a forged evidence bundle:
      // - redEvidence.assertionMatched = true with command A
      // - greenEvidence uses command B but has a fingerprint copied from RED (classic bypass)
      const forgedBundle = {
        redEvidence: {
          command: "bun test failing.test.ts", // command A
          exitCode: 1,
          observedOutputSnippet: "1 failed",
          sourceTreeSha256: "sha-before-fix",
          capturedAt: "2026-01-01T00:00:00Z",
          assertionMatched: true,
          assertionMatchedFingerprint: "shared-fp",
        },
        greenEvidence: {
          command: "echo PASS", // command B — attacker substitutes a different command!
          exitCode: 0,
          outputSnippet: "pass",
          passed: true,
          sourceTreeSha256: "sha-after-fix",
          capturedAt: "2026-01-01T00:01:00Z",
          treeChangedComparedToRed: true,
          treeHashMatchesRed: false,
          stressLoopPassed: true,
          allTestsPassing: true,
          assertionMatchedFingerprint: "shared-fp", // forged to match RED fingerprint!
        },
        reproductionVerified: true,
        allTestsPassing: true,
      };

      const prospectiveSummary = {
        manifest: { ...manifest, currentPhase: "WORKSPACE_PREPARED" as const },
        artifacts: {
          workspace: { workspacePath: baseDir },
          evidence: forgedBundle,
        },
        availableArtifactFiles: [],
      };

      // State machine must physically reject because commands do not match!
      const gateResult = validatePhaseGate(
        prospectiveSummary,
        "EVIDENCE_COLLECTED",
      );
      expect(gateResult.ok).toBe(false);
      expect(gateResult.error?.message).toContain(
        "test command must match RED baseline",
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 2: Attacker attempts to delete WORM RED baseline by overwriting evidence with empty/mutated redEvidence", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-2-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      // Save initial RED evidence
      manager.saveArtifact(manifest.runId, "evidence", {
        redEvidence: {
          command: "bun test",
          exitCode: 1,
          sourceTreeSha256: "tree-sha-1",
          capturedAt: "2026-01-01T00:00:00Z",
          assertionMatched: true,
          assertionMatchedFingerprint: "fp-1",
        },
      });

      // Attack: overwrite without redEvidence (trying to erase it)
      expect(() => {
        manager.saveArtifact(manifest.runId, "evidence", {
          foo: "bar",
        });
      }).toThrow(/ImmutableArtifactViolationError/);

      // Attack: overwrite with different redEvidence
      expect(() => {
        manager.saveArtifact(manifest.runId, "evidence", {
          redEvidence: {
            command: "bun test",
            exitCode: 1,
            sourceTreeSha256: "tree-sha-tampered",
            capturedAt: "2026-01-01T00:00:00Z",
            assertionMatched: true,
            assertionMatchedFingerprint: "fp-tampered",
          },
        });
      }).toThrow(/ImmutableArtifactViolationError/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 3: GitHub provider verification fails, provider error must fail closed (no verified_head_sha fallback)", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-3-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      manager.saveArtifact(manifest.runId, "workspace", {
        workspacePath: baseDir,
      });
      manager.saveArtifact(manifest.runId, "evidence", {
        redEvidence: {
          command: "test",
          exitCode: 1,
          sourceTreeSha256: "h1",
          capturedAt: "now",
          assertionMatched: true,
          assertionMatchedFingerprint: "fp",
        },
        greenEvidence: {
          command: "test",
          exitCode: 0,
          outputSnippet: "pass",
          passed: true,
          sourceTreeSha256: "h2",
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
        technicalGate: { status: "PASS" },
        approvalGate: { status: "APPROVED" },
      });
      manager.updateRunPhase(manifest.runId, "GOVERNANCE_AUDITED");

      const approvalService = new ApprovalService(manager);
      approvalService.recordApproval({ runId: manifest.runId });

      // Mock PR service succeeds in external call
      const mockPrService = {
        submitPullRequest: async () => ({
          prNumber: 99,
          prUrl: "https://github.com/org/repo/pull/99",
          branchUrl: "https://github.com/org/repo/tree/fix",
          isDraft: false,
          status: "SUCCESS" as const,
        }),
      } as unknown as ContributionPrService;

      // Provider verification client throws error or returns missing head.sha
      const mockFailingClient = {
        octokit: {
          rest: {
            pulls: {
              get: async () => {
                throw new Error("404 Not Found / Network Failure");
              },
            },
          },
        },
      } as unknown as GitHubClient;

      const submissionService = new GitHubSubmissionService(
        mockPrService,
        mockFailingClient,
        manager,
      );

      const permit = submissionService.authorizeSubmission(
        manifest.runId,
        "org",
        "repo",
      );

      // Provider failure must throw SubmissionVerificationError!
      await expect(
        submissionService.submitAndVerifyPullRequest({
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
        }),
      ).rejects.toThrow(SubmissionVerificationError);

      // Phase must NOT advance to PR_SUBMITTED!
      const finalSummary = manager.getRun(manifest.runId)!;
      expect(finalSummary.manifest.currentPhase).toBe("GOVERNANCE_AUDITED");
      expect(finalSummary.artifacts.submission).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 4: Side effect check - submission before governance audit must be rejected without calling GitHub", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-4-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      let externalSideEffectCalled = false;
      const mockPrService = {
        submitPullRequest: async () => {
          externalSideEffectCalled = true;
          return {
            prNumber: 101,
            prUrl: "https://github.com/org/repo/pull/101",
            branchUrl: "https://github.com/org/repo/tree/fix",
            isDraft: false,
            status: "SUCCESS" as const,
          };
        },
      } as unknown as ContributionPrService;

      const mockClient = { octokit: {} } as unknown as GitHubClient;
      const submissionService = new GitHubSubmissionService(
        mockPrService,
        mockClient,
        manager,
      );

      // Attempt authorizeSubmission when phase is still INITIALIZED
      expect(() => {
        submissionService.authorizeSubmission(manifest.runId, "org", "repo");
      }).toThrow(/expected "GOVERNANCE_AUDITED"/);

      // External GitHub side effect was never called!
      expect(externalSideEffectCalled).toBe(false);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 5: TOCTOU - Modifying PR body after approval invalidates permit and rejects submission", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-5-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      manager.saveArtifact(manifest.runId, "workspace", {
        workspacePath: baseDir,
      });
      manager.saveArtifact(manifest.runId, "evidence", {
        redEvidence: {
          command: "test",
          exitCode: 1,
          sourceTreeSha256: "h1",
          capturedAt: "now",
          assertionMatched: true,
          assertionMatchedFingerprint: "fp",
        },
        greenEvidence: {
          command: "test",
          exitCode: 0,
          outputSnippet: "pass",
          passed: true,
          sourceTreeSha256: "h2",
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
        technicalGate: { status: "PASS" },
        approvalGate: { status: "APPROVED" },
      });
      manager.saveArtifact(manifest.runId, "pr_draft", "Original PR Body");
      manager.updateRunPhase(manifest.runId, "GOVERNANCE_AUDITED");

      // Record approval on original PR body
      const approvalService = new ApprovalService(manager);
      approvalService.recordApproval({ runId: manifest.runId });

      // Malicious agent mutates PR body after approval
      manager.saveArtifact(
        manifest.runId,
        "pr_draft",
        "Malicious Injected PR Body",
      );

      const mockPrService = {
        submitPullRequest: async () => ({
          prNumber: 102,
          prUrl: "https://github.com/org/repo/pull/102",
          branchUrl: "https://github.com/org/repo/tree/fix",
          isDraft: false,
          status: "SUCCESS" as const,
        }),
      } as unknown as ContributionPrService;
      const mockClient = { octokit: {} } as unknown as GitHubClient;
      const submissionService = new GitHubSubmissionService(
        mockPrService,
        mockClient,
        manager,
      );

      // Must fail closed due to PR draft body TOCTOU mutation!
      expect(() => {
        submissionService.authorizeSubmission(manifest.runId, "org", "repo");
      }).toThrow(/PR draft body has changed since approval/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
