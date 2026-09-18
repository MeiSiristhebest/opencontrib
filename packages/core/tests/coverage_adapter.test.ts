import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  IstanbulSummaryCoverageAdapter,
  NoopCoverageAdapter,
  type TestCoverageAdapter,
} from "../src/evidence/coverage-adapter.js";

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
  test("reads total.pct.lines from coverage-summary.json", () =>
    withTmpDir(async (dir) => {
      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({
          total: { pct: { lines: 91.4, branches: 88, functions: 90 } },
        }),
      );
      const adapter = new IstanbulSummaryCoverageAdapter();
      expect(await adapter.resolve(dir)).toBe(91);
    }));

  test("clamps out-of-range percentages to 0-100", () =>
    withTmpDir(async (dir) => {
      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({ total: { pct: { lines: 140 } } }),
      );
      const high = new IstanbulSummaryCoverageAdapter();
      expect(await high.resolve(dir)).toBe(100);

      writeFileSync(
        join(dir, "coverage-summary.json"),
        JSON.stringify({ total: { pct: { lines: -12 } } }),
      );
      expect(await high.resolve(dir)).toBe(0);
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

  test("returns undefined when total.pct.lines is absent", () =>
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
        JSON.stringify({ total: { pct: { lines: 85 } } }),
      );
      const adapter = new IstanbulSummaryCoverageAdapter("my-coverage.json");
      expect(await adapter.resolve(dir)).toBe(85);
    }));
});

describe("NoopCoverageAdapter", () => {
  test("always resolves to undefined", async () => {
    const adapter: TestCoverageAdapter = new NoopCoverageAdapter();
    expect(await adapter.resolve("/does/not/matter")).toBeUndefined();
    expect(adapter.name).toBe("noop");
  });
});
