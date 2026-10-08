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

test("a script printing runner-looking summaries cannot supply executed-test evidence", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-forged-counts-"));
  try {
    const output = "bun test v1.3.14\n 31 pass\n 0 fail\nRan 31 tests across 1 file. [1.00ms]";
    const evidence = await collectEvidence({ cwd: root, testCommand: bunCommand(`console.log(${JSON.stringify(output)})`) });
    expect(evidence.passedUnitTestsCount).toBe(0);
    expect(evidence.zeroAssertionWarning).toBe(true);
    expect(evidence.allTestsPassing).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native runner totals override fake counts printed by a test module with no tests", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-zero-runner-counts-"));
  try {
    writeFileSync(join(root, "empty.test.ts"), 'console.log("31 pass, 0 fail");\n');
    const evidence = await collectEvidence({ cwd: root, testCommand: `"${process.execPath.replace(/\\/g, "/")}" test ./empty.test.ts` });
    expect(evidence.passedUnitTestsCount).toBe(0);
    expect(evidence.allTestsPassing).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a fresh LCOV written by tests without an instrumenter is unavailable", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-forged-coverage-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    writeFileSync(join(root, ".gitignore"), "coverage/\n");
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "regression.test.ts"), [
      'import { expect, test } from "bun:test";',
      'import { mkdirSync, writeFileSync } from "node:fs";',
      'import { value } from "./value.ts";',
      'mkdirSync("coverage", { recursive: true });',
      'writeFileSync("coverage/lcov.info", "SF:value.ts\\nDA:1,1\\nend_of_record\\n");',
      'test("value", () => expect(value).toBe(2));',
    ].join("\n"));
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"], { cwd: root });
    writeFileSync(join(root, "value.ts"), "export const value = 2;\n");
    const evidence = await collectEvidence({ cwd: root, testCommand: `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts` });
    expect(evidence.allTestsPassing).toBe(true);
    expect(evidence.changedCodeCoveragePercent).toBeUndefined();
    expect(evidence.changedCodeCoverageStatus).toBe("UNAVAILABLE");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("RED includes the initial failure when every later baseline sample passes", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-initial-red-flaky-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const attempts = join(root, "attempts.log");
    writeFileSync(join(workspace, "regression.test.ts"), [
      'import { expect, test } from "bun:test";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      `const attempts = ${JSON.stringify(attempts)};`,
      'appendFileSync(attempts, "attempt\\n");',
      'test("intermittent regression", () => expect(readFileSync(attempts, "utf8").trim().split("\\n").length).toBeGreaterThan(1));',
    ].join("\n"));
    const testCommand = `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts`;
    const red = captureRedEvidence({ cwd: workspace, testCommand, expectedAssertion: "Expected: > 1", testFile: "regression.test.ts" });
    expect(red.assertionMatched).toBe(true);
    expect(red.baselineCheckStatus).toBe("FAIL");
    expect(red.baselineFlakyTests?.[0]?.runCount).toBe(4);
    expect(red.baselineFlakyTests?.[0]?.failCount).toBe(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("RED rejects source changes made by the first reproduction execution", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-initial-red-mutation-"));
  try {
    writeFileSync(join(root, "value.ts"), "export const value = 1;\n");
    writeFileSync(join(root, "regression.test.ts"), [
      'import { expect, test } from "bun:test";',
      'import { writeFileSync } from "node:fs";',
      'writeFileSync(new URL("./value.ts", import.meta.url), "export const value = 2;\\n");',
      'test("mutating reproduction", () => expect(1).toBe(2));',
    ].join("\n"));
    const testCommand = `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts`;
    expect(() => captureRedEvidence({ cwd: root, testCommand, expectedAssertion: "Expected: 2", testFile: "regression.test.ts" })).toThrow("EvidenceBaselineMutationError");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("RED rejects later failures that do not reproduce the expected assertion", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-red-other-failures-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const attempts = join(root, "attempts.log");
    writeFileSync(join(workspace, "regression.test.ts"), [
      'import { test } from "bun:test";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      `const attempts = ${JSON.stringify(attempts)};`,
      'appendFileSync(attempts, "attempt\\n");',
      'test("regression", () => { throw new Error(readFileSync(attempts, "utf8").trim().split("\\n").length === 1 ? "EXPECTED_REGRESSION" : "OTHER_FAILURE"); });',
    ].join("\n"));
    const testCommand = `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts`;
    const red = captureRedEvidence({ cwd: workspace, testCommand, expectedAssertion: "error: EXPECTED_REGRESSION\\r?\\n", testFile: "regression.test.ts" });
    expect(red.assertionMatched).toBe(true);
    expect(red.baselineCheckStatus).toBe("FAIL");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

test("GREEN validates executed-test counts for every requested stress execution", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-stress-counts-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const attempts = join(root, "attempts.log");
    writeFileSync(join(workspace, "regression.test.ts"), [
      'import { expect, test } from "bun:test";',
      'import { appendFileSync, readFileSync } from "node:fs";',
      `const attempts = ${JSON.stringify(attempts)};`,
      'appendFileSync(attempts, "attempt\\n");',
      'if (readFileSync(attempts, "utf8").trim().split("\\n").length === 1) test("first execution only", () => expect(true).toBe(true));',
    ].join("\n"));
    const testCommand = `"${process.execPath.replace(/\\/g, "/")}" test ./regression.test.ts`;
    const green = await collectEvidence({ cwd: workspace, testCommand, stressLoopCount: 2 });
    expect(green.executionCount).toBe(2);
    expect(green.allTestsPassing).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}, 30_000);

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
