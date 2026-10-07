/**
 * Generic test-coverage adapters for evidence collection.
 *
 * Runner reports are read after GREEN. The canonical measurement intersects
 * LCOV line hits with actual source changes; missing reports are UNAVAILABLE.
 */
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { execFileSync } from "node:child_process";
import { isSupportingFile } from "../domain/governance.js";
import { isEligibleSourceCodeFile } from "../probe/forensics.js";

export interface CoverageMeasurementContext {
  baselineCommitSha?: string;
  startedAt?: number;
  /** Container source prefix; only the trusted worker supplies this mapping. */
  sourceRoot?: string;
}

/**
 * Resolves the changed-code test-coverage percentage from a workspace after
 * test execution. Returns undefined (not 0, not a guess) when no usable
 * coverage data exists.
 */
export interface TestCoverageAdapter {
  readonly name: string;
  readonly scope?: "changed-lines" | "whole-project";
  resolve(cwd: string, context?: CoverageMeasurementContext): Promise<number | undefined>;
}

function containedPath(cwd: string, file: string): string | undefined {
  const root = realpathSync(cwd);
  const target = realpathSync(resolve(cwd, file));
  const path = relative(root, target);
  return path && !isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`) ? target : undefined;
}

function readReport(cwd: string, file: string, startedAt?: number): string | undefined {
  try {
    if (isAbsolute(file)) return undefined;
    const target = containedPath(cwd, file);
    if (!target) return undefined;
    const stat = statSync(target);
    if (!stat.isFile() || stat.size > 64 * 1024 * 1024 || (startedAt !== undefined && stat.mtimeMs < startedAt)) return undefined;
    return readFileSync(target, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Reads an Istanbul/nyc-style `coverage-summary.json`
 * (`total.lines.pct`) produced by the test runner in the workspace.
 * This whole-project measurement cannot satisfy changed-line coverage policy.
 */
export class IstanbulSummaryCoverageAdapter implements TestCoverageAdapter {
  readonly name = "istanbul-summary";
  readonly scope = "whole-project";

  constructor(private readonly fileName: string = "coverage-summary.json") {}

  async resolve(cwd: string): Promise<number | undefined> {
    let raw: unknown;
    try {
      raw = JSON.parse(readReport(cwd, this.fileName) ?? "");
    } catch {
      return undefined;
    }
    const total = (raw as { total?: { lines?: { pct?: unknown } } })?.total;
    const pct = total?.lines?.pct;
    if (typeof pct !== "number" || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      return undefined;
    }
    return pct;
  }
}

/** LCOV executable line hits intersected with the actual base-to-workspace diff. */
export class LcovChangedLineCoverageAdapter implements TestCoverageAdapter {
  readonly name = "lcov-changed-lines";
  readonly scope = "changed-lines";

  constructor(private readonly fileName = "coverage/lcov.info") {}

  async resolve(cwd: string, context: CoverageMeasurementContext = {}): Promise<number | undefined> {
    const report = readReport(cwd, this.fileName, context.startedAt);
    if (!report) return undefined;
    try {
      const sourceFiles = new Map<string, Map<number, number>>();
      let path: string | undefined;
      let record: Map<number, number> | undefined;
      for (const line of report.split(/\r?\n/)) {
        if (line.startsWith("SF:")) {
          if (record) return undefined;
          let source = line.slice(3).replace(/\\/g, "/");
          if (context.sourceRoot && source.startsWith(`${context.sourceRoot}/`)) source = source.slice(context.sourceRoot.length + 1);
          const target = containedPath(cwd, source);
          if (!target) return undefined;
          path = relative(realpathSync(cwd), target).replace(/\\/g, "/");
          record = new Map();
        } else if (line.startsWith("DA:")) {
          const match = /^DA:(\d+),(\d+)(?:,[^,]+)?$/.exec(line);
          if (!record || !match) return undefined;
          const number = Number(match[1]);
          const hits = Number(match[2]);
          if (!Number.isSafeInteger(number) || number < 1 || !Number.isSafeInteger(hits) || record.has(number)) return undefined;
          record.set(number, hits);
        } else if (line === "end_of_record") {
          if (!path || !record) return undefined;
          const accumulated = sourceFiles.get(path) ?? new Map<number, number>();
          for (const [number, hits] of record) accumulated.set(number, Math.max(accumulated.get(number) ?? 0, hits));
          sourceFiles.set(path, accumulated);
          record = undefined;
          path = undefined;
        }
      }
      if (record) return undefined;
      const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
      const diff = git(["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-renames", "--unified=0", context.baselineCommitSha ?? "HEAD", "--"]);
      const changed = new Map<string, Set<number>>();
      const eligible = (file: string) => !isSupportingFile(file) && isEligibleSourceCodeFile(file);
      let current: string | undefined;
      for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("+++ ")) {
          const raw = line.slice(4);
          const file = (raw.startsWith('"') ? JSON.parse(raw) : raw).replace(/^b\//, "");
          current = eligible(file) ? file : undefined;
        } else if (current && line.startsWith("@@ ")) {
          const match = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line);
          if (!match) return undefined;
          const numbers = changed.get(current) ?? new Set<number>();
          const start = Number(match[1]);
          const count = match[2] === undefined ? 1 : Number(match[2]);
          for (let number = start; number < start + count; number++) numbers.add(number);
          if (numbers.size) changed.set(current, numbers);
        }
      }
      for (const file of git(["ls-files", "--others", "--exclude-standard", "-z"]).split("\0")) {
        if (!eligible(file)) continue;
        const target = containedPath(cwd, file);
        if (!target) return undefined;
        const content = readFileSync(target, "utf8");
        const count = content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
        changed.set(file, new Set(Array.from({ length: count }, (_, index) => index + 1)));
      }
      let total = 0;
      let covered = 0;
      for (const [file, numbers] of changed) {
        const hits = sourceFiles.get(file);
        if (!hits) return undefined;
        for (const number of numbers) {
          if (!hits.has(number)) continue; // LCOV omits non-executable lines.
          total++;
          if (hits.get(number)! > 0) covered++;
        }
      }
      return total ? covered * 100 / total : undefined;
    } catch {
      return undefined;
    }
  }
}

/** Explicit no-coverage adapter (the runner produces no coverage artifact). */
export class NoopCoverageAdapter implements TestCoverageAdapter {
  readonly name = "noop";
  readonly scope = "changed-lines";

  async resolve(): Promise<undefined> {
    return undefined;
  }
}
