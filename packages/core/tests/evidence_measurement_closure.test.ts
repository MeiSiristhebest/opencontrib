import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { EvidenceReportSchema } from "../src/contracts/schemas.js";
import { captureRedEvidence, collectEvidence } from "../src/evidence/evidence-collector.js";
import { bunCommand } from "./helpers/bun-command.js";
import { IstanbulSummaryCoverageAdapter } from "../src/evidence/coverage-adapter.js";

test("GREEN preserves RED baseline samples without running baseline checks on the patched tree", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-baseline-provenance-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const invocations = join(root, "invocations.log");
    writeFileSync(join(workspace, "value.ts"), "export const value = 1;\n");
    writeFileSync(join(workspace, "regression.test.ts"), [
      'import { expect, test } from "bun:test";',
      'import { appendFileSync } from "node:fs";',
      'import { value } from "./value.ts";',
      `appendFileSync(${JSON.stringify(invocations)}, "run\\n");`,
      'test("regression", () => expect(value).toBe(2));',
    ].join("\n"));
    const testCommand = `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts`;
    const red = captureRedEvidence({ cwd: workspace, testCommand, expectedAssertion: "Expected: 2", testFile: "regression.test.ts" });
    expect(red.assertionMatched).toBe(true);
    expect(red.baselineCheckStatus).toBe("PASS");
    expect(red.baselineFlakyTests).toEqual([]);
    expect(readFileSync(invocations, "utf8").trim().split("\n")).toHaveLength(4);

    writeFileSync(join(workspace, "value.ts"), "export const value = 2;\n");
    const green = await collectEvidence({ cwd: workspace, testCommand, redEvidence: red });
    expect(green.allTestsPassing).toBe(true);
    expect(green.baselineTestedAt).toBe(red.baselineTestedAt!);
    expect(green.baselineCheckStatus).toBe(red.baselineCheckStatus);
    expect(green.baselineFlakyTests).toEqual(red.baselineFlakyTests!);
    expect(readFileSync(invocations, "utf8").trim().split("\n")).toHaveLength(5);
    expect(EvidenceReportSchema.safeParse(green).success).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("a zero-exit PASS message supplies no executed-test evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-empty-tests-"));
  try {
    const evidence = await collectEvidence({ cwd: root, testCommand: bunCommand('console.log("PASS")') });
    expect(evidence.passedUnitTestsCount).toBe(0);
    expect(evidence.zeroAssertionWarning).toBe(true);
    expect(evidence.allTestsPassing).toBe(false);
    expect(evidence.baselineCheckStatus).toBe("UNAVAILABLE");
    expect(EvidenceReportSchema.safeParse(evidence).success).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GREEN reads fresh Bun LCOV after execution and keeps whole-project coverage out of changed-line policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-real-coverage-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "coverage/\ncoverage-summary.json\n");
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "regression.test.ts"), 'import { expect, test } from "bun:test";\nimport { value } from "./value.ts";\ntest("value", () => expect(value).toBe(2));\n');
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"], { cwd: root });
    writeFileSync(join(root, "value.ts"), "export const value = 2;\n");
    const testCommand = `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts --coverage --coverage-reporter=lcov`;
    const report = await collectEvidence({ cwd: root, testCommand });
    expect(report.allTestsPassing).toBe(true);
    expect(report.changedCodeCoverageStatus).toBe("PASS");
    expect(report.changedCodeCoveragePercent).toBe(100);
    writeFileSync(join(root, "coverage-summary.json"), JSON.stringify({ total: { lines: { pct: 100 } } }));
    const whole = await collectEvidence({ cwd: root, testCommand, coverageAdapter: new IstanbulSummaryCoverageAdapter() });
    expect(whole.changedCodeCoverageStatus).toBe("UNAVAILABLE");
    expect(whole.changedCodeCoveragePercent).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);
