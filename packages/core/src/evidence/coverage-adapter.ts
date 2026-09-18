/**
 * Generic test-coverage adapters for evidence collection.
 *
 * The governance technical gate consumes `testCoveragePercent` from the
 * canonical evidence report, but the collector itself cannot know how a
 * repository measures coverage. Adapters are the generic seam: they read a
 * coverage artifact the test runner already produced (in the workspace
 * after execution) and map it to a 0-100 percent. No adapter = coverage is
 * explicitly UNAVAILABLE (fail-closed reporting, no invented numbers).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Resolves the changed-code test-coverage percentage from a workspace after
 * test execution. Returns undefined (not 0, not a guess) when no usable
 * coverage data exists.
 */
export interface TestCoverageAdapter {
  readonly name: string;
  resolve(cwd: string): Promise<number | undefined>;
}

/**
 * Reads an Istanbul/nyc-style `coverage-summary.json`
 * (`total.pct.lines`) produced by the test runner in the workspace.
 */
export class IstanbulSummaryCoverageAdapter implements TestCoverageAdapter {
  readonly name = "istanbul-summary";

  constructor(private readonly fileName: string = "coverage-summary.json") {}

  async resolve(cwd: string): Promise<number | undefined> {
    const file = join(cwd, this.fileName);
    if (!existsSync(file)) {
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(file, "utf8"));
    } catch {
      return undefined;
    }
    const total = (raw as { total?: { pct?: { lines?: unknown } } })?.total;
    const pct = total?.pct?.lines;
    if (typeof pct !== "number" || Number.isNaN(pct)) {
      return undefined;
    }
    return Math.min(100, Math.max(0, Math.round(pct)));
  }
}

/** Explicit no-coverage adapter (the runner produces no coverage artifact). */
export class NoopCoverageAdapter implements TestCoverageAdapter {
  readonly name = "noop";

  async resolve(): Promise<undefined> {
    return undefined;
  }
}
