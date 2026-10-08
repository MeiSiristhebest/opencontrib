import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseExecutedTestCounts, prepareTestExecutionSpec } from "../src/evidence/parsers/executed-counts.js";

test("native Go execution disables cache and counts tests, not packages", () => {
  const command = "go test -count 5 ./...";
  expect(prepareTestExecutionSpec(command).args).toEqual(["test", "-count=1", "-v", "./..."]);
  for (const output of ["ok\texample.test/pkg\t(cached)\n", "=== RUN   TestValue\n--- PASS: TestValue (0.00s)\nPASS\nok\texample.test/pkg\t(cached)\n", "ok\texample.test/pkg\t0.003s\n", "?\texample.test/pkg\t[no test files]\n"]) {
    expect(parseExecutedTestCounts(output, command, process.cwd())).toEqual({ passed: 0, failed: 0, total: 0 });
  }
  expect(parseExecutedTestCounts("=== RUN   TestValue\n--- PASS: TestValue (0.00s)\nPASS\nok\texample.test/pkg\t0.003s\n", command, process.cwd())).toEqual({ passed: 1, failed: 0, total: 1 });
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
