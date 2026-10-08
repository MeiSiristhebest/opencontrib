import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  IstanbulSummaryCoverageAdapter,
  LcovChangedLineCoverageAdapter,
  NoopCoverageAdapter,
  type TestCoverageAdapter,
} from "../src/evidence/coverage-adapter.js";
import { getCoverageMeasurementStatus } from "../src/evidence/evidence-collector.js";
import { prepareTestExecutionSpec } from "../src/evidence/parsers/executed-counts.js";

function withTmpDir<T>(fn: (dir: string) => Promise<T> | T): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "oc-coverage-"));
  return Promise.resolve()
    .then(() => fn(dir))
    .catch((error) => {
      rmSync(dir, { recursive: true, force: true });
      throw error;
    })
    .then((result) => {
      rmSync(dir, { recursive: true, force: true });
      return result;
    });
}

describe("IstanbulSummaryCoverageAdapter", () => {
  test("reads total.lines.pct without rounding across the policy threshold", () =>
    withTmpDir(async (dir) => {
      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({
          total: { lines: { pct: 84.9 } },
        }),
      );
      const adapter = new IstanbulSummaryCoverageAdapter();
      expect(await adapter.resolve(dir)).toBe(84.9);
      expect(adapter.scope).toBe("whole-project");
    }));

  test("rejects out-of-range percentages", () =>
    withTmpDir(async (dir) => {
      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({ total: { lines: { pct: 140 } } }),
      );
      const high = new IstanbulSummaryCoverageAdapter();
      expect(await high.resolve(dir)).toBeUndefined();

      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({ total: { lines: { pct: -12 } } }),
      );
      expect(await high.resolve(dir)).toBeUndefined();
    }));

  test("returns undefined for a missing file (no invented numbers)", () =>
    withTmpDir(async (dir) => {
      const adapter = new IstanbulSummaryCoverageAdapter();
      expect(await adapter.resolve(dir)).toBeUndefined();
    }));

  test("returns undefined for malformed JSON", () =>
    withTmpDir(async (dir) => {
      writeFileSync(join(dir, "coverage-summary.json"), "{ not json ]");
      const adapter = new IstanbulSummaryCoverageAdapter();
      expect(await adapter.resolve(dir)).toBeUndefined();
    }));

  test("returns undefined when total.lines.pct is absent", () =>
    withTmpDir(async (dir) => {
      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({ files: {} }),
      );
      const adapter = new IstanbulSummaryCoverageAdapter();
      expect(await adapter.resolve(dir)).toBeUndefined();
    }));

  test("supports a custom artifact file name", () =>
    withTmpDir(async (dir) => {
      writeFileSync(
        join(dir, "my-coverage.json"),
        JSON.stringify({ total: { lines: { pct: 85 } } }),
      );
      const adapter = new IstanbulSummaryCoverageAdapter("my-coverage.json");
      expect(await adapter.resolve(dir)).toBe(85);
    }));
});

describe("LCOV changed-line coverage", () => {
  const executionContext = { startedAt: 0, executionSpec: prepareTestExecutionSpec("bun test --coverage --coverage-reporter=lcov") };
  function prepare(dir: string, reportPath = "coverage/lcov.info") {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    writeFileSync(join(dir, ".gitignore"), "coverage/\n");
    writeFileSync(join(dir, "value.ts"), "export const value = 1;\nexport const other = 1;\nexport const unchanged = 1;\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-qm", "baseline"], { cwd: dir });
    writeFileSync(join(dir, "value.ts"), "export const value = 2;\nexport const other = 2;\nexport const unchanged = 1;\n");
    const file = join(dir, reportPath);
    mkdirSync(dirname(file), { recursive: true });
    return file;
  }

  test("counts changed executable source lines and includes newly created source files", () => withTmpDir(async dir => {
    const file = prepare(dir);
    writeFileSync(join(dir, "added.ts"), "export const added = 1;\n");
    writeFileSync(join(dir, "value.test.ts"), "test('regression', () => {});\n");
    writeFileSync(file, "SF:value.ts\nDA:1,1\nDA:2,0\nDA:3,0\nend_of_record\nSF:added.ts\nDA:1,1\nend_of_record\n");
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, executionContext)).toBe(200 / 3);
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir)).toBeUndefined();
  }));

  test("reads a custom LCOV path selected by the trusted Bun command", () => withTmpDir(async dir => {
    const file = prepare(dir, "reports/lcov.info");
    const executionSpec = prepareTestExecutionSpec(
      "bun test --coverage --coverage-reporter=lcov --coverage-dir=reports",
      dir,
    );
    writeFileSync(file, "SF:value.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n");
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, {
      startedAt: 0,
      executionSpec,
    })).toBe(100);
  }));

  test("does not treat added source text beginning with plus signs as a file header", () => withTmpDir(async dir => {
    const file = prepare(dir);
    writeFileSync(join(dir, "value.ts"), 'export const value = 2;\nexport const other = 2;\nexport const unchanged = 1;\nexport const marker = "++ text";\n');
    writeFileSync(file, "SF:value.ts\nDA:1,1\nDA:2,1\nDA:3,0\nDA:4,1\nend_of_record\n");
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, executionContext)).toBe(100);
  }));

  test("rejects missing source records, invalid counts, and incomplete LCOV", () => withTmpDir(async dir => {
    const file = prepare(dir);
    for (const report of [
      "SF:other.ts\nDA:1,1\nend_of_record\n",
      "SF:value.ts\nDA:1,1\nDA:2,-1\nend_of_record\n",
      "SF:value.ts\nDA:1,1\nDA:2,1\nUNKNOWN:1\nend_of_record\n",
      "SF:value.ts\nDA:1,1\n",
    ]) {
      writeFileSync(file, report);
      expect(await new LcovChangedLineCoverageAdapter().resolve(dir, executionContext)).toBeUndefined();
    }
  }));

  test("does not remove an omitted changed executable line from the denominator", () => withTmpDir(async dir => {
    const file = prepare(dir);
    writeFileSync(file, "SF:value.ts\nDA:1,1\nend_of_record\n");
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, executionContext)).toBeUndefined();
  }));

  test("includes production filenames that contain the word test", () => withTmpDir(async dir => {
    const file = prepare(dir);
    writeFileSync(join(dir, "latest.ts"), "export const latest = 1;\n");
    writeFileSync(join(dir, "contest.ts"), "export const contest = 1;\n");
    writeFileSync(file, "SF:value.ts\nDA:1,1\nDA:2,1\nDA:3,0\nend_of_record\n");
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, executionContext)).toBeUndefined();
  }));

  test("rejects stale reports and paths outside the workspace", () => withTmpDir(async dir => {
    const file = prepare(dir);
    writeFileSync(file, "SF:value.ts\nDA:1,1\nDA:2,1\nend_of_record\n");
    utimesSync(file, new Date(0), new Date(0));
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, { ...executionContext, startedAt: Date.now() })).toBeUndefined();
    expect(await new LcovChangedLineCoverageAdapter("../coverage/lcov.info").resolve(dir, executionContext)).toBeUndefined();
    writeFileSync(file, "SF:../value.ts\nDA:1,1\nend_of_record\n");
    expect(await new LcovChangedLineCoverageAdapter().resolve(dir, executionContext)).toBeUndefined();
  }));
});

describe("Evidence coverage measurement status", () => {
  test("does not apply a hardcoded threshold", () => {
    expect(getCoverageMeasurementStatus(75)).toBe("PASS");
    expect(getCoverageMeasurementStatus(0)).toBe("PASS");
    expect(getCoverageMeasurementStatus(undefined)).toBe("UNAVAILABLE");
  });
});

describe("NoopCoverageAdapter", () => {
  test("always resolves to undefined", async () => {
    const adapter: TestCoverageAdapter = new NoopCoverageAdapter();
    expect(await adapter.resolve("/does/not/matter")).toBeUndefined();
    expect(adapter.name).toBe("noop");
  });
});
