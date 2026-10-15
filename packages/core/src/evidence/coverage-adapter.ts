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
import type { CommandSpec } from "../sandbox/command-spec.js";
import { bunLcovReportPath, resolveLcovReportPath } from "./parsers/executed-counts.js";

export interface CoverageMeasurementContext {
  baselineCommitSha?: string;
  startedAt?: number;
  /** Container source prefix; only the trusted worker supplies this mapping. */
  sourceRoot?: string;
  /** Host-derived native `bun test --coverage --coverage-reporter=lcov` invocation. */
  executionSpec?: CommandSpec;
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

/**
 * Precomputes line numbers that are independently verifiable as non-executable
 * (comments, blank lines, multi-line interface/type declarations, pure punctuation).
 */
export function computeNonExecutableLines(lines: string[]): Set<number> {
  const nonExec = new Set<number>();
  let inBlockComment = false;
  let inTypeBlock = false;
  let typeBlockBraceDepth = 0;
  let inTypeAlias = false;
  let inTripleDoubleQuote = false;
  let inTripleSingleQuote = false;

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNum = idx + 1;
    const raw = lines[idx];
    const line = raw.trim();

    if (line === "") {
      nonExec.add(lineNum);
      continue;
    }

    // Python multiline triple-double-quote docstrings
    if (inTripleDoubleQuote) {
      nonExec.add(lineNum);
      if (line.includes('"""')) {
        inTripleDoubleQuote = false;
      }
      continue;
    }

    // Python multiline triple-single-quote docstrings
    if (inTripleSingleQuote) {
      nonExec.add(lineNum);
      if (line.includes("'''")) {
        inTripleSingleQuote = false;
      }
      continue;
    }

    if (inBlockComment) {
      if (line.includes("*/")) {
        inBlockComment = false;
        const afterComment = line.slice(line.indexOf("*/") + 2).trim();
        if (afterComment === "" || isIndependentlyNonExecutableSourceLine(afterComment)) {
          nonExec.add(lineNum);
        }
      } else {
        nonExec.add(lineNum);
      }
      continue;
    }

    // Check for start of Python triple-quote docstrings
    const tripleDoubleCount = (line.match(/"""/g) || []).length;
    if (tripleDoubleCount % 2 === 1) {
      nonExec.add(lineNum);
      inTripleDoubleQuote = true;
      continue;
    } else if (tripleDoubleCount >= 2 && line.startsWith('"""') && line.endsWith('"""')) {
      nonExec.add(lineNum);
      continue;
    }

    const tripleSingleCount = (line.match(/'''/g) || []).length;
    if (tripleSingleCount % 2 === 1) {
      nonExec.add(lineNum);
      inTripleSingleQuote = true;
      continue;
    } else if (tripleSingleCount >= 2 && line.startsWith("'''") && line.endsWith("'''")) {
      nonExec.add(lineNum);
      continue;
    }

    if (line.startsWith("/*")) {
      if (!line.includes("*/")) {
        nonExec.add(lineNum);
        inBlockComment = true;
      } else {
        // Strip block comment pairs and only exclude if remaining text is non-executable
        const stripped = line.replace(/\/\*[\s\S]*?\*\//g, "").trim();
        if (stripped === "" || isIndependentlyNonExecutableSourceLine(stripped)) {
          nonExec.add(lineNum);
        }
      }
      continue;
    }

    if (
      line.startsWith("//") ||
      line.startsWith("#") ||
      line.startsWith("--") ||
      line.startsWith("<!--") ||
      line.endsWith("-->")
    ) {
      nonExec.add(lineNum);
      continue;
    }

    if (inTypeBlock) {
      nonExec.add(lineNum);
      for (const char of line) {
        if (char === "{") typeBlockBraceDepth++;
        if (char === "}") {
          typeBlockBraceDepth--;
          if (typeBlockBraceDepth <= 0) {
            inTypeBlock = false;
            break;
          }
        }
      }
      continue;
    }

    if (inTypeAlias) {
      nonExec.add(lineNum);
      if (line.includes(";")) {
        inTypeAlias = false;
      }
      continue;
    }

    if (/^(?:export\s+)?interface\s+/.test(line)) {
      nonExec.add(lineNum);
      if (line.includes("{")) {
        typeBlockBraceDepth = 0;
        for (const char of line) {
          if (char === "{") typeBlockBraceDepth++;
          if (char === "}") typeBlockBraceDepth--;
        }
        if (typeBlockBraceDepth > 0) {
          inTypeBlock = true;
        }
      }
      continue;
    }

    if (/^(?:export\s+)?type\s+/.test(line)) {
      nonExec.add(lineNum);
      if (line.includes("{")) {
        typeBlockBraceDepth = 0;
        for (const char of line) {
          if (char === "{") typeBlockBraceDepth++;
          if (char === "}") typeBlockBraceDepth--;
        }
        if (typeBlockBraceDepth > 0) {
          inTypeBlock = true;
        }
      } else if (!line.includes(";")) {
        inTypeAlias = true;
      }
      continue;
    }

    if (/^[{}()[\];,]+$/.test(line)) {
      nonExec.add(lineNum);
      continue;
    }

    if (
      line.startsWith("import type ") ||
      line.startsWith("export type ") ||
      line.startsWith("declare ") ||
      line === "..."
    ) {
      nonExec.add(lineNum);
      continue;
    }
  }

  return nonExec;
}

/**
 * Detect lines that are independently known to be non-executable tokens or comments
 * across common programming languages (JS/TS, Python, Go, Rust, C/C++, Java).
 *
 * LCOV and statement coverage probes (Istanbul, V8, llvm-cov, coverage.py) do NOT
 * emit `DA:<line>,<hits>` records for comments, blank lines, type declarations, or
 * standalone structural brackets/delimiters. Excluding these lines from being treated
 * as "omitted executable lines" prevents false-negative UNAVAILABLE verdicts.
 */
export function isIndependentlyNonExecutableSourceLine(rawLine: string): boolean {
  const line = rawLine.trim();
  if (line === "") return true;

  // Single-line and multi-line comment delimiters (JS/TS, Go, Rust, C/C++, Java, Python, Shell, SQL, Lua)
  if (
    line.startsWith("//") ||
    line.startsWith("#") ||
    line.startsWith("/*") ||
    line.startsWith("*") ||
    line.endsWith("*/") ||
    line.startsWith("--") ||
    line.startsWith("<!--") ||
    line.endsWith("-->")
  ) {
    return true;
  }

  // Pure delimiters / structural brackets / semicolons / commas (e.g. `}`, `};`, `]`, `);`, `{`)
  if (/^[{}()[\];,]+$/.test(line)) {
    return true;
  }

  // TypeScript / Flow compile-time type-only annotations erased at runtime
  if (
    line.startsWith("import type ") ||
    line.startsWith("export type ") ||
    line.startsWith("type ") ||
    line.startsWith("interface ") ||
    line.startsWith("declare ") ||
    /^export\s+interface\s+/.test(line)
  ) {
    return true;
  }

  // Python docstrings or placeholders (pass is excluded as it is an executable statement)
  if (
    line === '"""' ||
    line === "'''" ||
    (line.startsWith('"""') && line.endsWith('"""') && line.length > 3) ||
    (line.startsWith("'''") && line.endsWith("'''") && line.length > 3) ||
    line === "..."
  ) {
    return true;
  }

  return false;
}

/** LCOV executable line hits intersected with the actual base-to-workspace diff. */
export class LcovChangedLineCoverageAdapter implements TestCoverageAdapter {
  readonly name = "lcov-changed-lines";
  readonly scope = "changed-lines";

  constructor(private readonly fileName?: string) {}

  async resolve(cwd: string, context: CoverageMeasurementContext = {}): Promise<number | undefined> {
    if (context.startedAt === undefined) return undefined;
    let reportPath = this.fileName;
    if (!reportPath && context.executionSpec) {
      reportPath = resolveLcovReportPath(context.executionSpec, cwd);
    }
    if (!reportPath || (this.fileName !== undefined && resolve(cwd, reportPath) !== resolve(cwd, this.fileName))) return undefined;
    const report = readReport(cwd, reportPath, context.startedAt);
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
        } else if (line && !/^TN:[^\0]*$/.test(line)) {
          if (!record) return undefined;
          const numeric = /^(?:FNF|FNH|LF|LH|BRF|BRH):(\d+)$/.exec(line);
          if (numeric) {
            if (!Number.isSafeInteger(Number(numeric[1]))) return undefined;
          } else if (!/^FN:\d+,(?:\d+,)?[^\0]+$/.test(line) &&
              !/^FNDA:\d+,[^\0]+$/.test(line) && !/^BRDA:\d+,\d+,\d+,(?:\d+|-)$/.test(line)) return undefined;
        }
      }
      if (record) return undefined;
      const git = (args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 64 * 1024 * 1024 });
      const diff = git(["-c", "core.quotepath=false", "diff", "--no-ext-diff", "--no-renames", "--unified=0", context.baselineCommitSha ?? "HEAD", "--"]);
      const changed = new Map<string, Set<number>>();
      const eligible = (file: string) => !isSupportingFile(file) && isEligibleSourceCodeFile(file);
      let current: string | undefined;
      let fileHeader = false;
      for (const line of diff.split(/\r?\n/)) {
        if (line.startsWith("diff --git ")) {
          current = undefined;
          fileHeader = false;
        } else if (line.startsWith("--- ") && current === undefined) {
          fileHeader = true;
        } else if (line.startsWith("+++ ") && fileHeader) {
          const raw = line.slice(4);
          const file = (raw.startsWith('"') ? JSON.parse(raw) : raw).replace(/^b\//, "");
          current = eligible(file) ? file : undefined;
          fileHeader = false;
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
        const lines = readFileSync(containedPath(cwd, file)!, "utf8").split(/\r?\n/);
        const nonExecLines = computeNonExecutableLines(lines);
        for (const number of numbers) {
          if (!hits.has(number)) {
            // A report cannot establish that omitted source is non-executable unless
            // the source line is independently verifiable as non-executable (e.g. comments,
            // blank lines, type declarations, structural brackets).
            if (nonExecLines.has(number) || isIndependentlyNonExecutableSourceLine(lines[number - 1] ?? "")) continue;
            return undefined;
          }
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
