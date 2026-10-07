import { describe, expect, it } from "bun:test";
import { execFileSync } from "child_process";
import { createHash, generateKeyPairSync } from "crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import {
  ApprovalService,
  GitHubSubmissionService,
  GitHubClient,
  ContributionRunManager,
  SubmissionIntentService,
  validatePhaseGate,
  TrustedApprovalBroker,
  Ed25519ApprovalSigner,
  Ed25519ApprovalVerifier,
  InMemoryApprovalBrokerStore,
} from "../src/index.js";
import { ContributionPrService } from "../src/github/contribution-pr-service.js";
import { createTrustedApprovalAuthority } from "../src/governance/approval-authority.js";
import {
  EvidenceService,
  getValidatedPatchUnifiedDiffAtGreenTree,
} from "../src/evidence/evidence-service.js";
import { GovernanceService } from "../src/governance/governance-service.js";
import { auditGovernance } from "../src/domain/governance.js";
import { computeSourceTreeHash } from "../src/evidence/evidence-collector.js";
import { hashValidatedPatchArtifact } from "../src/evidence/validated-patch.js";
import { hashTrustedPolicySnapshot } from "../src/kernel/config.js";
import { SubmissionArtifactSchema } from "../src/contracts/schemas.js";
import { IssueBindingService } from "../src/github/issue-binding-service.js";
import { SecurityDisclosureService } from "../src/github/security-disclosure-service.js";
import { TrustedRunMaterializer } from "../src/run/trusted-run-host.js";
import { RunTransferBundleSchema } from "../src/run/run-transfer.js";
import { runBranchName } from "../src/run/run-branch.js";
import { ActiveSessionManager } from "../src/run/active-session.js";
import type { PatchDraft } from "../src/contracts/llm-schemas.js";
import { stateAssertionCommand } from "./helpers/bun-command.js";
import {
  hashCommunityGateSnapshot,
  type CommunityGatePolicy,
} from "../src/governance/community-gate.js";

function isolatedRunManager(baseDir: string): ContributionRunManager {
  return new ContributionRunManager({
    baseDir,
    activeSession: new ActiveSessionManager(
      join(baseDir, "active_session.json"),
    ),
  });
}

const testApprovalAuthority = (
  approvalMode:
    | "explicit_human"
    | "policy_waived"
    | "maintainer_evidence" = "explicit_human",
) =>
  createTrustedApprovalAuthority({
    issueApproval: () => ({
      approvedBy: "test-authority",
      approvalMode,
      maintainerGateEvidence:
        approvalMode === "maintainer_evidence"
          ? {
              actorAssociation: "MEMBER" as const,
              providerEventId: "review-1",
              providerVerified: true as const,
              reviewState: "APPROVED" as const,
              reviewerLogin: "maintainer",
              reviewerType: "User" as const,
            }
          : undefined,
      signingKeyId: "test-key",
      signature: "test-signature",
    }),
    verifyApproval: (artifact) =>
      artifact.signingKeyId === "test-key" &&
      artifact.signature === "test-signature",
    verifyMaintainerEvidence: (evidence) => evidence.providerVerified === true,
  });

describe("Submission route artifact schema", () => {
  it("rejects legacy submissions and route-unbound submissions", () => {
    const legacySubmission = {
      runId: "run-legacy",
      provider: "github",
      owner: "org",
      repo: "repo",
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
      branchName: "opencontrib/run-legacy",
      intentSha256: "b".repeat(64),
      patchSha256: "c".repeat(64),
      evidenceSha256: "d".repeat(64),
      governanceSha256: "e".repeat(64),
      policySha256: "f".repeat(64),
      communityGateSha256: "1".repeat(64),
      prNumber: 1,
      prUrl: "https://github.com/org/repo/pull/1",
      headSha: "2".repeat(40),
      submittedAt: "2026-01-01T00:00:00.000Z",
      verified: true,
    };
    expect(SubmissionArtifactSchema.safeParse(legacySubmission).success).toBe(
      false,
    );
    expect(
      SubmissionArtifactSchema.safeParse({
        ...legacySubmission,
        submissionRoute: "PUBLIC_ISSUE",
      }).success,
    ).toBe(false);
  });
});

const fixturePolicySnapshot = {
  coverage: {
    required: false,
    minimumChangedLineCoverage: 0,
  },
  resourceLeakCheck: { required: false },
} as const;
const fixturePolicySha256 = hashTrustedPolicySnapshot(fixturePolicySnapshot);

function fixtureCommunityGate(
  sourceCommitSha: string,
  overrides: Partial<CommunityGatePolicy> = {},
) {
  const communityGate = {
    sourceCommitSha,
    policy: {
      hasGatingRules: false,
      requiresIssueApprovalBeforePr: false,
      autoClosesNewIssues: false,
      hasLgtmApprovalProtocol: false,
      restrictedTriageHours: false,
      reasons: ["fixture policy"],
      suggestedContributorAction: "Proceed with the canonical protocol.",
      matchedKeywords: [],
      ...overrides,
    },
  };
  return {
    communityGate,
    communityGateSha256: hashCommunityGateSnapshot(communityGate),
  };
}

function seedIssueBinding(
  manager: ContributionRunManager,
  runId: string,
  repoFullName = "org/repo",
  providerIssueId = 42,
): void {
  saveCanonicalArtifact(manager, runId, "issue_binding", {
    runId,
    provider: "github",
    repoFullName,
    providerIssueId,
    state: "open",
    title: "Fix the verified fixture issue",
    issueUrl: `https://github.com/${repoFullName}/issues/${providerIssueId}`,
    providerVerified: true,
    verifiedAt: "2026-01-01T00:00:00.000Z",
  });
}

function writeGreenFileAfterBaseCommit(
  workspacePath: string,
  content: string,
  relativePath = "src/fix.ts",
  baseContent: string | null = "const before = true;\n",
): string {
  const sourcePath = join(workspacePath, relativePath);
  mkdirSync(dirname(sourcePath), { recursive: true });
  if (baseContent !== null) writeFileSync(sourcePath, baseContent);
  const hooksPath = join(workspacePath, ".opencontrib-test-hooks");
  mkdirSync(hooksPath, { recursive: true });
  execFileSync("git", ["init", "--quiet"], {
    cwd: workspacePath,
    stdio: "ignore",
    timeout: 10_000,
  });
  execFileSync("git", ["add", "--all"], {
    cwd: workspacePath,
    stdio: "ignore",
    timeout: 10_000,
  });
  execFileSync("git", [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=OpenContrib Test",
    "-c",
    "commit.gpgsign=false",
    "-c",
    "commit.template=",
    "-c",
    `core.hooksPath=${hooksPath}`,
    "commit",
    "--quiet",
    "--allow-empty",
    "--no-verify",
    "--no-gpg-sign",
    "-m",
    "base",
  ], {
    cwd: workspacePath,
    stdio: "ignore",
    timeout: 10_000,
  });
  const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: workspacePath,
    encoding: "utf8",
    timeout: 10_000,
  }).trim();
  writeFileSync(sourcePath, content);
  return baseCommitSha;
}

function seedGovernanceReadyRun(
  manager: ContributionRunManager,
  runId: string,
  workspacePath: string,
  body = "pr body",
  communityPolicy: Partial<CommunityGatePolicy> = {},
  options: {
    baseCommitSha?: string;
    patchPath?: string;
    patchContent?: string;
    patchDraft?: PatchDraft;
    changedLines?: number;
    baseContent?: string;
    providerIssueId?: number;
    additionalBaseSourceFiles?: Array<{ path: string; content: string }>;
  } = {},
) {
  mkdirSync(workspacePath, { recursive: true });
  const canonicalRepoFullName = manager.getRun(runId)?.manifest.repoFullName;
  if (!canonicalRepoFullName) {
    throw new Error(`Fixture run ${runId} has no canonical repository binding.`);
  }
  const patchPath = options.patchPath ?? options.patchDraft?.files[0]?.path ?? "src/fix.ts";
  const patch: PatchDraft = options.patchDraft ?? {
    title: "fix: bug",
    summary: "fix",
    rationale: "reproduce and correct the defect",
    targetFiles: [{ path: patchPath, reason: "correct defect" }],
    files: [
      {
        path: patchPath,
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
  const patchFile = patch.files.find((file) => file.path === patchPath);
  if (!patchFile) throw new Error(`Fixture patch has no file at '${patchPath}'.`);
  if (patchFile.operation === "DELETE" && options.baseContent === undefined) {
    throw new Error(
      `DELETE fixture '${patchPath}' must provide its actual baseContent.`,
    );
  }
  const patchContent = options.patchContent ?? JSON.stringify(patch);
  const baseCommitSha =
    options.baseCommitSha ??
    (options.patchContent
      ? "a".repeat(40)
      : writeGreenFileAfterBaseCommit(
          workspacePath,
          patchFile.content,
          patchPath,
          options.baseContent ??
            (patchFile.operation === "CREATE"
              ? null
              : "const before = true;\n"),
        ));
  const greenFilePath = join(workspacePath, patchPath);
  if (patchFile.operation === "DELETE") {
    rmSync(greenFilePath, { force: true });
  } else {
    mkdirSync(dirname(greenFilePath), { recursive: true });
    writeFileSync(greenFilePath, patchFile.content);
  }
  const greenTreeSha256 = computeSourceTreeHash(workspacePath);
  const patchSha256 = createHash("sha256").update(patchContent).digest("hex");
  const validatedPatch = {
    runId,
    patchSha256,
    actualDeltaSha256: "b".repeat(64),
    baseCommitSha,
    redTreeSha256: "c".repeat(64),
    greenTreeSha256,
    artifactSha256: "",
    changedLines: options.changedLines ?? 0,
    files: [
      {
        path: patchPath,
        operation: patchFile.operation,
        mode: patchFile.mode,
        contentSha256: createHash("sha256").update(patchFile.content).digest("hex"),
        ...(options.changedLines === undefined
          ? {}
          : { changedLines: options.changedLines }),
      },
      ...(options.additionalBaseSourceFiles ?? []).map((file) => ({
        path: file.path,
        operation: "MODIFY" as const,
        mode: "100644" as const,
        contentSha256: createHash("sha256").update(file.content).digest("hex"),
      })),
    ],
    validatedAt: "2026-01-01T00:01:00.000Z",
  };
  validatedPatch.artifactSha256 = hashValidatedPatchArtifact(validatedPatch);
  saveCanonicalArtifact(
    manager,
    runId,
    "workspace",
    {
      workspacePath,
      branchName: runBranchName(runId),
      baseRepoPath: workspacePath,
      baseBranch: "main",
      baseCommitSha,
      isWorktree: false,
      repoFullName: canonicalRepoFullName,
      policySnapshot: fixturePolicySnapshot,
      policySha256: fixturePolicySha256,
      ...fixtureCommunityGate(baseCommitSha, communityPolicy),
    },
    "WORKSPACE_PREPARED",
  );
  if (communityPolicy.privateVulnerabilityDisclosure !== true) {
    seedIssueBinding(
      manager,
      runId,
      canonicalRepoFullName,
      options.providerIssueId ?? 42,
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
  manager.saveArtifact(runId, "patch", patchContent);
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
      roundsRequested: 1,
      roundsCompleted: 1,
      workersPerRound: 1,
      executionsExpected: 1,
      stressLoopPassed: true,
      executionCount: 1,
      maxConcurrentObserved: 1,
      concurrencyWorkers: 1,
      concurrencyStampedePassed: true,
      handleLeakCheckPassed: "PASS",
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
        sourceTreeSha256: greenTreeSha256,
        capturedAt: "2026-01-01T00:01:00.000Z",
        treeChangedComparedToRed: true,
        treeHashMatchesRed: false,
        appliedPatchSha256: patchSha256,
        validatedPatchArtifactSha256: validatedPatch.artifactSha256,
        stressLoopPassed: true,
        roundsRequested: 1,
        roundsCompleted: 1,
        workersPerRound: 1,
        executionsExpected: 1,
        executionCount: 1,
        allTestsPassing: true,
        assertionMatchedFingerprint: "fp",
        testIdentity,
      },
    },
    "EVIDENCE_COLLECTED",
  );

  manager.saveArtifact(runId, "pr_draft", body);
  const audit = new GovernanceService(manager).audit(runId, {
    prTitle: "fix: bug",
    prBody: body,
    subagentScore: 100,
    preflightLintResult: {
      executed: true,
      passed: true,
      exitCode: 0,
      rawOutput: "",
      violationCount: 0,
      violations: [],
      summary: "Fixture lint check passed.",
    },
  });
  return audit;
}

describe("Validated base-to-GREEN governance diffs", () => {
  it("keeps the real removed content for delete diffs", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-validated-delete-diff-"));
    const workspacePath = join(baseDir, "repo");
    const relativePath = "src/remove.ts";
    const baseContent = 'if (repository === "org/repo") return old();\n';
    try {
      const baseCommitSha = writeGreenFileAfterBaseCommit(
        workspacePath,
        "",
        relativePath,
        baseContent,
      );
      rmSync(join(workspacePath, relativePath));
      const diff = getValidatedPatchUnifiedDiffAtGreenTree(
        workspacePath,
        baseCommitSha,
        [
          {
            path: relativePath,
            operation: "DELETE",
            mode: "100644",
            contentSha256: createHash("sha256").update("").digest("hex"),
          },
        ],
        computeSourceTreeHash(workspacePath),
      );

      expect(diff).toContain('-if (repository === "org/repo") return old();');
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("reads validated diffs larger than Node's default child-process buffer", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-validated-large-diff-"));
    const workspacePath = join(baseDir, "repo");
    const relativePath = "src/large.ts";
    const content = `export const large = "${"x".repeat(1_100_000)}";\n`;
    try {
      const baseCommitSha = writeGreenFileAfterBaseCommit(
        workspacePath,
        content,
        relativePath,
        "export const large = \"before\";\n",
      );
      const diff = getValidatedPatchUnifiedDiffAtGreenTree(
        workspacePath,
        baseCommitSha,
        [
          {
            path: relativePath,
            operation: "MODIFY",
            mode: "100644",
            contentSha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
        computeSourceTreeHash(workspacePath),
      );

      expect(diff.length).toBeGreaterThan(1_048_576);
      expect(diff).toContain("x".repeat(128));
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  if (process.platform !== "win32") {
    it("passes filenames with Git pathspec magic as literal paths", () => {
      const baseDir = mkdtempSync(join(tmpdir(), "oc-validated-literal-path-"));
      const workspacePath = join(baseDir, "repo");
      const relativePath = ":(glob)nope.ts";
      const content = "export const after = true;\n";
      try {
        const baseCommitSha = writeGreenFileAfterBaseCommit(
          workspacePath,
          content,
          relativePath,
          "export const before = true;\n",
        );
        const diff = getValidatedPatchUnifiedDiffAtGreenTree(
          workspacePath,
          baseCommitSha,
          [
            {
              path: relativePath,
              operation: "MODIFY",
              mode: "100644",
              contentSha256: createHash("sha256").update(content).digest("hex"),
            },
          ],
          computeSourceTreeHash(workspacePath),
        );

        expect(diff).toContain("+export const after = true;");
      } finally {
        rmSync(baseDir, { recursive: true, force: true });
      }
    });
  }
});

describe("Governance base source context limits", () => {
  it("fails closed when selected base source contents exceed the cumulative limit", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-governance-source-budget-"));
    const workspacePath = join(baseDir, "repo");
    const sourceContent = "x".repeat(33 * 1024 * 1024);
    const sourceFiles = [
      { path: "src/large-a.ts", content: sourceContent },
      { path: "src/large-b.ts", content: sourceContent },
    ];
    try {
      for (const sourceFile of sourceFiles) {
        const sourcePath = join(workspacePath, sourceFile.path);
        mkdirSync(dirname(sourcePath), { recursive: true });
        writeFileSync(sourcePath, sourceFile.content);
      }
      const baseCommitSha = writeGreenFileAfterBaseCommit(
        workspacePath,
        "const after = true;\n",
        "src/fix.ts",
        "const before = true;\n",
      );
      const manager = isolatedRunManager(join(baseDir, "runs"));
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      expect(() =>
        seedGovernanceReadyRun(
          manager,
          manifest.runId,
          workspacePath,
          "pr body",
          {},
          {
            baseCommitSha,
            patchPath: "src/fix.ts",
            patchContent: "non-canonical fixture patch",
            additionalBaseSourceFiles: sourceFiles,
          },
        ),
      ).toThrow(/GovernanceBaseContentUnavailableError:.*aggregate safe read limit/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("Governance audit impact context", () => {
  it("does not report hazards that appear only in removed diff lines", () => {
    const audit = auditGovernance({
      diffText: [
        "diff --git a/internal/tool/code_search.go b/internal/tool/code_search.go",
        "--- a/internal/tool/code_search.go",
        "+++ b/internal/tool/code_search.go",
        "@@ -1 +1 @@",
        '-if (repository === "org/repo") return special;',
        "+normalized := filepath.FromSlash(input)",
      ].join("\n"),
      patchContent: JSON.stringify({
        files: [
          {
            path: "internal/tool/code_search.go",
            content: "normalized := filepath.FromSlash(input)",
          },
        ],
      }),
      modifiedFiles: ["internal/tool/code_search.go"],
      lineCount: 1,
      coreDiffLines: 1,
    });

    expect(audit.antiHardcodePassed).toBe(true);
    expect(audit.impactAnalysisPassed).toBe(true);
  });

  it("analyzes the validated diff instead of unchanged PatchDraft content", () => {
    const audit = auditGovernance({
      diffText: [
        "diff --git a/internal/tool/code_search.go b/internal/tool/code_search.go",
        "--- a/internal/tool/code_search.go",
        "+++ b/internal/tool/code_search.go",
        "@@ -4,0 +4,1 @@",
        "+normalized := filepath.FromSlash(input)",
      ].join("\n"),
      patchContent: JSON.stringify({
        files: [
          {
            path: "internal/tool/code_search.go",
            content:
              "legacy := filepath.ToSlash(input)\nnormalized := filepath.FromSlash(input)",
          },
        ],
      }),
      modifiedFiles: ["internal/tool/code_search.go"],
      lineCount: 1,
      coreDiffLines: 1,
    });

    expect(audit.impactAnalysisPassed).toBe(true);
  });

  it("checks hardcoded repository branches in canonical PatchDraft files", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-governance-patch-draft-hardcode-"));
    try {
      const repoPath = join(baseDir, "repo");
      const sourcePath = join(repoPath, "src", "fix.ts");
      const baseSource = [
        "export function route(repo: string) {",
        "  return repo;",
        "}",
        "",
      ].join("\n");
      const greenSource = [
        "export function route(repo: string) {",
        '  if (repo === "org/repo") return "special";',
        "  return repo;",
        "}",
        "",
      ].join("\n");

      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(sourcePath, baseSource);
      execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "OpenContrib Test"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "src/fix.ts"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "base"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
        encoding: "utf8",
      }).trim();

      writeFileSync(sourcePath, greenSource);
      const patchDraft: PatchDraft = {
        title: "fix: generalize route behavior",
        summary: "Handle routes without repository-specific behavior.",
        rationale: "Use the normal behavior for every repository.",
        targetFiles: [{ path: "src/fix.ts", reason: "Correct route behavior." }],
        files: [
          {
            path: "src/fix.ts",
            operation: "MODIFY",
            mode: "100644",
            content: greenSource,
            explanation: "Update route behavior.",
          },
        ],
        implementationSteps: ["Update route handling."],
        regressionTestPlan: ["Exercise repository-agnostic route behavior."],
        estimatedDiffLines: 3,
      };
      const manager = isolatedRunManager(join(baseDir, "runs"));
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      const decision = seedGovernanceReadyRun(
        manager,
        manifest.runId,
        repoPath,
        "pr body",
        {},
        {
          baseCommitSha,
          patchPath: "src/fix.ts",
          patchDraft,
          changedLines: 3,
        },
      );

      expect(decision.auditResult.antiHardcodePassed).toBe(false);
      expect(
        decision.auditResult.flaggedHardcodeIssues.some((issue: string) =>
          issue.includes("REPO_LITERAL_DISCRIMINATION"),
        ),
      ).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("passes canonical run issue metadata into the anti-hardcode gate", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-governance-issue-hardcode-"));
    try {
      const repoPath = join(baseDir, "repo");
      const manager = isolatedRunManager(join(baseDir, "runs"));
      const manifest = manager.createRun({
        repoFullName: "org/repo",
        issueNumber: 1614,
      });
      const patchContent = `
diff --git a/src/fix.ts b/src/fix.ts
--- a/src/fix.ts
+++ b/src/fix.ts
@@ -1,0 +1,1 @@
+if (issueNumber === 1614) return workaround();
`;

      const decision = seedGovernanceReadyRun(
        manager,
        manifest.runId,
        repoPath,
        "pr body",
        {},
        { patchContent, providerIssueId: 1614 },
      );

      expect(decision.auditResult.antiHardcodePassed).toBe(false);
      expect(
        decision.auditResult.flaggedHardcodeIssues.some((issue: string) =>
          issue.includes("issue #1614"),
        ),
      ).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("does not infer an issue-specific workaround from the manifest issue number alone", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-governance-issue-hardcode-mismatch-"));
    try {
      const repoPath = join(baseDir, "repo");
      const manager = isolatedRunManager(join(baseDir, "runs"));
      const manifest = manager.createRun({
        repoFullName: "org/repo",
        issueNumber: 1614,
      });
      const patchContent = `
diff --git a/src/fix.ts b/src/fix.ts
--- a/src/fix.ts
+++ b/src/fix.ts
@@ -1,0 +1,1 @@
+if (issueNumber === 1614) return workaround();
`;

      const decision = seedGovernanceReadyRun(
        manager,
        manifest.runId,
        repoPath,
        "pr body",
        {},
        { patchContent },
      );

      expect(decision.auditResult.antiHardcodePassed).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it.each(["vue", "svelte"])("seeds %s component comments from the canonical base", extension => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-component-base-"));
    try {
      const workspace = join(baseDir, "repo");
      const manager = isolatedRunManager(join(baseDir, "runs"));
      const run = manager.createRun({ repoFullName: "org/repo" });
      const path = `src/App.${extension}`;
      const baseContent = ["<template>", "<!--", ...Array.from({ length: 30 }, (_, i) => `Documentation line ${i}`), "-->", "</template>", ""].join("\n");
      const greenSource = baseContent.replace("Documentation line 15", 'Documentation line 15\nif (repo === "owner/repo") return example();');
      const patchDraft: PatchDraft = {
        title: "docs: explain component behavior", summary: "Add an inert comment example.",
        rationale: "Document the existing component.", targetFiles: [{ path, reason: "Document behavior." }],
        files: [{ path, operation: "MODIFY", mode: "100644", content: greenSource, explanation: "Extend the existing HTML comment." }],
        implementationSteps: ["Extend the comment."], regressionTestPlan: ["Verify base comment state."], estimatedDiffLines: 1,
      };
      const decision = seedGovernanceReadyRun(manager, run.runId, workspace, "pr body", {}, {
        patchPath: path, patchDraft, baseContent, changedLines: 1,
      });
      expect(decision.auditResult.antiHardcodePassed).toBe(true);
      expect(decision.auditResult.flaggedHardcodeIssues).toEqual([]);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("passes validated patch paths and the base tree into sibling-file analysis", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-governance-impact-"));
    const repoPath = join(baseDir, "repo");
    try {
      mkdirSync(join(repoPath, "src"), { recursive: true });
      writeFileSync(join(repoPath, "src", "parser.ts"), "export const parser = 1;\n");
      writeFileSync(join(repoPath, "src", "hunk.ts"), "export type Hunk = {};\n");
      writeFileSync(join(repoPath, "src", "types.ts"), "export type Node = {};\n");
      execFileSync("git", ["init"], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "OpenContrib Test"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "baseline"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repoPath,
        encoding: "utf8",
      }).trim();

      const manager = isolatedRunManager(join(baseDir, "runs"));
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      const audit = seedGovernanceReadyRun(
        manager,
        manifest.runId,
        repoPath,
        "pr body",
        {},
        { baseCommitSha, patchPath: "src/parser.ts" },
      );

      const impactIssues = audit.auditResult.impactAnalysisIssues ?? [];
      expect(
        impactIssues.some((issue: string) => issue.includes("'src/hunk.ts'")),
      ).toBe(true);
      expect(
        impactIssues.some((issue: string) => issue.includes("'src/types.ts'")),
      ).toBe(true);
      expect(impactIssues.every((issue: string) => !issue.includes("\0"))).toBe(
        true,
      );
      expect(audit.auditResult.impactAnalysisPassed).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("Trusted private security materialization", () => {
  function makeTransferBundle(
    runId: string,
    repoFullName: string,
    issueNumber?: number,
    prDraft = "Private security contribution details.",
  ) {
    return RunTransferBundleSchema.parse({
      protocolVersion: "1.0",
      manifest: {
        schemaVersion: "1.0",
        runId,
        repoFullName,
        issueNumber,
        createdAt: new Date(0).toISOString(),
      },
      patch: JSON.stringify({
        files: [{ path: "src/fix.ts", content: "fixed" }],
      }),
      prDraft,
      redRecipe: {
        command: "bun test regression.test.ts",
        expectedAssertion: "REGRESSION_FAIL",
        testFiles: ["regression.test.ts"],
      },
    });
  }

  function makeSecurityProvider(
    getStage: () => "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED",
    shouldRateLimit?: () => boolean,
  ) {
    return {
      getRepoTextFile: async (_owner: string, _repo: string, path: string) =>
        path === "SECURITY.md"
          ? "Report vulnerabilities privately through the security channel. Do not open a public issue."
          : null,
      getDisclosureStatus: async () => {
        if (shouldRateLimit?.()) {
          return { status: "RATE_LIMITED" as const, data: null as never };
        }
        const stage = getStage();
        return {
          status: "OK" as const,
          data: {
            stage,
            providerEventId: `provider-event-${stage}`,
            publicDisclosureAllowed: stage === "PUBLIC_FIX_AUTHORIZED",
          },
        };
      },
    };
  }

  it("preserves typed statuses from rejected provider lookups", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-provider-status-"));
    try {
      const manager = isolatedRunManager(baseDir);
      const manifest = manager.createRun({ repoFullName: "owner/private-repo" });
      const publicRun = manager.createRun({ repoFullName: "owner/private-repo" });
      const publicPolicy = fixtureCommunityGate("a".repeat(40), {
        privateVulnerabilityDisclosure: false,
      });
      saveCanonicalArtifact(manager, publicRun.runId, "workspace", {
        baseCommitSha: "a".repeat(40),
        ...publicPolicy,
      });
      const rateLimitError = Object.assign(new Error("rate limited"), {
        status: 429,
      });
      const issueBinding = new IssueBindingService(manager, {
        getIssue: async () => {
          throw rateLimitError;
        },
      });
      await expect(
        issueBinding.bind({
          runId: publicRun.runId,
          repoFullName: "owner/private-repo",
          issueNumber: 42,
        }),
      ).rejects.toMatchObject({ status: "RATE_LIMITED", retryable: true });

      const policyLookup = new SecurityDisclosureService(manager, {
        getRepoTextFile: async () => null,
        getRepoTextFileResult: async () => ({
          status: "RATE_LIMITED",
          data: null,
        }),
      });
      await expect(
        policyLookup.verifyPrivateChannel({
          runId: manifest.runId,
          repoFullName: "owner/private-repo",
        }),
      ).rejects.toThrow(/RATE_LIMITED/);

      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "Private fix.",
        { privateVulnerabilityDisclosure: true },
      );
      const policyPaths: string[] = [];
      const legacyPolicyLookup = new SecurityDisclosureService(manager, {
        getRepoTextFile: async (_owner, _repo, path) => {
          policyPaths.push(path);
          if (path === "SECURITY.md") {
            throw Object.assign(new Error("policy file not found"), {
              status: 404,
            });
          }
          return "Report vulnerabilities privately through the security channel.";
        },
      });
      await legacyPolicyLookup.verifyPrivateChannel({
        runId: manifest.runId,
        repoFullName: "owner/private-repo",
      });
      expect(policyPaths).toEqual(["SECURITY.md", ".github/SECURITY.md"]);

      const forbiddenError = Object.assign(new Error("forbidden"), {
        status: 403,
      });
      const securityDisclosure = new SecurityDisclosureService(manager, {
        getRepoTextFile: async () =>
          "Report vulnerabilities privately through the security channel.",
        getDisclosureStatus: async () => {
          throw forbiddenError;
        },
      });
      await expect(
        securityDisclosure.syncLifecycle({
          runId: manifest.runId,
          repoFullName: "owner/private-repo",
        }),
      ).rejects.toMatchObject({ status: "FORBIDDEN", retryable: false });
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("binds reused private intents to the canonical pr_draft", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-private-intent-draft-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/private-repo" });
      const body = "Private security contribution details.";
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        body,
        { privateVulnerabilityDisclosure: true },
      );

      let stage: "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED" =
        "DISCLOSED";
      const disclosureService = new SecurityDisclosureService(
        manager,
        makeSecurityProvider(() => stage),
      );
      const disclosureInput = {
        runId: manifest.runId,
        repoFullName: "owner/private-repo",
      };
      await disclosureService.verifyPrivateChannel(disclosureInput);
      for (const nextStage of [
        "DISCLOSED",
        "ACKNOWLEDGED",
        "PUBLIC_FIX_AUTHORIZED",
      ] as const) {
        stage = nextStage;
        await disclosureService.syncLifecycle(disclosureInput);
      }

      const intentService = new SubmissionIntentService(manager);
      const intentInput = {
        runId: manifest.runId,
        upstreamOwner: "owner",
        upstreamRepo: "private-repo",
      };
      expect(intentService.createIntent(intentInput).body).toBe(body);

      const prDraftPath = join(baseDir, manifest.runId, "pr_draft.md");
      writeFileSync(prDraftPath, "Different private draft.");
      expect(() => intentService.createIntent(intentInput)).toThrow(
        /existing private intent body is not bound to the canonical pr_draft/,
      );

      writeFileSync(prDraftPath, "Fixes #42");
      expect(() => intentService.createIntent(intentInput)).toThrow(
        /PrivateSecurityIssueReferenceError/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("waits for the complete provider lifecycle before creating a private intent", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-private-materializer-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({
        repoFullName: "owner/private-repo",
      });
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "Private security fix.",
        { privateVulnerabilityDisclosure: true },
      );

      let stage: "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED" =
        "DISCLOSED";
      let failFirstLookup = true;
      const provider = makeSecurityProvider(
        () => stage,
        () => {
          if (!failFirstLookup) return false;
          failFirstLookup = false;
          return true;
        },
      );
      const materializer = new TrustedRunMaterializer(
        manager,
        undefined,
        undefined,
        undefined,
        undefined,
        provider,
      );
      const bundle = makeTransferBundle(manifest.runId, "owner/private-repo");

      await expect(materializer.materialize(bundle)).rejects.toThrow(
        /RATE_LIMITED/,
      );
      const retryableRun = manager.getRun(manifest.runId);
      expect(retryableRun?.manifest.currentPhase).toBe("GOVERNANCE_AUDITED");
      expect(retryableRun?.artifacts.submissionIntent).toBeUndefined();

      for (const pendingStage of ["DISCLOSED", "ACKNOWLEDGED"] as const) {
        stage = pendingStage;
        await expect(materializer.materialize(bundle)).rejects.toThrow(
          /PublicDisclosureBlockedError/,
        );
        const pendingRun = manager.getRun(manifest.runId);
        expect(pendingRun?.manifest.currentPhase).toBe("GOVERNANCE_AUDITED");
        expect(pendingRun?.artifacts.submissionIntent).toBeUndefined();
        expect(pendingRun?.artifacts.issueBinding).toBeUndefined();
      }

      stage = "PUBLIC_FIX_AUTHORIZED";
      const finalized = await materializer.materialize(bundle);
      const intent = finalized.artifacts.submissionIntent as
        | { submissionRoute?: string }
        | undefined;
      expect(intent?.submissionRoute).toBe("PRIVATE_SECURITY");
      expect(finalized.artifacts.securityDisclosureEvents).toHaveLength(3);
      expect(finalized.artifacts.issueBinding).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("rejects public Issue identity on a private transfer", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-private-issue-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({
        repoFullName: "owner/private-repo",
        issueNumber: 73,
      });
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "Private security fix.",
        { privateVulnerabilityDisclosure: true },
      );
      let providerLookups = 0;
      const provider = makeSecurityProvider(() => {
        providerLookups += 1;
        return "PUBLIC_FIX_AUTHORIZED";
      });
      const materializer = new TrustedRunMaterializer(
        manager,
        undefined,
        undefined,
        undefined,
        undefined,
        provider,
      );

      await expect(
        materializer.materialize(
          makeTransferBundle(manifest.runId, "owner/private-repo", 73),
        ),
      ).rejects.toThrow(/cannot carry a public Issue number/);
      expect(providerLookups).toBe(0);
      expect(
        manager.getRun(manifest.runId)?.artifacts.submissionIntent,
      ).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("requires disclosure authorization and rejects public Issue references in private drafts", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-private-draft-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/private-repo" });
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "Fixes #42",
        { privateVulnerabilityDisclosure: true },
      );
      let stage: "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED" =
        "DISCLOSED";
      const disclosure = new SecurityDisclosureService(
        manager,
        makeSecurityProvider(() => stage),
      );
      await disclosure.verifyPrivateChannel({
        runId: manifest.runId,
        repoFullName: "owner/private-repo",
      });
      const intentService = new SubmissionIntentService(manager);
      const input = {
        runId: manifest.runId,
        upstreamOwner: "owner",
        upstreamRepo: "private-repo",
      };
      expect(() => intentService.createIntent(input)).toThrow(
        /PublicDisclosureBlockedError/,
      );

      for (const nextStage of [
        "DISCLOSED",
        "ACKNOWLEDGED",
        "PUBLIC_FIX_AUTHORIZED",
      ] as const) {
        stage = nextStage;
        await disclosure.syncLifecycle({
          runId: manifest.runId,
          repoFullName: "owner/private-repo",
        });
      }
      expect(() => intentService.createIntent(input)).toThrow(
        /PrivateSecurityIssueReferenceError/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});

describe("Trust Boundary: Approval & Submission Services with Provenance Gates", () => {
  it("rejects generic saves of authoritative artifacts", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-priv-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      expect(() => {
        manager.saveArtifact(manifest.runId, "evidence", { fake: "data" });
      }).toThrow(
        /AuthoritativeArtifactViolationError/,
      );

      expect(() => {
        manager.saveArtifact(manifest.runId, "governance", { fake: "data" });
      }).toThrow(/AuthoritativeArtifactViolationError/);

      expect(() => {
        manager.saveArtifact(manifest.runId, "submission", { fake: "data" });
      }).toThrow(/AuthoritativeArtifactViolationError/);

      expect(() => {
        manager.saveArtifact(manifest.runId, "result", { fake: "data" });
      }).toThrow(/AuthoritativeArtifactViolationError/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("rejects PR draft mutation after governance and preserves the canonical body", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-pr-draft-worm-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      const originalBody = "Original PR Body";

      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        originalBody,
      );

      expect(() => {
        manager.saveArtifact(
          manifest.runId,
          "pr_draft",
          "Malicious Injected PR Body",
        );
      }).toThrow(/ImmutableArtifactViolationError/);

      expect(manager.getRun(manifest.runId)?.artifacts.prDraft).toBe(
        originalBody,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("ApprovalService binds patch & evidence hashes and detects TOCTOU mutations", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-approval-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "body",
      );

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
      const approval = await approvalService.recordApproval({
        runId: manifest.runId,
        expectedIntentSha256: intent.intentSha256,
      });

      expect(approval.runId).toBe(manifest.runId);
      expect(approval.patchSha256).toBeDefined();
      expect(approval.intentSha256).toBe(intent.intentSha256);
      expect(approval.policySha256).toBe(intent.policySha256);
      expect(approval.approvedBy).toBe("test-authority");

      // Verify integrity before mutation
      const check1 = approvalService.verifyApprovalIntegrity(manifest.runId);
      expect(check1.valid).toBe(true);

      // Now mutate the patch through a lower-level artifact tamper (TOCTOU
      // attack). The run manager rejects ordinary post-governance writes, but
      // approval verification must still detect on-disk mutation.
      writeFileSync(
        join(baseDir, manifest.runId, "patch.diff"),
        JSON.stringify({ files: [] }),
        "utf8",
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

  it("TrustedApprovalBroker persists pending challenges and mints signed approvals only after host decision", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-approval-broker-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
      );
      new SubmissionIntentService(manager).createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "pr body",
      });

      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const verifier = new Ed25519ApprovalVerifier("test-ed25519", publicKey);
      const broker = new TrustedApprovalBroker(
        manager,
        new Ed25519ApprovalSigner("test-ed25519", privateKey),
        verifier,
        new InMemoryApprovalBrokerStore(),
      );

      const request = broker.request(manifest.runId);
      expect(request.status).toBe("PENDING");
      expect(request.requestId).toMatch(/^approval_[a-f0-9]{64}$/);

      const approval = await broker.approve(request.requestId, {
        approvedBy: "human@example.com",
        approvalMode: "explicit_human",
      });
      expect(approval.signingKeyId).toBe("test-ed25519");
      const submissionIntent = manager.getRun(manifest.runId)?.artifacts
        .submissionIntent as any;
      expect(approval.policySha256).toBe(submissionIntent?.policySha256);
      expect(verifier.verifyApproval(approval)).toBe(true);
      expect(broker.get(request.requestId)?.status).toBe("APPROVED");
      expect(
        new ApprovalService(
          manager,
          undefined,
          verifier,
        ).verifyApprovalIntegrity(manifest.runId).valid,
      ).toBe(true);

      await expect(
        broker.approve(request.requestId, {
          approvedBy: "second-reviewer@example.com",
          approvalMode: "explicit_human",
        }),
      ).rejects.toThrow(/no longer pending/);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("trusted authority can mint provider-verified maintainer evidence", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-maintainer-evidence-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "body",
        { hasGatingRules: true, hasLgtmApprovalProtocol: true },
      );
      const intent = new SubmissionIntentService(manager).createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "body",
      });

      const approval = await new ApprovalService(
        manager,
        testApprovalAuthority("maintainer_evidence"),
      ).recordApproval({
        runId: manifest.runId,
        expectedIntentSha256: intent.intentSha256,
      });

      expect(approval.approvalMode).toBe("maintainer_evidence");
      expect(approval.maintainerGateEvidence?.providerVerified).toBe(true);
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("detected community policy rejects policy waivers at broker and submission", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-community-submit-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });
      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "pr body",
        {
          hasGatingRules: true,
          requiresIssueApprovalBeforePr: true,
          reasons: ["maintainer approval is required"],
        },
      );
      const intent = new SubmissionIntentService(manager).createIntent({
        runId: manifest.runId,
        upstreamOwner: "org",
        upstreamRepo: "repo",
        title: "fix: bug",
        body: "pr body",
      });

      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const broker = new TrustedApprovalBroker(
        manager,
        new Ed25519ApprovalSigner("community-key", privateKey),
        new Ed25519ApprovalVerifier("community-key", publicKey),
        new InMemoryApprovalBrokerStore(),
      );
      const request = broker.request(manifest.runId);
      await expect(
        broker.approve(request.requestId, {
          approvedBy: "policy-engine",
          approvalMode: "policy_waived",
        }),
      ).rejects.toThrow(/requires explicit human approval/);

      // Even a separately trusted authority cannot mint a policy waiver for a
      // detected maintainer gate; rejection occurs before any artifact write.
      await expect(
        new ApprovalService(
          manager,
          testApprovalAuthority("policy_waived"),
        ).recordApproval({
          runId: manifest.runId,
          expectedIntentSha256: intent.intentSha256,
        }),
      ).rejects.toThrow(/community policy requires explicit human approval/);
      expect(
        manager.getRun(manifest.runId)?.artifacts.approval,
      ).toBeUndefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("PR_SUBMITTED requires verified SubmissionArtifact produced by submission service", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-submission-"));
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "org/repo" });

      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
      );
      const baseCommitSha =
        manager.getRun(manifest.runId)?.artifacts.workspace?.baseCommitSha;
      if (!baseCommitSha) {
        throw new Error("Fixture workspace has no base commit SHA.");
      }

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
      await approvalService.recordApproval({
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
                data: { object: { sha: baseCommitSha } },
              }),
            },
            pulls: {
              get: async () => ({
                data: {
                  head: { sha: "real_head_sha" },
                  base: { sha: baseCommitSha },
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
        testApprovalAuthority(),
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
      expect(submitted.submissionArtifact.policySha256).toBe(
        permit.policySha256,
      );
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
    const previousHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = join(baseDir, "isolated-home");
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });

      const wsPath = join(baseDir, "allocated-ws");
      mkdirSync(wsPath, { recursive: true });

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
      expect(first.artifact.policySnapshot).toEqual({
        coverage: {
          required: true,
          minimumChangedLineCoverage: 90,
        },
        resourceLeakCheck: { required: false },
      });
      expect(first.artifact.issueOrTaskId).toBe("1");

      expect(() => {
        service.prepare({
          runId: manifest.runId,
          issueOrTaskId: "TASK-17",
        });
      }).toThrow(/WorkspaceIssueOrTaskMismatchError/);

      // Second preparation returns existing canonical workspace if exists
      const second = service.prepare({
        runId: manifest.runId,
        issueOrTaskId: 1,
      });
      expect(second.alreadyPrepared).toBe(true);

      const workspaceArtifactPath = join(
        baseDir,
        manifest.runId,
        "workspace.json",
      );
      const savedWorkspaceArtifact = JSON.parse(
        readFileSync(workspaceArtifactPath, "utf8"),
      ) as Record<string, unknown>;
      const legacyWorkspaceArtifact = { ...savedWorkspaceArtifact };
      delete legacyWorkspaceArtifact.issueOrTaskId;
      writeFileSync(
        workspaceArtifactPath,
        JSON.stringify(legacyWorkspaceArtifact),
      );
      expect(() =>
        service.prepare({
          runId: manifest.runId,
          issueOrTaskId: 1,
        }),
      ).toThrow(/WorkspaceLegacyArtifactTargetUnknownError/);
      writeFileSync(
        workspaceArtifactPath,
        JSON.stringify(savedWorkspaceArtifact),
      );

      // Deleting the physical folder triggers WorkspaceImmutableViolationError (cannot allocate new workspace for same run)
      rmSync(first.context.workspacePath, { recursive: true, force: true });
      expect(() => {
        service.prepare({
          runId: manifest.runId,
          issueOrTaskId: 1,
        });
      }).toThrow(/WorkspaceImmutableViolationError/);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("WorkspaceService allows retrying an unbound issue target only from a clean baseline", async () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ws-issue-retry-"));
    const previousHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = join(baseDir, "isolated-home");
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });
      const workspacePath = join(baseDir, "allocated-ws");
      mkdirSync(workspacePath, { recursive: true });
      writeFileSync(join(workspacePath, "README.md"), "baseline\n");
      execFileSync("git", ["init", "-b", "main"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Tester"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "core.ignoreStat", "false"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "README.md"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "baseline"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/owner/repo.git"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).trim();

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
          branchName: "opencontrib/run-issue-retry",
          isWorktree: true,
          baseRepoPath: workspacePath,
          baseCommitSha,
          baseBranch: "main",
        }),
        detectDefaultBranch: () => "main",
      } as any;
      const { WorkspaceService } = require("../src/workspace/workspace-service.js");
      const service = new WorkspaceService(manager, fakeWorktreeManager);
      service.prepare({ runId: manifest.runId, issueOrTaskId: 1 });

      const missingIssueBinding = new IssueBindingService(manager, {
        getIssue: async () => ({ status: "NOT_FOUND", data: undefined as never }),
      });
      await expect(
        missingIssueBinding.bind({
          runId: manifest.runId,
          repoFullName: "owner/repo",
          issueNumber: 1,
        }),
      ).rejects.toThrow(/IssueBindingProviderError/);
      expect(manager.getRun(manifest.runId)?.manifest.issueNumber).toBeUndefined();
      expect(manager.getRun(manifest.runId)?.artifacts.issueBinding).toBeUndefined();

      const untrackedFile = join(workspacePath, "untracked.txt");
      writeFileSync(untrackedFile, "unverified work\n");
      expect(() =>
        service.prepare({ runId: manifest.runId, issueOrTaskId: 2 }),
      ).toThrow(/WorkspaceIssueRetargetUnsafeError/);
      rmSync(untrackedFile);

      const retried = service.prepare({
        runId: manifest.runId,
        issueOrTaskId: 2,
      });
      expect(retried.alreadyPrepared).toBe(true);
      expect(retried.artifact.issueOrTaskId).toBe("1");

      const issueBinding = new IssueBindingService(manager, {
        getIssue: async (_owner, _repo, issueNumber) => ({
          status: "OK",
          data: {
            number: issueNumber,
            title: `Issue ${issueNumber}`,
            state: "open",
            htmlUrl: `https://github.com/owner/repo/issues/${issueNumber}`,
          },
        }),
      });
      await issueBinding.bind({
        runId: manifest.runId,
        repoFullName: "owner/repo",
        issueNumber: 2,
      });
      expect(
        service.prepare({ runId: manifest.runId, issueOrTaskId: 2 })
          .alreadyPrepared,
      ).toBe(true);
      expect(() =>
        service.prepare({ runId: manifest.runId, issueOrTaskId: 1 }),
      ).toThrow(/WorkspaceIssueMismatchError/);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("WorkspaceService rejects numeric targets for private disclosure policy before saving a workspace", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ws-private-issue-"));
    const previousHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = join(baseDir, "isolated-home");
    let cleanupCount = 0;
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });
      const workspacePath = join(baseDir, "allocated-ws");
      mkdirSync(workspacePath, { recursive: true });
      const baseCommitSha = "a".repeat(40);
      const fakeWorktreeManager = {
        runGit: (args: string[]) => {
          const target = args.at(-1) ?? "";
          if (args.includes("ls-tree")) {
            return {
              success: true,
              stdout:
                target === ".opencontrib.json"
                  ? ".opencontrib.json\n"
                  : target === "SECURITY.md"
                    ? "SECURITY.md\n"
                    : "",
              stderr: "",
            };
          }
          if (args.includes("show")) {
            return {
              success: true,
              stdout: target.endsWith(":.opencontrib.json")
                ? JSON.stringify({
                    policy: {
                      coverage: {
                        required: true,
                        minimumChangedLineCoverage: 90,
                      },
                    },
                  })
                : target.endsWith(":SECURITY.md")
                  ? "Report vulnerabilities privately.\n"
                  : "",
              stderr: "",
            };
          }
          return { success: true, stdout: "", stderr: "" };
        },
        createIsolatedWorkspace: () => ({
          workspacePath,
          branchName: "opencontrib/run-private",
          isWorktree: true,
          baseRepoPath: workspacePath,
          baseCommitSha,
          baseBranch: "main",
        }),
        cleanupWorkspace: () => {
          cleanupCount += 1;
        },
        detectDefaultBranch: () => "main",
      } as any;
      const { WorkspaceService } = require("../src/workspace/workspace-service.js");

      expect(() =>
        new WorkspaceService(manager, fakeWorktreeManager).prepare({
          runId: manifest.runId,
          issueOrTaskId: 42,
        }),
      ).toThrow(/private disclosure workspaces require a nonnumeric task identifier/i);
      expect(manager.getRun(manifest.runId)?.artifacts.workspace).toBeUndefined();
      expect(cleanupCount).toBe(1);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
      rmSync(baseDir, { recursive: true, force: true });
    }
  });

  it("WorkspaceService fails closed when baseline policy inspection fails", () => {
    const baseDir = mkdtempSync(join(tmpdir(), "oc-test-ws-policy-failure-"));
    const previousHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = join(baseDir, "isolated-home");
    try {
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({ repoFullName: "owner/repo" });
      const wsPath = join(baseDir, "allocated-ws");
      mkdirSync(wsPath, { recursive: true });
      const fakeWorktreeManager = {
        runGit: (args: string[]) =>
          args.includes("ls-tree")
            ? { success: false, stdout: "", stderr: "fatal: invalid base" }
            : { success: true, stdout: "", stderr: "" },
        createIsolatedWorkspace: () => ({
          workspacePath: wsPath,
          branchName: "opencontrib/run-test",
          isWorktree: false,
          baseRepoPath: wsPath,
          baseCommitSha: "a".repeat(40),
          baseBranch: "main",
        }),
        detectDefaultBranch: () => "main",
      } as any;
      const {
        WorkspaceService,
      } = require("../src/workspace/workspace-service.js");

      expect(() =>
        new WorkspaceService(manager, fakeWorktreeManager).prepare({
          runId: manifest.runId,
          issueOrTaskId: 1,
        }),
      ).toThrow(/WorkspacePolicySnapshotError/);
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
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

      const testCmd = stateAssertionCommand(stateFile, "ASSERTION_ERR");

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
      );

      await expect(
        evidenceService.verifyGreen({
          runId: manifest.runId,
          testCommand: "echo unrelated-command",
        }),
      ).rejects.toThrow(/GreenExecutionValidationError/);

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
      expect(report).toBeDefined();
      if (!report) return;
      expect(report.allTestsPassing).toBe(true);
      expect(report.greenEvidence?.appliedPatchSha256).toBeDefined();
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }, 60000);

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

      const testCmd = stateAssertionCommand(stateFile, "ASSERTION_ERR");

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

      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "audited body",
      );

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

      seedGovernanceReadyRun(
        manager,
        manifest.runId,
        join(baseDir, "workspace"),
        "pr body",
      );

      const intentService = new SubmissionIntentService(manager);
      // seedGovernanceReadyRun has no baseBranch in workspace, so default is used
      // Let's create a workspace with explicit baseBranch 'develop'
      const {
        saveCanonicalArtifact,
      } = require("../src/run/canonical-writer.js");
      const manifest2 = manager.createRun({ repoFullName: "owner/repo2" });
      const workspacePath = join(baseDir, "workspace-override");
      mkdirSync(workspacePath, { recursive: true });
      const baseCommitSha = writeGreenFileAfterBaseCommit(
        workspacePath,
        "fixed",
      );
      const greenTreeSha256 = computeSourceTreeHash(workspacePath);
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
        greenTreeSha256,
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
      validatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(validatedPatch);
      saveCanonicalArtifact(
        manager,
        manifest2.runId,
        "workspace",
        {
          workspacePath,
          baseRepoPath: workspacePath,
          branchName: "branch2",
          baseBranch: "develop",
          baseCommitSha,
          policySnapshot: fixturePolicySnapshot,
          policySha256: fixturePolicySha256,
          ...fixtureCommunityGate(baseCommitSha),
        },
        "WORKSPACE_PREPARED",
      );
      seedIssueBinding(manager, manifest2.runId, "owner/repo2", 43);
      saveCanonicalArtifact(
        manager,
        manifest2.runId,
        "evidence_red",
        {
          command: "bun test regression.test.ts",
          observedOutputSnippet: "failed",
          exitCode: 1,
          sourceTreeSha256: "1".repeat(64),
          capturedAt: "2026-01-01T00:00:00.000Z",
          assertionMatched: true,
        } as any,
        "RED_CAPTURED",
      );
      manager.saveArtifact(manifest2.runId, "patch", patchContent);
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
          roundsRequested: 1,
          roundsCompleted: 1,
          workersPerRound: 1,
          executionsExpected: 1,
          stressLoopPassed: true,
          executionCount: 1,
          maxConcurrentObserved: 1,
          concurrencyWorkers: 1,
          concurrencyStampedePassed: true,
          handleLeakCheckPassed: "PASS",
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
            sourceTreeSha256: greenTreeSha256,
            capturedAt: "2026-01-01T00:01:00.000Z",
            treeChangedComparedToRed: true,
            treeHashMatchesRed: false,
            appliedPatchSha256: patchSha256,
            validatedPatchArtifactSha256: validatedPatch.artifactSha256,
            stressLoopPassed: true,
            roundsRequested: 1,
            roundsCompleted: 1,
            workersPerRound: 1,
            executionsExpected: 1,
            executionCount: 1,
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
        preflightLintResult: {
          executed: true,
          passed: true,
          exitCode: 0,
          rawOutput: "",
          violationCount: 0,
          violations: [],
          summary: "Fixture lint check passed.",
        },
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
      const workspacePath = join(baseDir, "workspace");
      mkdirSync(workspacePath, { recursive: true });
      const baseCommitSha = writeGreenFileAfterBaseCommit(
        workspacePath,
        "fixed",
      );
      const greenTreeSha256 = computeSourceTreeHash(workspacePath);

      const {
        saveCanonicalArtifact,
      } = require("../src/run/canonical-writer.js");
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
        greenTreeSha256,
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
      validatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(validatedPatch);
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "workspace",
        {
          workspacePath,
          baseRepoPath: workspacePath,
          branchName: "opencontrib/run-1",
          baseBranch: "main",
          baseCommitSha,
          policySnapshot: fixturePolicySnapshot,
          policySha256: fixturePolicySha256,
          ...fixtureCommunityGate(baseCommitSha),
        },
        "WORKSPACE_PREPARED",
      );
      seedIssueBinding(manager, manifest.runId, "org/repo", 42);
      saveCanonicalArtifact(
        manager,
        manifest.runId,
        "evidence_red",
        {
          command: "bun test",
          observedOutputSnippet: "failed",
          exitCode: 1,
          sourceTreeSha256: "c".repeat(64),
          capturedAt: "2026-01-01T00:00:00.000Z",
          assertionMatched: true,
        } as any,
        "RED_CAPTURED",
      );
      manager.saveArtifact(manifest.runId, "patch", patchContent);
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
          roundsRequested: 1,
          roundsCompleted: 1,
          workersPerRound: 1,
          executionsExpected: 1,
          stressLoopPassed: true,
          executionCount: 1,
          maxConcurrentObserved: 1,
          concurrencyWorkers: 1,
          concurrencyStampedePassed: true,
          handleLeakCheckPassed: "PASS",
          passedUnitTestsCount: 1,
          failedUnitTestsCount: 0,
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
            sourceTreeSha256: greenTreeSha256,
            capturedAt: "2026-01-01T00:01:00.000Z",
            treeChangedComparedToRed: true,
            treeHashMatchesRed: false,
            appliedPatchSha256: patchSha256,
            validatedPatchArtifactSha256: validatedPatch.artifactSha256,
            stressLoopPassed: true,
            roundsRequested: 1,
            roundsCompleted: 1,
            workersPerRound: 1,
            executionsExpected: 1,
            executionCount: 1,
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
        preflightLintResult: {
          executed: true,
          passed: true,
          exitCode: 0,
          rawOutput: "",
          violationCount: 0,
          violations: [],
          summary: "Fixture lint check passed.",
        },
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
      await approvalService.recordApproval({
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
        testApprovalAuthority(),
      );

      await expect(submissionService.submit(manifest.runId)).rejects.toThrow(
        /BaseBranchAdvancedError: Upstream base branch "main" has advanced/,
      );
    } finally {
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
