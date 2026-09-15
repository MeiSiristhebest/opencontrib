import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  computeSourceTreeHash,
  captureRedEvidence,
  verifyGreenEvidence,
} from "../src/evidence/evidence-collector.js";
import {
  validatePhaseGate,
  type ContributionRunSummary,
} from "../src/index.js";
import type { RedEvidence } from "../src/contracts/schemas.js";

function makeSummary(
  currentPhase: ContributionRunSummary["manifest"]["currentPhase"],
  artifacts?: Record<string, unknown>,
): ContributionRunSummary {
  return {
    manifest: {
      schemaVersion: "1.0.0",
      runId: "run_v2",
      repoFullName: "org/repo",
      currentPhase,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    artifacts: (artifacts ?? {}) as never,
    availableArtifactFiles: [],
    events: [],
  } as ContributionRunSummary;
}

// Cross-platform command selection (Windows uses powershell, POSIX uses sh/echo).
function pickCmd(win: string, posix: string): string {
  return process.platform === "win32" ? win : posix;
}

// A harmless, cross-platform command. Pass/fail is irrelevant to the
// deterministic assertions below (they don't depend on the command outcome).
const HARMLESS_CMD = pickCmd(
  'powershell -NoProfile -Command "Write-Output ok"',
  "echo ok",
);

// A command that fails (exit 1) and emits an identifiable marker.
const FAILING_CMD = pickCmd(
  'powershell -NoProfile -Command "Write-Output ASSERTFAIL; exit 1"',
  'sh -c "echo ASSERTFAIL; exit 1"',
);

describe("Evidence V2 — RED→GREEN trust boundary", () => {
  test("computeSourceTreeHash is a stable, deterministic 64-hex fingerprint", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-tree-hash-"));
    try {
      writeFileSync(join(dir, "a.txt"), "alpha\n");
      writeFileSync(join(dir, "b.txt"), "beta\n");
      const h1 = computeSourceTreeHash(dir);
      const h2 = computeSourceTreeHash(dir);
      expect(h1).toMatch(/^[0-9a-f]{64}$/);
      expect(h2).toBe(h1);

      // Mutating the tree must change the fingerprint.
      writeFileSync(join(dir, "a.txt"), "alpha CHANGED\n");
      const h3 = computeSourceTreeHash(dir);
      expect(h3).not.toBe(h1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("captureRedEvidence binds the tree hash and records assertionMatched", () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-red-"));
    try {
      const red = captureRedEvidence({
        cwd: dir,
        testCommand: FAILING_CMD,
        expectedAssertion: "ASSERTFAIL",
      });
      expect(red.assertionMatched).toBe(true);
      expect(red.sourceTreeSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(red.command).toBe(FAILING_CMD);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("verifyGreenEvidence: reproductionVerified is false when RED assertion did not match", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-green-unmatched-"));
    try {
      const red: RedEvidence = {
        command: HARMLESS_CMD,
        observedOutputSnippet: "stale",
        exitCode: 1,
        sourceTreeSha256: "deadbeef", // a hash that differs from the real tree
        capturedAt: new Date().toISOString(),
        assertionMatched: false,
        assertionMatchedFingerprint: "fingerprint",
      };
      const res = await verifyGreenEvidence({
        cwd: dir,
        testCommand: HARMLESS_CMD,
        redEvidence: red,
        stressLoopCount: 1,
      });
      // RED assertion was not matched, so the full cycle is unverified.
      expect(res.reproductionVerified).toBe(false);
      // The tree certainly differs from the bogus red hash.
      expect(res.greenEvidence.treeChangedComparedToRed).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("gate: EVIDENCE_COLLECTED is blocked when no evidence artifact exists", () => {
    // Workspace is present but evidence is missing -> blocked by required-artifact check.
    const summary = makeSummary("PATCH_DRAFTED", {
      workspace: { workspacePath: "/tmp/ws" },
    });
    const res = validatePhaseGate(summary, "EVIDENCE_COLLECTED");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("evidence");
  });

  test("gate: EVIDENCE_COLLECTED is blocked when reproductionVerified is false", () => {
    const summary = makeSummary("PATCH_DRAFTED", {
      workspace: { workspacePath: "/tmp/ws" },
      evidence: { allTestsPassing: true, reproductionVerified: false },
    });
    const res = validatePhaseGate(summary, "EVIDENCE_COLLECTED");
    expect(res.ok).toBe(false);
    expect(res.error?.message).toContain("EvidenceBundleV2");
  });

  test("real producer-contract integration: captureRedEvidence -> mutate source -> verifyGreenEvidence -> saveArtifact -> phase == EVIDENCE_COLLECTED", async () => {
    const wsDir = mkdtempSync(join(tmpdir(), "oc-real-e2e-ws-"));
    const baseDir = mkdtempSync(join(tmpdir(), "oc-real-e2e-runs-"));
    try {
      const stateFile = join(wsDir, "status.txt");
      // Initially failing state (RED)
      writeFileSync(stateFile, "FAIL\n");

      // Test command that inspects status.txt
      const testCmd = pickCmd(
        `powershell -NoProfile -Command "if ((Get-Content '${stateFile.replace(/\\/g, "/")}') -match 'FAIL') { Write-Output ASSERTION_ERROR_SAMPLE; exit 1 } else { Write-Output PASS; exit 0 }"`,
        `sh -c "if grep -q FAIL ${stateFile}; then echo ASSERTION_ERROR_SAMPLE; exit 1; else echo PASS; exit 0; fi"`,
      );

      // 1. Capture real RED baseline
      const red = captureRedEvidence({
        cwd: wsDir,
        testCommand: testCmd,
        expectedAssertion: "ASSERTION_ERROR_SAMPLE",
      });

      expect(red.assertionMatched).toBe(true);
      expect(red.exitCode).toBe(1);
      expect(red.assertionMatchedFingerprint).toBeDefined();

      const { ContributionRunManager } = await import(
        "../src/run/run-manager.js"
      );
      const manager = new ContributionRunManager({ baseDir });
      const manifest = manager.createRun({
        repoFullName: "test/repo",
        issueNumber: 1,
      });

      // Advance to PATCH_DRAFTED
      manager.saveArtifact(
        manifest.runId,
        "workspace",
        { workspacePath: wsDir },
        "WORKSPACE_PREPARED",
      );
      manager.saveArtifact(manifest.runId, "patch", "diff...", "PATCH_DRAFTED");

      // 2. Mutate source to fix bug (GREEN)
      writeFileSync(stateFile, "PASS LONGER MUTATION STRING\n");

      // 3. Verify real GREEN evidence
      const green = verifyGreenEvidence({
        cwd: wsDir,
        testCommand: testCmd,
        redEvidence: red,
      });

      expect(green.greenEvidence.passed).toBe(true);
      expect(green.greenEvidence.treeChangedComparedToRed).toBe(true);
      expect(green.greenEvidence.treeHashMatchesRed).toBe(false);
      expect(green.greenEvidence.stressLoopPassed).toBe(true);
      expect(green.greenEvidence.assertionMatchedFingerprint).toBe(
        red.assertionMatchedFingerprint,
      );
      expect(green.reproductionVerified).toBe(true);
      expect(green.allTestsPassing).toBe(true);

      const report = {
        baselineTestedAt: red.capturedAt,
        baselineFlakyTests: [],
        stressLoopRuns: 1,
        stressLoopPassed: true,
        handleLeakCheckPassed: true,
        passedUnitTestsCount: 1,
        allTestsPassing: true,
        reproductionVerified: true,
        redEvidence: red,
        greenEvidence: green.greenEvidence,
      };

      // 4. Save artifact via trusted canonical flow and advance to EVIDENCE_COLLECTED
      manager.saveArtifactTrusted(
        manifest.runId,
        "evidence",
        report,
        "EVIDENCE_COLLECTED",
      );

      const updated = manager.getRun(manifest.runId);
      expect(updated?.manifest.currentPhase).toBe("EVIDENCE_COLLECTED");
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
