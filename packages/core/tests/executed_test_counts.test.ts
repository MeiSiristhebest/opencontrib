import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseExecutedTestCounts, prepareTestExecutionSpec, resolveTestRunnerCommand } from "../src/evidence/parsers/executed-counts.js";

test.each(["NODE_ENV=test vitest run", "env NODE_ENV=test vitest run", "npm exec --no -- vitest run", "pnpm exec vitest run", "yarn exec vitest run"])("resolves supported runner wrapper %s", command => {
  expect(resolveTestRunnerCommand(command, process.cwd())?.executable).toBe("vitest");
});

test.each(["uv run pytest", "poetry run pytest", "pipenv run pytest", "conda run pytest"])("counts the pytest runner advertised by discovery: %s", command => {
  expect(parseExecutedTestCounts("================ 2 passed in 0.02s ================\n", command, process.cwd()).passed).toBe(2);
});

test("counts Python and Swift runners selected by discovery", () => {
  expect(parseExecutedTestCounts("================ 2 passed in 0.02s ================\n", "python3 -m pytest", process.cwd())).toEqual({ passed: 2, failed: 0, total: 2 });
  expect(parseExecutedTestCounts("Test Suite 'All tests' passed at 2026-10-08 10:00:00.000.\n\tExecuted 3 tests, with 0 failures (0 unexpected) in 0.001 (0.001) seconds\n", "swift test", process.cwd())).toEqual({ passed: 3, failed: 0, total: 3 });
  expect(parseExecutedTestCounts("Test run with 4 tests in 2 suites passed after 0.02 seconds.\n", "swift test", process.cwd())).toEqual({ passed: 4, failed: 0, total: 4 });
});

test("rejects inconsistent Jest and Vitest terminal totals", () => {
  for (const runner of ["jest", "vitest"]) {
    expect(parseExecutedTestCounts("Tests: 2 passed, 0 failed, 1 total\n", runner, process.cwd()).passed).toBe(0);
    expect(parseExecutedTestCounts("Tests  2 passed (1)\n", runner, process.cwd()).passed).toBe(0);
  }
});

test("decodes Go JSON output without counting its terminal events twice", () => {
  const output = [
    { Action: "output", Test: "TestValue", Output: "--- PASS: TestValue (0.00s)\n" },
    { Action: "pass", Test: "TestValue" },
    { Action: "output", Test: "TestOther", Output: "--- FAIL: TestOther (0.00s)\n" },
    { Action: "fail", Test: "TestOther" },
  ].map(event => JSON.stringify(event)).join("\n");
  expect(parseExecutedTestCounts(output, "go test -json", process.cwd())).toEqual({ passed: 1, failed: 1, total: 2 });
});

test("counts Go JSON test events when output is embedded in JSON strings", () => {
  const output = [
    { Action: "output", Test: "TestValue", Output: "--- PASS: TestValue (1m30.12s)\n" },
    { Action: "output", Test: "TestOther", Output: "--- FAIL: TestOther (2h0m0.01s)\n" },
    { Action: "output", Package: "example.test/pkg", Output: "ok\texample.test/pkg\t90.0s\n" },
  ].map(event => JSON.stringify(event)).join("\n");
  expect(parseExecutedTestCounts(output, "go test -json", process.cwd())).toEqual({ passed: 1, failed: 1, total: 2 });
});

test("prepares Go package scripts with fresh execution and preserves environment and arguments", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oc-go-script-"));
  try {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "GODEBUG=panicnil=1 go test -count=5 ./..." } }));
    const spec = prepareTestExecutionSpec("npm test -- -run TestValue", cwd);
    expect(spec.executable).toBe("go");
    expect(spec.args).toEqual(["test", "-count=1", "-v", "./...", "-run", "TestValue"]);
    expect(spec.env?.GODEBUG).toBe("panicnil=1");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("does not rewrite a compound shell command", () => {
  const command = "go test ./... && echo done";
  expect(prepareTestExecutionSpec(command).args).toEqual(["test", "./...", "&&", "echo", "done"]);
});

test("native Go execution disables cache and counts tests, not packages", () => {
  const command = "go test -count 5 ./...";
  expect(prepareTestExecutionSpec(command).args).toEqual(["test", "-count=1", "-v", "./..."]);
  expect(prepareTestExecutionSpec("go test -count=5 ./...").args).toEqual(["test", "-count=1", "-v", "./..."]);
});

test.each([
  ["cached package summary", "ok\texample.test/pkg\t(cached)\n"],
  ["cached summary with a verbose PASS line", "=== RUN   TestValue\n--- PASS: TestValue (0.00s)\nPASS\nok\texample.test/pkg\t(cached)\n"],
  ["fresh package summary without individual test events", "ok\texample.test/pkg\t0.003s\n"],
  ["package with no test files", "?\texample.test/pkg\t[no test files]\n"],
])("does not count %s as observed Go tests", (_label, output) => {
  expect(parseExecutedTestCounts(output, "go test ./...", process.cwd())).toEqual({ passed: 0, failed: 0, total: 0 });
});

test("counts an individual fresh Go test result instead of its package summary", () => {
  const command = "go test -count 5 ./...";
  expect(parseExecutedTestCounts("=== RUN   TestValue\n--- PASS: TestValue (0.00s)\nPASS\nok\texample.test/pkg\t0.003s\n", command, process.cwd())).toEqual({ passed: 1, failed: 0, total: 1 });
});

test("reads only fresh Gradle JUnit XML test summaries", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oc-gradle-results-"));
  try {
    const results = join(cwd, "module", "build", "test-results", "test");
    mkdirSync(results, { recursive: true });
    const startedAt = Date.now() - 500;
    const report = join(results, "TEST-Example.xml");
    writeFileSync(report, `<testsuite tests="5" failures="1" errors="1" skipped="1" timestamp="${new Date().toISOString()}"></testsuite>`);
    expect(parseExecutedTestCounts("BUILD SUCCESSFUL", "./gradlew test", cwd, startedAt)).toEqual({ passed: 2, failed: 2, total: 5 });

    writeFileSync(report, `<testsuite tests="5" failures="0" errors="0" skipped="0" timestamp="${new Date(startedAt - 60_000).toISOString()}"></testsuite>`);
    expect(parseExecutedTestCounts("BUILD SUCCESSFUL", "./gradlew test", cwd, startedAt)).toEqual({ passed: 0, failed: 0, total: 0 });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("package scripts use their actual runner and arbitrary output scripts supply no counts", () => {
  const cwd = mkdtempSync(join(tmpdir(), "oc-runner-script-"));
  const output = "31 pass\n0 fail\nRan 31 tests across 1 file. [1.00ms]";
  try {
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test" } }));
    expect(parseExecutedTestCounts(output, "npm test", cwd).passed).toBe(31);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: 'bun -e "console.log(31)"' } }));
    expect(parseExecutedTestCounts(output, "npm test", cwd).passed).toBe(0);
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "bun test && node fabricate.js" } }));
    expect(parseExecutedTestCounts(output, "npm test", cwd).passed).toBe(0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("Cargo and Maven aggregate all terminal suite summaries without counting class reports twice", () => {
  const cargo = "test result: ok. 0 passed; 0 failed; 0 ignored;\ntest result: ok. 2 passed; 0 failed; 0 ignored;\n";
  expect(parseExecutedTestCounts(cargo, "cargo test", process.cwd())).toEqual({ passed: 2, failed: 0, total: 2 });
  const maven = "[INFO] Tests run: 0, Failures: 0, Errors: 0, Skipped: 0\n[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 1, Time elapsed: 1s -- in ExampleTest\n[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 1\n";
  expect(parseExecutedTestCounts(maven, "mvn test", process.cwd())).toEqual({ passed: 2, failed: 0, total: 3 });
  expect(parseExecutedTestCounts("[INFO] BUILD SUCCESS\nSurefire", "mvn test", process.cwd())).toEqual({ passed: 0, failed: 0, total: 0 });
});

test("counts must use the invoked runner's format even when another runner's summary is printed", () => {
  const fakeBun = "31 pass\n0 fail\nRan 31 tests across 1 file. [1.00ms]\n";
  const zeroNode = "TAP version 13\n# tests 0\n# pass 0\n# fail 0\n";
  expect(parseExecutedTestCounts(fakeBun + zeroNode, "node --test ./empty.test.js", process.cwd())).toEqual({ passed: 0, failed: 0, total: 0 });
  expect(parseExecutedTestCounts(fakeBun, "jest", process.cwd())).toEqual({ passed: 0, failed: 0, total: 0 });
});
