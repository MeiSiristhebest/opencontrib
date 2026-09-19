import { describe, it, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import {
  ContributionRunManager,
  ApprovalService,
  GitHubSubmissionService,
  SubmissionVerificationError,
  SubmissionIntentService,
  validatePhaseGate,
  computeTestIdentity,
  resolveTestFiles,
  type ContributionPrService,
  type GitHubClient,
} from "../src/index.js";
import { createTrustedApprovalAuthority } from "../src/governance/approval-authority.js";
import {
  GovernanceService,
  type GovernanceAuditRunOptions,
} from "../src/governance/governance-service.js";
import { hashValidatedPatchArtifact } from "../src/evidence/validated-patch.js";
import {
  hashTrustedPolicySnapshot,
  mergeTrustedPolicySnapshots,
  type TrustedPolicySnapshot,
} from "../src/kernel/config.js";
import { WorkspaceService } from "../src/workspace/workspace-service.js";

const testApprovalAuthority = () =>
  createTrustedApprovalAuthority({
    issueApproval: () => ({
      approvedBy: "test-authority",
      approvalMode: "explicit_human",
      signingKeyId: "test-key",
      signature: "test-signature",
    }),
    verifyApproval: (artifact) =>
      artifact.signingKeyId === "test-key" &&
      artifact.signature === "test-signature",
  });

function makeValidatedPatch(
  runId: string,
  patchSha256: string,
  redTreeSha256: string,
  greenTreeSha256: string,
) {
  const artifact = {
    runId,
    patchSha256,
    actualDeltaSha256: "0".repeat(64),
    baseCommitSha: "a".repeat(40),
    redTreeSha256,
    greenTreeSha256,
    artifactSha256: "",
    changedLines: 0,
    files: [],
    validatedAt: "2026-01-01T00:01:00Z",
  };
  artifact.artifactSha256 = hashValidatedPatchArtifact(artifact);
  return artifact;
}

function seedGovernanceReadyRun(
  manager: ContributionRunManager,
  runId: string,
  body = "pr body",
  workspacePath = "/tmp",
  options: {
    skipWorkspace?: boolean;
    policySnapshot?: TrustedPolicySnapshot;
    auditOptions?: GovernanceAuditRunOptions;
  } = {},
) {
  const baseCommitSha = "a".repeat(40);
  const patch = {
    title: "fix: bug",
    summary: "fix",
    rationale: "reproduce and correct the defect",
    targetFiles: [{ path: "src/fix.ts", reason: "correct defect" }],
    files: [
      {
        path: "src/fix.ts",
        operation: "MODIFY",
        mode: "100644",
        content: "fixed",
        explanation: "correct defect",
      },
    ],
    implementationSteps: ["apply fix"],
    regressionTestPlan: ["bun test"],
    estimatedDiffLines: 1,
  };
  const patchContent = JSON.stringify(patch);
  const patchSha256 = createHash("sha256").update(patchContent).digest("hex");
  const validatedPatch = {
    runId,
    patchSha256,
    actualDeltaSha256: "b".repeat(64),
    baseCommitSha,
    redTreeSha256: "c".repeat(64),
    greenTreeSha256: "d".repeat(64),
    artifactSha256: "",
    changedLines: 0,
    files: [
      {
        path: "src/fix.ts",
        operation: "MODIFY" as const,
        mode: "100644" as const,
        contentSha256: createHash("sha256").update("fixed").digest("hex"),
      },
    ],
    validatedAt: "2026-01-01T00:01:00.000Z",
  };
  validatedPatch.artifactSha256 = hashValidatedPatchArtifact(validatedPatch);
  if (!options.skipWorkspace) {
    const policySnapshot =
      options.policySnapshot ??
      ({
        coverage: {
          required: true,
          minimumChangedLineCoverage: 90,
        },
        resourceLeakCheck: { required: false },
      } as const);
    saveCanonicalArtifact(
      manager,
      runId,
      "workspace",
      {
        workspacePath,
        branchName: "fixture-branch",
        baseRepoPath: "/tmp",
        baseBranch: "main",
        baseCommitSha,
        isWorktree: false,
        repoFullName: "org/repo",
        policySnapshot,
        policySha256: hashTrustedPolicySnapshot(policySnapshot),
      },
      "WORKSPACE_PREPARED",
    );
  }
  saveCanonicalArtifact(
    manager,
    runId,
    "evidence_red",
    {
      command: "bun test regression.test.ts",
      observedOutputSnippet: "failed",
      exitCode: 1,
      sourceTreeSha256: "c".repeat(64),
      capturedAt: "2026-01-01T00:00:00.000Z",
      assertionMatched: true,
    } as any,
    "RED_CAPTURED",
  );
  manager.saveArtifact(runId, "patch", patchContent, "PATCH_DRAFTED");
  saveCanonicalArtifact(manager, runId, "validated_patch", validatedPatch);
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
      changedCodeCoveragePercent: 95,
      changedCodeCoverageStatus: "PASS",
      redEvidence: {
        command: "bun test regression.test.ts",
        observedOutputSnippet: "failed",
        exitCode: 1,
        sourceTreeSha256: "c".repeat(64),
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
        sourceTreeSha256: "d".repeat(64),
        capturedAt: "2026-01-01T00:01:00.000Z",
        treeChangedComparedToRed: true,
        treeHashMatchesRed: false,
        appliedPatchSha256: patchSha256,
        validatedPatchArtifactSha256: validatedPatch.artifactSha256,
        stressLoopPassed: true,
        allTestsPassing: true,
        assertionMatchedFingerprint: "fp",
        testIdentity,
      },
    },
    "EVIDENCE_COLLECTED",
  );
  manager.saveArtifact(runId, "pr_draft", body);
  return new GovernanceService(manager).audit(runId, {
    prTitle: "fix: bug",
    prBody: body,
    subagentScore: 100,
    ...options.auditOptions,
  });
}

describe("Adversarial Pen-Testing: P0 Trust Boundaries & Invariants", () => {
  it("promotes the trusted advisory floor when coverage is required without a minimum", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-policy-advisory-floor-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      const decision = seedGovernanceReadyRun(
        manager,
        manifest.runId,
        "pr body",
        "/tmp",
        {
          policySnapshot: mergeTrustedPolicySnapshots(
            {
              coverage: {
                required: false,
                minimumChangedLineCoverage: 90,
              },
              resourceLeakCheck: { required: false },
            },
            {
              coverage: {
                required: false,
                minimumChangedLineCoverage: 70,
              },
              resourceLeakCheck: { required: false },
            },
          ),
          auditOptions: {
            coveragePolicy: { required: true },
          },
        },
      );

      expect(decision.coveragePolicy).toEqual({
        required: true,
        minimumChangedLineCoverage: 90,
      });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("uses the frozen policy snapshot after the agent lowers worktree policy", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-policy-snapshot-"));
    const workspacePath = join(baseDir, "workspace");
    const previousHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = join(baseDir, "host-home");
    mkdirSync(workspacePath, { recursive: true });
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      const fakeWorktreeManager = {
        runGit: (args: string[]) => {
          if (args.includes("ls-tree")) {
            return {
              success: true,
              stdout: args.includes(".opencontrib.json")
                ? ".opencontrib.json\n"
                : "",
              stderr: "",
            };
          }
          if (args.includes("show")) {
            return {
              success: true,
              stdout: JSON.stringify({
                policy: {
                  coverage: {
                    required: true,
                    minimumChangedLineCoverage: 90,
                  },
                },
              }),
              stderr: "",
            };
          }
          return { success: true, stdout: "", stderr: "" };
        },
        createIsolatedWorkspace: () => ({
          workspacePath,
          branchName: "fixture-branch",
          isWorktree: false,
          baseRepoPath: workspacePath,
          baseCommitSha: "a".repeat(40),
          baseBranch: "main",
        }),
        detectDefaultBranch: () => "main",
      } as any;
      const prepared = new WorkspaceService(
        manager,
        fakeWorktreeManager,
      ).prepare({
        runId: manifest.runId,
        issueOrTaskId: 1,
      });

      writeFileSync(
        join(workspacePath, ".opencontrib.json"),
        JSON.stringify({
          policy: {
            coverage: {
              required: false,
              minimumChangedLineCoverage: 0,
            },
          },
        }),
      );
      const decision = seedGovernanceReadyRun(
        manager,
        manifest.runId,
        "pr body",
        workspacePath,
        { skipWorkspace: true },
      );

      expect(prepared.artifact.policySnapshot).toEqual({
        coverage: {
          required: true,
          minimumChangedLineCoverage: 90,
        },
        resourceLeakCheck: { required: false },
      });
      expect(decision.coveragePolicy).toEqual(
        prepared.artifact.policySnapshot.coverage,
      );
      expect(decision.policySha256).toBe(
        hashTrustedPolicySnapshot({
          coverage: {
            required: true,
            minimumChangedLineCoverage: 90,
          },
          resourceLeakCheck: { required: false },
        }),
      );
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 1: Agent substitutes RED test command A with different GREEN test command B", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-1-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      const forgedBundle = {
        redEvidence: {
          command: "bun test failing.test.ts", // command A
          exitCode: 1,
          observedOutputSnippet: "1 failed",
          sourceTreeSha256: "sha-before-fix",
          capturedAt: "2026-01-01T00:00:00Z",
          assertionMatched: true,
          assertionMatchedFingerprint: "shared-fp",
          testIdentity: {
            normalizedCommand: "bun test failing.test.ts",
            testFiles: [{ path: "failing.test.ts", sha256: "same" }],
            identitySha256: "identity-same",
          },
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
          testIdentity: {
            normalizedCommand: "echo PASS",
            testFiles: [{ path: "failing.test.ts", sha256: "same" }],
            identitySha256: "identity-same",
          },
        },
        reproductionVerified: true,
        allTestsPassing: true,
      };

      const forgedPatch = "{}";
      const forgedPatchSha256 = createHash("sha256")
        .update(forgedPatch)
        .digest("hex");
      const forgedValidatedPatch = {
        runId: manifest.runId,
        patchSha256: forgedPatchSha256,
        actualDeltaSha256: "0".repeat(64),
        baseCommitSha: "a".repeat(40),
        redTreeSha256: "sha-before-fix",
        greenTreeSha256: "sha-after-fix",
        artifactSha256: "",
        changedLines: 0,
        files: [],
        validatedAt: "2026-01-01T00:01:00Z",
      };
      forgedValidatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(forgedValidatedPatch);
      (forgedBundle.greenEvidence as any).appliedPatchSha256 =
        forgedPatchSha256;
      (forgedBundle.greenEvidence as any).validatedPatchArtifactSha256 =
        forgedValidatedPatch.artifactSha256;
      const prospectiveSummary = {
        manifest: { ...manifest, currentPhase: "PATCH_DRAFTED" as const },
        artifacts: {
          workspace: { workspacePath: baseDir, baseCommitSha: "a".repeat(40) },
          patch: forgedPatch,
          validatedPatch: forgedValidatedPatch,
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
      saveCanonicalArtifact(manager, manifest.runId, "evidence", {
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
        saveCanonicalArtifact(manager, manifest.runId, "evidence", {
          foo: "bar",
        });
      }).toThrow(/ImmutableArtifactViolationError/);

      // Attack: overwrite with different redEvidence
      expect(() => {
        saveCanonicalArtifact(manager, manifest.runId, "evidence", {
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

      seedGovernanceReadyRun(manager, manifest.runId);

      const intentService = new SubmissionIntentService(manager);
      const intent = intentService.createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "pr body",
      });

      const approvalService = new ApprovalService(
        manager,
        testApprovalAuthority(),
      );
      await approvalService.recordApproval({
        runId: manifest.runId,
        expectedIntentSha256: intent.intentSha256,
      });

      // Mock PR service succeeds in external call
      const mockPrService = {
        submitPullRequest: async () => ({
          prNumber: 99,
          prUrl: "https://github.com/org/repo/pull/99",
          branchUrl: "https://github.com/org/repo/tree/fix",
          isDraft: false,
          commitSha: "expected_commit_sha",
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
        testApprovalAuthority(),
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
            commitSha: "commit_sha",
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

      seedGovernanceReadyRun(manager, manifest.runId, "Original PR Body");

      const intentService = new SubmissionIntentService(manager);
      const intent = intentService.createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "Original PR Body",
      });

      // Record approval on original PR body
      const approvalService = new ApprovalService(
        manager,
        testApprovalAuthority(),
      );
      await approvalService.recordApproval({
        runId: manifest.runId,
        expectedIntentSha256: intent.intentSha256,
      });

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
          commitSha: "sha",
          status: "SUCCESS" as const,
        }),
      } as unknown as ContributionPrService;
      const mockClient = { octokit: {} } as unknown as GitHubClient;
      const submissionService = new GitHubSubmissionService(
        mockPrService,
        mockClient,
        manager,
        testApprovalAuthority(),
      );

      // Must fail closed due to PR draft body TOCTOU mutation!
      expect(() => {
        submissionService.authorizeSubmission(manifest.runId, "org", "repo");
      }).toThrow(/TOCTOU violation: PR body has changed since approval/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 6: Agent keeps the SAME test command but mutates the regression test file to always pass", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-6-"));
    try {
      const testFileRel = "regression.test.ts";
      writeFileSync(
        join(baseDir, testFileRel),
        "test('sum', () => { expect(1 + 1).toBe(3); });\n",
      );

      const redIdentity = computeTestIdentity(
        baseDir,
        `bun test ${testFileRel}`,
        "toBe(3)",
      );
      expect(
        resolveTestFiles(baseDir, `bun test ${testFileRel}`).length,
      ).toBeGreaterThanOrEqual(1);
      expect(redIdentity.testFiles.some((f) => f.path === testFileRel)).toBe(
        true,
      );

      writeFileSync(
        join(baseDir, testFileRel),
        "test('sum', () => { expect(1 + 1).toBe(2); });\n",
      );

      const greenIdentity = computeTestIdentity(
        baseDir,
        `bun test ${testFileRel}`,
        "toBe(3)",
      );

      expect(greenIdentity.identitySha256).not.toBe(redIdentity.identitySha256);

      const forgedBundle = {
        redEvidence: {
          command: `bun test ${testFileRel}`,
          exitCode: 1,
          observedOutputSnippet: "1 failed",
          sourceTreeSha256: "sha-before-fix",
          capturedAt: "2026-01-01T00:00:00Z",
          assertionMatched: true,
          assertionMatchedFingerprint: "fp",
          testIdentity: redIdentity,
        },
        greenEvidence: {
          command: `bun test ${testFileRel}`, // SAME command
          exitCode: 0,
          outputSnippet: "pass",
          passed: true,
          sourceTreeSha256: "sha-after-fix",
          capturedAt: "2026-01-01T00:01:00Z",
          treeChangedComparedToRed: true,
          treeHashMatchesRed: false,
          stressLoopPassed: true,
          allTestsPassing: true,
          assertionMatchedFingerprint: "fp",
          testIdentity: greenIdentity, // BUT DIFFERENT test-file content!
        },
        reproductionVerified: true,
        allTestsPassing: true,
      };

      const patch = "{}";
      const patchSha256 = createHash("sha256").update(patch).digest("hex");
      const validatedPatch = makeValidatedPatch(
        "r1",
        patchSha256,
        "sha-before-fix",
        "sha-after-fix",
      );
      const evidenceWithPatchBinding = {
        ...forgedBundle,
        greenEvidence: {
          ...forgedBundle.greenEvidence,
          appliedPatchSha256: patchSha256,
          validatedPatchArtifactSha256: validatedPatch.artifactSha256,
        },
      };
      const prospectiveSummary = {
        manifest: {
          runId: "r1",
          schemaVersion: "1.0.0",
          repoFullName: "org/repo",
          currentPhase: "PATCH_DRAFTED" as const,
          createdAt: "now",
          updatedAt: "now",
        },
        artifacts: {
          workspace: { workspacePath: baseDir, baseCommitSha: "a".repeat(40) },
          patch,
          validatedPatch,
          evidence: evidenceWithPatchBinding,
        },
        availableArtifactFiles: [],
      };

      const gateResult = validatePhaseGate(
        prospectiveSummary,
        "EVIDENCE_COLLECTED",
      );
      expect(gateResult.ok).toBe(false);
      expect(gateResult.error?.message).toContain("TestIdentity mismatch");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("Attack 6b: test-file mutation under an explicit testMutationPolicy with matching diff hash is accepted", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-pen-test-6b-"));
    try {
      const testFileRel = "regression.test.ts";
      writeFileSync(
        join(baseDir, testFileRel),
        "test('sum', () => { expect(1 + 1).toBe(3); });\n",
      );
      const redIdentity = computeTestIdentity(
        baseDir,
        `bun test ${testFileRel}`,
        "toBe(3)",
      );

      writeFileSync(
        join(baseDir, testFileRel),
        "test('sum', () => { expect(1 + 1).toBe(2); });\n",
      );
      const greenIdentity = computeTestIdentity(
        baseDir,
        `bun test ${testFileRel}`,
        "toBe(0)",
      );

      const diffHash = "audit-hash-of-changed-test";

      const okBundle = {
        redEvidence: {
          command: `bun test ${testFileRel}`,
          exitCode: 1,
          observedOutputSnippet: "1 failed",
          sourceTreeSha256: "sha-before",
          capturedAt: "2026-01-01T00:00:00Z",
          assertionMatched: true,
          assertionMatchedFingerprint: "fp",
          testIdentity: redIdentity,
          testMutationPolicy: {
            allowed: true,
            expectedDiffSha256: diffHash,
          },
        },
        greenEvidence: {
          command: `bun test ${testFileRel}`,
          exitCode: 0,
          outputSnippet: "pass",
          passed: true,
          sourceTreeSha256: "sha-after",
          capturedAt: "2026-01-01T00:01:00Z",
          treeChangedComparedToRed: true,
          treeHashMatchesRed: false,
          stressLoopPassed: true,
          allTestsPassing: true,
          assertionMatchedFingerprint: "fp",
          testIdentity: greenIdentity,
          actualTestDiffSha256: diffHash,
        },
        reproductionVerified: true,
        allTestsPassing: true,
      };

      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      const patch = "{}";
      const patchSha256 = createHash("sha256").update(patch).digest("hex");
      const validatedPatch = makeValidatedPatch(
        manifest.runId,
        patchSha256,
        "sha-before",
        "sha-after",
      );
      const evidenceWithPatchBinding = {
        ...okBundle,
        greenEvidence: {
          ...okBundle.greenEvidence,
          appliedPatchSha256: patchSha256,
          validatedPatchArtifactSha256: validatedPatch.artifactSha256,
        },
      };
      const prospectiveSummary = {
        manifest: { ...manifest, currentPhase: "PATCH_DRAFTED" as const },
        artifacts: {
          workspace: { workspacePath: baseDir, baseCommitSha: "a".repeat(40) },
          patch,
          validatedPatch,
          evidence: evidenceWithPatchBinding,
        },
        availableArtifactFiles: [],
      };
      // Audited test mutation with matching diff hash is allowed through the gate.
      const mutationGate = validatePhaseGate(
        prospectiveSummary,
        "EVIDENCE_COLLECTED",
      );
      expect(mutationGate.ok).toBe(true);

      // ...but the SAME mutation with mismatched diff hash must be rejected.
      const mismatchedAudit = JSON.parse(JSON.stringify(okBundle)) as any;
      mismatchedAudit.greenEvidence.actualTestDiffSha256 =
        "different-diff-hash";
      mismatchedAudit.greenEvidence.appliedPatchSha256 = patchSha256;
      mismatchedAudit.greenEvidence.validatedPatchArtifactSha256 =
        validatedPatch.artifactSha256;
      const blockedSummary = {
        manifest: { ...manifest, currentPhase: "PATCH_DRAFTED" as const },
        artifacts: {
          workspace: { workspacePath: baseDir, baseCommitSha: "a".repeat(40) },
          patch,
          validatedPatch,
          evidence: mismatchedAudit,
        },
        availableArtifactFiles: [],
      };
      expect(validatePhaseGate(blockedSummary, "EVIDENCE_COLLECTED").ok).toBe(
        false,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
