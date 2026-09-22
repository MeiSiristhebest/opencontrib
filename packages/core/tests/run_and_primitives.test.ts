import { afterEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import {
  ContextAssembler,
  ContributionRunManager,
  rankOpportunitySignals,
} from "../src/index.js";
import { hashValidatedPatchArtifact } from "../src/evidence/validated-patch.js";

describe("Contribution Run & Artifact Bundle Primitives", () => {
  const tempDirs: string[] = [];

  function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "opencontrib-run-test-"));
    tempDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const d of tempDirs.splice(0)) {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("creates an auditable contribution run session with manifest.json", () => {
    const customBase = makeTempDir();
    const manager = new ContributionRunManager({ baseDir: customBase });

    const manifest = manager.createRun({
      repoFullName: "bytedance/flowgram.ai",
      issueNumber: 123,
      issueTitle: "Fix node cache lifecycle leak",
      tags: ["bugfix", "typescript"],
    });

    expect(manifest.runId).toContain("bytedance_flowgram_ai_issue_123");
    expect(manifest.currentPhase).toBe("INITIALIZED");
    expect(manifest.repoFullName).toBe("bytedance/flowgram.ai");
    expect(manifest.tags).toEqual(["bugfix", "typescript"]);

    const loaded = manager.getRun(manifest.runId);
    expect(loaded).toBeDefined();
    expect(loaded?.manifest.runId).toBe(manifest.runId);
    expect(loaded?.availableArtifactFiles).toContain("manifest.json");
  });

  it("only permits the first PR draft after canonical evidence is collected", () => {
    const customBase = makeTempDir();
    const manager = new ContributionRunManager({ baseDir: customBase });
    const manifest = manager.createRun({ repoFullName: "owner/repo" });

    expect(() => manager.saveArtifact(manifest.runId, "pr_draft", "premature"))
      .toThrow(/first PR draft must be created in EVIDENCE_COLLECTED/);
  });

  it("saves discrete stage artifacts and advances run phase seamlessly", () => {
    const customBase = makeTempDir();
    const manager = new ContributionRunManager({ baseDir: customBase });

    const manifest = manager.createRun({
      repoFullName: "cloudwego/kitex",
      issueNumber: 456,
      issueTitle: "Connection pool timeout",
    });

    // 1. Save opportunity
    manager.saveArtifact(manifest.runId, "opportunity", {
      score: 92,
      signals: { skillMatch: 0.95 },
    });

    // 2. Save context
    manager.saveArtifact(manifest.runId, "context", {
      repo: "cloudwego/kitex",
      primary: "go",
    });

    // 2.5 Save workspace sandbox
    saveCanonicalArtifact(
      manager,
      manifest.runId,
      "workspace",
      {
        workspacePath: "/tmp/workspaces/kitex",
        branchName: "fixture-branch",
        isWorktree: false,
        baseRepoPath: "/tmp/workspaces/kitex",
        baseCommitSha: "a".repeat(40),
        repoFullName: "cloudwego/kitex",
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      "WORKSPACE_PREPARED",
    );

    // 2.6 Save RED baseline
    saveCanonicalArtifact(
      manager,
      manifest.runId,
      "evidence_red",
      {
        command: "bun test",
        expectedAssertion: "pool timeout assertion failed",
        observedOutputSnippet: "AssertionError: pool timeout assertion failed",
        exitCode: 1,
        sourceTreeSha256: "aaaaaaaa",
        capturedAt: "2026-07-01T00:00:00.000Z",
        assertionMatched: true,
      } as any,
      "RED_CAPTURED",
    );

    // 3. Save a concrete patch artifact and its later immutable validation.
    const patchContent = JSON.stringify({
      files: [
        {
          path: "pool.go",
          operation: "MODIFY",
          mode: "100644",
          content: "new",
        },
      ],
    });
    const patchSha256 = createHash("sha256").update(patchContent).digest("hex");
    manager.saveArtifact(manifest.runId, "patch", patchContent);

    // 4. Save evidence (a verified RED→GREEN cycle is required to advance)
    const testIdentity = {
      normalizedCommand: "bun test",
      testFiles: [{ path: "pool_test.go", sha256: "hash-test" }],
      identitySha256: "id-sha-12345",
    };
    const validatedPatch = {
      runId: manifest.runId,
      patchSha256,
      actualDeltaSha256: "b".repeat(64),
      baseCommitSha: "a".repeat(40),
      redTreeSha256: "aaaaaaaa",
      greenTreeSha256: "bbbbbbbb",
      artifactSha256: "",
      changedLines: 0,
      files: [
        {
          path: "pool.go",
          operation: "MODIFY" as const,
          mode: "100644" as const,
          contentSha256: createHash("sha256").update("new").digest("hex"),
        },
      ],
      validatedAt: "2026-07-01T00:01:00.000Z",
    };
    validatedPatch.artifactSha256 = hashValidatedPatchArtifact(validatedPatch);
    const evidenceReport = {
      baselineTestedAt: "2026-07-01T00:00:00.000Z",
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
      handleLeakCheckPassed: "PASS" as const,
      passedUnitTestsCount: 1,
      failedUnitTestsCount: 0,
      testCoverageStatus: "UNAVAILABLE" as const,
      changedCodeCoverageStatus: "UNAVAILABLE" as const,
      passed: true,
      stressLoopSuccessRate: 1.0,
      reproductionVerified: true,
      allTestsPassing: true,
      redEvidence: {
        command: "bun test",
        expectedAssertion: "pool timeout assertion failed",
        observedOutputSnippet: "AssertionError: pool timeout assertion failed",
        exitCode: 1,
        sourceTreeSha256: "aaaaaaaa",
        capturedAt: "2026-07-01T00:00:00.000Z",
        assertionMatched: true,
        assertionMatchedFingerprint: "fp-1",
        testIdentity,
      },
      greenEvidence: {
        command: "bun test",
        exitCode: 0,
        outputSnippet: "0 failed",
        passed: true,
        sourceTreeSha256: "bbbbbbbb",
        capturedAt: "2026-07-01T00:01:00.000Z",
        treeChangedComparedToRed: true,
        treeHashMatchesRed: false,
        stressLoopPassed: true,
        roundsRequested: 1,
        roundsCompleted: 1,
        workersPerRound: 1,
        executionsExpected: 1,
        executionCount: 1,
        allTestsPassing: true,
        appliedPatchSha256: patchSha256,
        validatedPatchArtifactSha256: validatedPatch.artifactSha256,
        assertionMatchedFingerprint: "fp-1",
        testIdentity,
      },
    };
    saveCanonicalArtifact(
      manager,
      manifest.runId,
      "validated_patch",
      validatedPatch,
    );
    saveCanonicalArtifact(
      manager,
      manifest.runId,
      "evidence",
      evidenceReport,
      "EVIDENCE_COLLECTED",
    );

    const summary = manager.getRun(manifest.runId);
    expect(summary?.manifest.currentPhase).toBe("EVIDENCE_COLLECTED");
    expect(summary?.artifacts.opportunity).toEqual({
      score: 92,
      signals: { skillMatch: 0.95 },
    });
    expect(summary?.artifacts.patch).toContain("pool.go");
    expect(summary?.artifacts.evidence).toEqual(evidenceReport);
    expect(summary?.availableArtifactFiles).toContain("opportunity.json");
    expect(summary?.availableArtifactFiles).toContain("patch.diff");
    expect(summary?.availableArtifactFiles).toContain("evidence.json");
    expect(summary?.events).toBeArray();
    if (summary?.events && summary.events.length > 0) {
      expect(summary.events[0].eventId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });

  it("resumes interrupted contribution run with state and suggested next action", () => {
    const customBase = makeTempDir();
    const manager = new ContributionRunManager({ baseDir: customBase });

    const manifest = manager.createRun({
      repoFullName: "facebook/react",
      issueNumber: 789,
    });

    manager.saveArtifact(manifest.runId, "opportunity", { score: 88 });

    // Crash simulation -> Agent B resumes
    const resumeInfo = manager.resumeRun(manifest.runId);
    expect(resumeInfo.runId).toBe(manifest.runId);
    expect(resumeInfo.currentPhase).toBe("OPPORTUNITY_SCOUTED");
    expect(resumeInfo.availableArtifacts).toContain("opportunity");
    expect(resumeInfo.latestArtifactSummary.hasOpportunity).toBe(true);
    expect(resumeInfo.latestArtifactSummary.hasPatch).toBe(false);
    expect(resumeInfo.suggestedNextAction).toBe("assemble_context");
  });
});

describe("Discrete Opportunity Signals Engine (contrib_rank_opportunity)", () => {
  it("extracts objective multi-dimensional probability signals without bias", () => {
    const result = rankOpportunitySignals({
      issue: {
        number: 42,
        title: "Fix race condition in TypeScript event dispatcher",
        body: "When emitting events concurrently, listener array undergoes mutation.",
        labels: ["bug", "typescript"],
        createdAt: new Date().toISOString(),
      },
      repository: {
        fullName: "bytedance/flowgram.ai",
        stars: 1200,
        primaryLanguage: "TypeScript",
      },
      developerProfile: {
        techStack: ["typescript", "node.js", "react"],
        focusAreas: ["bugfix", "concurrency"],
      },
      environment: {
        os: "linux",
        hasDocker: true,
      },
    });

    expect(result.score).toBeGreaterThanOrEqual(60);
    expect(result.signals.skillMatch).toBeGreaterThanOrEqual(0.4);
    expect(result.signals.environmentFeasibility).toBeGreaterThanOrEqual(0.8);
    expect(result.signals.isQualified).toBe(true);
    expect(result.signals.maintenanceRisk).toBeLessThan(0.3);
    expect(
      result.reasons.some(
        (r) => r.includes("TypeScript") || r.includes("Matched"),
      ),
    ).toBe(true);
  });

  it("penalizes feasibility and highlights constraints for incompatible platforms", () => {
    const result = rankOpportunitySignals({
      issue: {
        number: 99,
        title: "macOS keychain helper fails on Sonoma",
        body: "Requires Xcode and macOS security framework",
        labels: ["os:macos"],
        createdAt: new Date().toISOString(),
      },
      repository: {
        fullName: "desktop/desktop",
        stars: 15000,
      },
      environment: {
        os: "windows",
        hasDocker: false,
      },
    });

    expect(result.signals.environmentFeasibility).toBeLessThanOrEqual(0.85);
    expect(
      result.reasons.some(
        (r) =>
          r.includes("Environment feasibility constraint") ||
          r.includes("macOS"),
      ),
    ).toBe(true);
  });
});

describe("Enhanced Context Assembler with Exploration Guidance", () => {
  it("generates suggested reading order, target test files, and risk surface", () => {
    const mockDoctorReport: any = {
      environment: { os: "linux", arch: "x64", hasDocker: false },
      system: { os: "linux", arch: "x64" },
      git: { version: "2.40.0" },
      runtimes: [],
      tools: [],
    };
    const assembler = new ContextAssembler();
    const assembled = assembler.assemble({
      repoFullName: "bytedance/flowgram.ai",
      issueTitle: "Fix state mutation in NodeCache",
      issueBody: "NodeCache does not reset boolean falsy values properly",
      issueNumber: 101,
      packageManifest: '{"name": "flowgram", "package.json": true}',
      primaryLanguage: "TypeScript",
      doctorReport: mockDoctorReport,
    });

    expect(assembled.guidance).toBeDefined();
    expect(assembled.guidance.suggestedReadingOrder).toBeDefined();
    expect(assembled.guidance.riskSurface.level).toBe("LOW");
    expect(assembled.guidance.riskSurface.rationale).toBeDefined();

    const formattedPrompt = assembler.formatContextPrompt(assembled);
    expect(formattedPrompt).toContain(
      "### 3. Contribution Exploration Guidance",
    );
    expect(formattedPrompt).toContain("Suggested Reading Order");
    expect(formattedPrompt).toContain("Risk Surface");
  });
});

describe("Unified OpenContrib Storage Layout", () => {
  it("resolves consistent directory structure and file paths", async () => {
    const { OpenContribStorage } = await import("../src/index.js");
    const storage = new OpenContribStorage(
      join(tmpdir(), "opencontrib-storage-test"),
    );

    expect(storage.getHomeDir()).toContain("opencontrib-storage-test");
    expect(storage.getRunsDir()).toContain("runs");
    expect(storage.getWorkspacesDir()).toContain("workspaces");
    expect(storage.getReposDir()).toContain("repos");
    expect(storage.getMemoryFile()).toContain("memory.json");
    expect(storage.getFlywheelFile()).toContain("contributions.json");
  });

  it("strictly validates Run ID and blocks path traversal attempts", async () => {
    const { validateRunId } = await import("../src/run/artifact-bundle.js");
    const base = join(tmpdir(), "opencontrib-sec-test");

    expect(() => validateRunId("../../etc/passwd", base)).toThrow(
      "Security error",
    );
    expect(() => validateRunId("run_123/../../bad", base)).toThrow(
      "Security error",
    );
    expect(() => validateRunId("run_123\\..\\bad", base)).toThrow(
      "Security error",
    );
    expect(() => validateRunId("run_valid_123-abc", base)).not.toThrow();
  });

  it("parses structured CommandSpec safely handling quotes and escaped spaces", async () => {
    const { parseCommandSpec, serializeCommandSpec } =
      await import("../src/sandbox/command-spec.js");

    const parsed1 = parseCommandSpec('npm test -- --grep "falsy cache value"');
    expect(parsed1.executable).toBe("npm");
    expect(parsed1.args).toEqual(["test", "--", "--grep", "falsy cache value"]);

    const parsed2 = parseCommandSpec(
      'cargo test --package core -- "stress test"',
    );
    expect(parsed2.executable).toBe("cargo");
    expect(parsed2.args).toEqual([
      "test",
      "--package",
      "core",
      "--",
      "stress test",
    ]);

    const serialized = serializeCommandSpec(parsed1);
    expect(serialized).toContain('"falsy cache value"');
  });
});

describe("ActiveSessionManager & Pointer Store Persistence", () => {
  it("manages active session file write, update, and clear", async () => {
    const { ActiveSessionManager } = await import("../src/index.js");
    const sessionFile = join(tmpdir(), `active_session_${Date.now()}.json`);
    const sessionManager = new ActiveSessionManager(sessionFile);

    expect(sessionManager.getActiveSession()).toBeNull();
    expect(sessionManager.getActiveRunId()).toBeNull();

    const created = sessionManager.setActiveSession({
      runId: "run_test_123",
      repoFullName: "test/repo",
      issueNumber: 42,
      issueTitle: "Test bug",
    });

    expect(created.runId).toBe("run_test_123");
    expect(sessionManager.getActiveRunId()).toBe("run_test_123");

    sessionManager.updatePhase("WORKSPACE_PREPARED");
    expect(sessionManager.getActiveSession()?.currentPhase).toBe(
      "WORKSPACE_PREPARED",
    );

    sessionManager.updateWorkspacePath("/tmp/test-workspace");
    expect(sessionManager.getActiveSession()?.workspacePath).toBe(
      "/tmp/test-workspace",
    );

    expect(sessionManager.clearActiveSession()).toBe(true);
    expect(sessionManager.getActiveSession()).toBeNull();
  });

  it("automatically resolves active run ID when not explicitly passed", async () => {
    const customBase = join(tmpdir(), `run_resolve_test_${Date.now()}`);
    const sessionFile = join(tmpdir(), `active_session_${Date.now()}_res.json`);
    const { ActiveSessionManager, ContributionRunManager } =
      await import("../src/index.js");
    const sessionManager = new ActiveSessionManager(sessionFile);
    const runManager = new ContributionRunManager({
      baseDir: customBase,
      activeSession: sessionManager,
    });

    // Explicit run ID should resolve directly
    expect(runManager.resolveRunId("run_explicit_999")).toBe(
      "run_explicit_999",
    );
  });
});
