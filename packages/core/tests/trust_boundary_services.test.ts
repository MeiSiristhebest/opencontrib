import { describe, expect, it } from "bun:test";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
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
import { EvidenceService } from "../src/evidence/evidence-service.js";
import { GovernanceService } from "../src/governance/governance-service.js";
import { hashValidatedPatchArtifact } from "../src/evidence/validated-patch.js";

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
  saveCanonicalArtifact(
    manager,
    runId,
    "workspace",
    {
      workspacePath: "/tmp",
      branchName: "fixture-branch",
      baseRepoPath: "/tmp",
      baseBranch: "main",
      baseCommitSha,
      isWorktree: false,
      repoFullName: "org/repo",
    },
    "WORKSPACE_PREPARED",
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

      const approvalService = new ApprovalService(
        manager,
        testApprovalAuthority(),
      );
      const approval = approvalService.recordApproval({
        runId: manifest.runId,
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
      manager.saveArtifact(
        manifest.runId,
        "patch",
        JSON.stringify({ files: [] }),
      );

      // Verification must fail!
      const check2 = approvalService.verifyApprovalIntegrity(manifest.runId);
      expect(check2.valid).toBe(false);
      expect(check2.reason).toContain("TOCTOU violation");

      // If an attacker tampers with the patch file directly on disk, verifyApprovalIntegrity also detects TOCTOU!
      const patchPath = join(baseDir, manifest.runId, "patch.diff");
      writeFileSync(patchPath, JSON.stringify({ mutated: true }));

      const check3 = approvalService.verifyApprovalIntegrity(manifest.runId);
      expect(check3.valid).toBe(false);
      expect(check3.reason).toContain("TOCTOU violation");
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
      const approvalService = new ApprovalService(
        manager,
        testApprovalAuthority(),
      );
      approvalService.recordApproval({
        runId: manifest.runId,
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
            git: {
              getRef: async () => ({
                data: { object: { sha: "a".repeat(40) } },
              }),
            },
            pulls: {
              get: async () => ({
                data: {
                  head: { sha: "real_head_sha" },
                  base: { sha: "a".repeat(40) },
                },
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
  it("ContributionPrService.submitPullRequest points createRef directly at newCommit.data.sha", async () => {
    let createdRefSha: string | undefined;
    let createdRefName: string | undefined;

    const fakeOctokit: any = {
      rest: {
        users: {
          getAuthenticated: async () => ({
            data: { login: "fork-user", name: "Fork User" },
          }),
        },
        repos: {
          get: async () => ({
            data: {
              name: "repo",
              owner: { login: "fork-user" },
              default_branch: "main",
              fork: true,
              parent: {
                full_name: "upstream-owner/repo",
                owner: { login: "upstream-owner" },
              },
            },
          }),
          getBranch: async () => ({
            data: {
              name: "main",
              commit: { sha: "0123456789abcdef0123456789abcdef01234567" },
            },
          }),
        },
        git: {
          getTree: async () => ({
            data: { sha: "base-tree-sha" },
          }),
          createBlob: async () => ({
            data: { sha: "blob-sha-9999" },
          }),
          createTree: async () => ({
            data: { sha: "new-tree-sha" },
          }),
          createCommit: async () => ({
            data: { sha: "commit-sha-5678" },
          }),
          getCommit: async () => ({
            data: { tree: { sha: "base-tree-sha" } },
          }),
          getRef: async () => ({
            data: {
              object: { sha: "0123456789abcdef0123456789abcdef01234567" },
            },
          }),
          createRef: async (args: any) => {
            createdRefName = args.ref;
            createdRefSha = args.sha;
            return { data: {} };
          },
        },
        pulls: {
          list: async () => ({ data: [] }),
          create: async () => ({
            data: {
              number: 101,
              html_url: "https://github.com/upstream-owner/repo/pull/101",
            },
          }),
        },
      },
    };

    const fakeClient = {
      octokit: fakeOctokit,
      getRepoDetails: async () => ({
        success: true,
        data: { defaultBranch: "main" },
      }),
    } as any;
    const prService = new ContributionPrService(fakeClient);

    const res = await prService.submitPullRequest({
      upstreamOwner: "upstream-owner",
      upstreamRepo: "repo",
      title: "fix: sample bug",
      body: "fixes #1",
      branchName: "opencontrib/run-123",
      expectedBaseCommitSha: "0123456789abcdef0123456789abcdef01234567",
      files: [{ path: "fix.ts", content: "export const x = 1;" }],
      commitMessage: "fix: sample bug",
    });

    expect(res.status).toBe("SUCCESS");
    expect(res.commitSha).toBe("commit-sha-5678");
    expect(createdRefName).toBe("refs/heads/opencontrib/run-123");
    // Explicit verification: createRef points to newly produced commit SHA, not base SHA!
    expect(createdRefSha).toBe("commit-sha-5678");
  });

  it("EvidenceService throws EvidenceWorkspaceRequiredError when run has no canonical workspace artifact", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ev-no-ws-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      const evidenceService = new EvidenceService(manager);
      expect(() => {
        evidenceService.captureRed({
          runId: manifest.runId,
          cwd: "/some/unrelated/cwd",
          testCommand: "bun test",
        });
      }).toThrow("EvidenceWorkspaceRequiredError");
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("WorkspaceService verifies localRepoPath origin remote against manifest.repoFullName", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ws-origin-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/target-repo" });

      const fakeWorktreeManager = {
        runGit: (args: string[]) => {
          if (args.includes("remote") && args.includes("get-url")) {
            return {
              success: true,
              stdout:
                "https://github.com/attacker/malicious-spoofed-repo.git\n",
              stderr: "",
            };
          }
          return { success: true, stdout: "", stderr: "" };
        },
        createIsolatedWorkspace: () => ({
          workspacePath: "/fake/path",
          branchName: "opencontrib/run-123",
          isWorktree: true,
          baseRepoPath: "/fake/path",
        }),
      } as any;

      const {
        WorkspaceService,
      } = require("../src/workspace/workspace-service.js");
      const service = new WorkspaceService(manager, fakeWorktreeManager);

      expect(() => {
        service.prepare({
          runId: manifest.runId,
          issueOrTaskId: 1,
          localRepoPath: baseDir,
        });
      }).toThrow(/WorkspaceOriginMismatchError/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("WorkspaceService enforces strict WORM: cannot re-prepare workspace if already allocated", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ws-worm-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });

      const wsPath = join(baseDir, "allocated-ws");
      mkdirSync(wsPath, { recursive: true });

      const fakeWorktreeManager = {
        createIsolatedWorkspace: () => ({
          workspacePath: wsPath,
          branchName: "opencontrib/run-test",
          isWorktree: true,
          baseRepoPath: wsPath,
          baseCommitSha: "a".repeat(40),
          baseBranch: "main",
        }),
        detectDefaultBranch: () => "main",
      } as any;

      const {
        WorkspaceService,
      } = require("../src/workspace/workspace-service.js");
      const service = new WorkspaceService(manager, fakeWorktreeManager);

      // First preparation creates workspace artifact
      const first = service.prepare({
        runId: manifest.runId,
        issueOrTaskId: 1,
      });
      expect(first.alreadyPrepared).toBe(false);

      // Second preparation returns existing canonical workspace if exists
      const second = service.prepare({
        runId: manifest.runId,
        issueOrTaskId: 1,
      });
      expect(second.alreadyPrepared).toBe(true);

      // Deleting the physical folder triggers WorkspaceImmutableViolationError (cannot allocate new workspace for same run)
      rmSync(first.context.workspacePath, { recursive: true, force: true });
      expect(() => {
        service.prepare({
          runId: manifest.runId,
          issueOrTaskId: 1,
        });
      }).toThrow(/WorkspaceImmutableViolationError/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("EvidenceService.verifyGreen enforces that patch artifact files exist and match on disk", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ev-patch-"));
    const wsDir = join(baseDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });

      const {
        saveCanonicalArtifact,
      } = require("../src/run/canonical-writer.js");
      const stateFile = join(wsDir, "test.txt");
      writeFileSync(stateFile, "FAIL\n");
      const { execSync } = require("child_process");
      execSync("git init -b main", { cwd: wsDir, stdio: "ignore" });
      execSync(
        "git config user.name Tester && git config user.email test@example.com",
        { cwd: wsDir, stdio: "ignore" },
      );
      execSync("git add test.txt && git commit -m baseline", {
        cwd: wsDir,
        stdio: "ignore",
      });
      const baseCommitSha = execSync("git rev-parse HEAD", {
        cwd: wsDir,
        encoding: "utf8",
      }).trim();
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "workspace",
        {
          workspacePath: wsDir,
          branchName: "opencontrib/run-test",
          isWorktree: true,
          baseRepoPath: wsDir,
          baseCommitSha,
        },
        "WORKSPACE_PREPARED",
      );

      const testCmd =
        process.platform === "win32"
          ? `powershell -NoProfile -Command "if ((Get-Content '${stateFile.replace(/\\/g, "/")}') -match 'FAIL') { Write-Output ASSERTION_ERR; exit 1 } else { Write-Output PASS; exit 0 }"`
          : `sh -c "if grep -q FAIL ${stateFile}; then echo ASSERTION_ERR; exit 1; else echo PASS; exit 0; fi"`;

      const evidenceService = new EvidenceService(manager);
      evidenceService.captureRed({
        runId: manifest.runId,
        testCommand: testCmd,
        expectedAssertion: "ASSERTION_ERR",
        testFile: "test.txt",
      });

      // Save a patch artifact that claims to have fixed src/fix.ts with content "fixed code"
      manager.saveArtifact(
        manifest.runId,
        "patch",
        JSON.stringify({
          title: "fix",
          summary: "fix",
          rationale: "fix",
          targetFiles: [{ path: "src/fix.ts", reason: "fix" }],
          files: [
            {
              path: "src/fix.ts",
              operation: "CREATE",
              content: "fixed code",
              explanation: "fix",
            },
            {
              path: "test.txt",
              operation: "MODIFY",
              content: "PASS\n",
              explanation: "update regression fixture",
            },
          ],
          implementationSteps: [],
          regressionTestPlan: [],
          estimatedDiffLines: 1,
        }),
        "PATCH_DRAFTED",
      );

      // Now mutate test.txt to PASS, but WITHOUT writing src/fix.ts
      writeFileSync(stateFile, "PASS\n");

      // verifyGreen should throw EvidencePatchProvenanceError because src/fix.ts does not exist in workspace!
      await expect(
        evidenceService.verifyGreen({
          runId: manifest.runId,
          testCommand: testCmd,
        }),
      ).rejects.toThrow(/EvidencePatchProvenanceError/);

      // Now create src/fix.ts with correct content
      mkdirSync(join(wsDir, "src"), { recursive: true });
      writeFileSync(join(wsDir, "src", "fix.ts"), "fixed code");

      // verifyGreen should now succeed and bind appliedPatchSha256
      const report = await evidenceService.verifyGreen({
        runId: manifest.runId,
        testCommand: testCmd,
      });
      expect(report.allTestsPassing).toBe(true);
      expect(report.greenEvidence?.appliedPatchSha256).toBeDefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("EvidenceService.verifyGreen rejects verification when workspace contains unlisted modified/untracked files", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ev-delta-"));
    const wsDir = join(baseDir, "workspace");
    mkdirSync(wsDir, { recursive: true });
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });

      const {
        saveCanonicalArtifact,
      } = require("../src/run/canonical-writer.js");
      const stateFile = join(wsDir, "test.txt");
      writeFileSync(stateFile, "FAIL\n");
      const { execSync } = require("child_process");
      execSync("git init -b main", { cwd: wsDir, stdio: "ignore" });
      execSync(
        "git config user.name Tester && git config user.email test@example.com",
        { cwd: wsDir, stdio: "ignore" },
      );
      execSync("git add test.txt && git commit -m baseline", {
        cwd: wsDir,
        stdio: "ignore",
      });
      const baseCommitSha = execSync("git rev-parse HEAD", {
        cwd: wsDir,
        encoding: "utf8",
      }).trim();
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "workspace",
        {
          workspacePath: wsDir,
          branchName: "opencontrib/run-test",
          isWorktree: true,
          baseRepoPath: wsDir,
          baseCommitSha,
        },
        "WORKSPACE_PREPARED",
      );

      const testCmd =
        process.platform === "win32"
          ? `powershell -NoProfile -Command "if ((Get-Content '${stateFile.replace(/\\/g, "/")}') -match 'FAIL') { Write-Output ASSERTION_ERR; exit 1 } else { Write-Output PASS; exit 0 }"`
          : `sh -c "if grep -q FAIL ${stateFile}; then echo ASSERTION_ERR; exit 1; else echo PASS; exit 0; fi"`;

      const evidenceService = new EvidenceService(manager);
      evidenceService.captureRed({
        runId: manifest.runId,
        testCommand: testCmd,
        expectedAssertion: "ASSERTION_ERR",
        testFile: "test.txt",
      });

      // Patch declares the intended source and regression-fixture changes, but not sneaky.txt.
      mkdirSync(join(wsDir, "src"), { recursive: true });
      writeFileSync(join(wsDir, "src", "fix.ts"), "fixed code");
      manager.saveArtifact(
        manifest.runId,
        "patch",
        JSON.stringify({
          title: "fix",
          summary: "fix",
          rationale: "fix",
          targetFiles: [{ path: "src/fix.ts", reason: "fix" }],
          files: [
            {
              path: "src/fix.ts",
              operation: "CREATE",
              content: "fixed code",
              explanation: "fix",
            },
            {
              path: "test.txt",
              operation: "MODIFY",
              content: "PASS\n",
              explanation: "update regression fixture",
            },
          ],
          implementationSteps: [],
          regressionTestPlan: [],
          estimatedDiffLines: 1,
        }),
        "PATCH_DRAFTED",
      );

      writeFileSync(stateFile, "PASS\n");

      // Now introduce an unlisted extra file in workspace (e.g. stealth untracked code)
      writeFileSync(join(wsDir, "sneaky.txt"), "sneaky untracked content");

      // The workspace is already an initialized Git repository with a committed baseline.

      // verifyGreen must fail because sneaky.txt is not in patch.files!
      await expect(
        evidenceService.verifyGreen({
          runId: manifest.runId,
          testCommand: testCmd,
        }),
      ).rejects.toThrow(
        /EvidencePatchProvenanceError: workspace contains unlisted modified\/untracked file\(s\): sneaky\.txt/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("SubmissionIntentService strictly verifies pr_draft sha256 against audited governance", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-intent-toctou-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });

      seedGovernanceReadyRun(manager, manifest.runId, "audited body");

      // Tamper with pr_draft on disk
      const prDraftPath = join(baseDir, manifest.runId, "pr_draft.md");
      writeFileSync(prDraftPath, "tampered un-audited body");

      const intentService = new SubmissionIntentService(manager);
      expect(() => {
        intentService.createIntent({
          runId: manifest.runId,
          upstreamOwner: "owner",
          upstreamRepo: "repo",
          body: "tampered un-audited body",
        });
      }).toThrow(
        /SubmissionIntentProvenanceError: audited governance prDraftSha256 does not match stored pr_draft/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("SubmissionIntentService rejects baseBranch override that differs from canonical workspace baseBranch", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-intent-basebranch-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });

      seedGovernanceReadyRun(manager, manifest.runId, "pr body");

      const intentService = new SubmissionIntentService(manager);
      // seedGovernanceReadyRun has no baseBranch in workspace, so default is used
      // Let's create a workspace with explicit baseBranch 'develop'
      const {
        saveCanonicalArtifact,
      } = require("../src/run/canonical-writer.js");
      const manifest2 = manager.createRun({ repoFullName: "owner/repo2" });
      const baseCommitSha = "e".repeat(40);
      const patch = {
        title: "fix",
        summary: "fix",
        rationale: "fix",
        targetFiles: [{ path: "src/fix.ts", reason: "fix" }],
        files: [
          {
            path: "src/fix.ts",
            operation: "MODIFY",
            mode: "100644",
            content: "fixed",
            explanation: "fix",
          },
        ],
        implementationSteps: [],
        regressionTestPlan: [],
        estimatedDiffLines: 1,
      };
      const patchContent = JSON.stringify(patch);
      const patchSha256 = createHash("sha256")
        .update(patchContent)
        .digest("hex");
      const validatedPatch = {
        runId: manifest2.runId,
        patchSha256,
        actualDeltaSha256: "f".repeat(64),
        baseCommitSha,
        redTreeSha256: "1".repeat(64),
        greenTreeSha256: "2".repeat(64),
        artifactSha256: "",
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
      validatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(validatedPatch);
      saveCanonicalArtifact(
        manager,
        manifest2.runId,
        "workspace",
        {
          workspacePath: "/tmp",
          branchName: "branch2",
          baseBranch: "develop",
          baseCommitSha,
        },
        "WORKSPACE_PREPARED",
      );
      manager.saveArtifact(
        manifest2.runId,
        "patch",
        patchContent,
        "PATCH_DRAFTED",
      );
      saveCanonicalArtifact(
        manager,
        manifest2.runId,
        "validated_patch",
        validatedPatch,
      );
      const testIdentity = {
        normalizedCommand: "bun test regression.test.ts",
        testFiles: [{ path: "regression.test.ts", sha256: "same" }],
        identitySha256: "identity-same",
      };
      saveCanonicalArtifact(
        manager,
        manifest2.runId,
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
            sourceTreeSha256: "1".repeat(64),
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
            sourceTreeSha256: "2".repeat(64),
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
      manager.saveArtifact(manifest2.runId, "pr_draft", "body2");
      new GovernanceService(manager).audit(manifest2.runId, {
        prTitle: "fix: bug",
        prBody: "body2",
        subagentScore: 100,
      });

      // Calling createIntent with baseBranch 'main' must fail because workspace was prepared on 'develop'
      expect(() => {
        intentService.createIntent({
          runId: manifest2.runId,
          upstreamOwner: "owner",
          upstreamRepo: "repo2",
          baseBranch: "main",
        });
      }).toThrow(
        /SubmissionBaseBranchMismatchError: requested baseBranch 'main' does not match canonical workspace baseBranch 'develop'/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("GitHubSubmissionService throws BaseBranchAdvancedError if upstream base ref advanced beyond baseCommitSha", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-sub-base-sha-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      const {
        saveCanonicalArtifact,
      } = require("../src/run/canonical-writer.js");
      const baseCommitSha = "a".repeat(40);
      const patch = {
        title: "fix",
        summary: "fix",
        rationale: "fix",
        targetFiles: [{ path: "src/fix.ts", reason: "fix" }],
        files: [
          {
            path: "src/fix.ts",
            operation: "MODIFY",
            mode: "100644",
            content: "fixed",
            explanation: "fix",
          },
        ],
        implementationSteps: [],
        regressionTestPlan: [],
        estimatedDiffLines: 1,
      };
      const patchContent = JSON.stringify(patch);
      const patchSha256 = createHash("sha256")
        .update(patchContent)
        .digest("hex");
      const validatedPatch = {
        runId: manifest.runId,
        patchSha256,
        actualDeltaSha256: "b".repeat(64),
        baseCommitSha,
        redTreeSha256: "c".repeat(64),
        greenTreeSha256: "d".repeat(64),
        artifactSha256: "",
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
      validatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(validatedPatch);
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "workspace",
        {
          workspacePath: "/tmp",
          branchName: "opencontrib/run-1",
          baseBranch: "main",
          baseCommitSha,
        },
        "WORKSPACE_PREPARED",
      );
      manager.saveArtifact(
        manifest.runId,
        "patch",
        patchContent,
        "PATCH_DRAFTED",
      );
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "validated_patch",
        validatedPatch,
      );

      const testIdentity = {
        normalizedCommand: "bun test",
        testFiles: [{ path: "test.ts", sha256: "same" }],
        identitySha256: "identity-same",
      };
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "evidence",
        {
          baselineTestedAt: "2026-01-01T00:00:00.000Z",
          reproductionVerified: true,
          allTestsPassing: true,
          redEvidence: {
            command: "test",
            observedOutputSnippet: "",
            exitCode: 1,
            sourceTreeSha256: "c".repeat(64),
            capturedAt: "2026-01-01T00:00:00.000Z",
            assertionMatched: true,
            assertionMatchedFingerprint: "fp",
            testIdentity,
          },
          greenEvidence: {
            command: "test",
            exitCode: 0,
            outputSnippet: "",
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

      manager.saveArtifact(manifest.runId, "pr_draft", "pr body");
      new GovernanceService(manager).audit(manifest.runId, {
        prTitle: "fix: bug",
        prBody: "pr body",
        subagentScore: 100,
      });

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
      approvalService.recordApproval({
        runId: manifest.runId,
        expectedIntentSha256: intent.intentSha256,
      });

      // Mock GitHubClient where upstream main has advanced to 'new_remote_head_67890'
      const mockOctokit = {
        rest: {
          git: {
            getRef: async () => ({
              data: {
                object: {
                  sha: "b".repeat(40),
                },
              },
            }),
          },
          pulls: {
            get: async () => ({
              data: { head: { sha: "commit_sha" } },
            }),
          },
        },
      };

      const mockClient = { octokit: mockOctokit } as unknown as GitHubClient;
      const mockPrService = {
        submitPullRequest: async () => {
          throw new Error("Should not be reached");
        },
      } as unknown as ContributionPrService;

      const submissionService = new GitHubSubmissionService(
        mockPrService,
        mockClient,
        manager,
      );

      await expect(submissionService.submit(manifest.runId)).rejects.toThrow(
        /BaseBranchAdvancedError: Upstream base branch "main" has advanced/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
