import { createHash } from "crypto";
import { execSync } from "child_process";
import {
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  existsSync,
} from "node:fs";
import { join, relative, resolve, sep } from "path";
import {
  defaultSandboxRuntime,
  type SandboxExecutionResult,
} from "../sandbox/sandbox-runtime.js";
import { parseCommandSpec } from "../sandbox/command-spec.js";
import type {
  EvidenceReport,
  FlakyTestRecord,
  RedEvidence,
  GreenEvidence,
  TestIdentity,
  TestIdentityFile,
} from "../contracts/schemas.js";
import { defaultTestOutputParserRegistry } from "./parsers/registry.js";
import { defaultVcsDeltaAdapter, type VcsDeltaPort } from "./vcs-delta.port.js";
import type { TestCoverageAdapter } from "./coverage-adapter.js";

export interface EvidenceCollectionOptions {
  cwd: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
  testCommand: string;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
  runFlakyBaseline?: boolean;
  /** Trusted coverage adapter result; absence is explicitly UNAVAILABLE. */
  changedCodeCoveragePercent?: number;
  /**
   * Generic seam for coverage measurement: the adapter resolves a 0-100
   * percentage from a coverage artifact the runner already produced.
   * A caller-supplied changedCodeCoveragePercent always wins; without
   * either, coverage is reported UNAVAILABLE (no invented numbers).
   */
  coverageAdapter?: TestCoverageAdapter;
  redEvidence?: RedEvidence;
}

export interface DualStageReproductionResult {
  preFixFailingAssertionCaptured: boolean;
  preFixOutput: string;
  postFixPassed: boolean;
  postFixOutput: string;
  isReproductionVerified: boolean;
  stressLoopPassed: boolean;
  completedRuns: number;
}

export function getProcessHandleCount(): number | null {
  try {
    if (process.platform === "win32") {
      const res = defaultSandboxRuntime.executeInSandbox({
        cwd: process.cwd(),
        command: "powershell",
        args: [
          "-NoProfile",
          "-Command",
          `(Get-Process -Id ${process.pid}).HandleCount`,
        ],
        timeoutMs: 4000,
        allowHostFallback: true,
      });
      const val = parseInt(res.stdout.trim(), 10);
      return Number.isFinite(val) && val > 0 ? val : null;
    } else {
      const res = defaultSandboxRuntime.executeInSandbox({
        cwd: process.cwd(),
        command: "lsof",
        args: ["-p", process.pid.toString()],
        timeoutMs: 4000,
        allowHostFallback: true,
      });
      const lines = res.stdout.trim().split("\n").filter(Boolean);
      return lines.length > 0 ? lines.length : null;
    }
  } catch {
    return null;
  }
}

export function parseTestCountsFromOutput(output: string): {
  passed: number;
  failed: number;
  total: number;
} {
  return defaultTestOutputParserRegistry.parse(output);
}

export function recordFlakyBaseline(
  cwd: string,
  testCommand: string,
  runs: number = 3,
  workspaceRoot?: string,
): FlakyTestRecord[] {
  const testRunResults = new Map<
    string,
    { runCount: number; failCount: number }
  >();
  const spec = parseCommandSpec(testCommand);

  for (let i = 0; i < runs; i++) {
    const res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      commandSpec: spec,
      timeoutMs: 30000,
    });

    if (!res.passed) {
      const full = res.output;
      const failureMatches =
        full.match(/(?:FAIL|✕|FAILED)\s+([^\r\n]+)/g) || [];
      for (const f of failureMatches) {
        const testName = f.replace(/^(?:FAIL|✕|FAILED)\s+/, "").trim();
        const current = testRunResults.get(testName) || {
          runCount: 0,
          failCount: 0,
        };
        current.runCount++;
        current.failCount++;
        testRunResults.set(testName, current);
      }
    }
  }

  const flakyRecords: FlakyTestRecord[] = [];
  for (const [testName, stats] of testRunResults.entries()) {
    flakyRecords.push({
      testName,
      runCount: runs,
      failCount: stats.failCount,
      isFlakyOnBaseline: stats.failCount > 0 && stats.failCount < runs,
    });
  }

  return flakyRecords;
}

export interface StressLoopResult {
  passed: boolean;
  completedRuns: number;
  executionCount: number;
  maxConcurrentObserved: number;
  lastOutput: string;
  concurrencyWorkers: number;
  concurrencyStampedePassed: boolean;
  raceCollisionsDetected: number;
  latencyJitterMs: number;
}

/**
 * The only canonical stress runner. Every execution is asynchronous and the
 * worker batch is released through a barrier before Promise.all awaits it.
 */
export async function runStressLoopAsync(
  cwd: string,
  testCommand: string,
  count?: number,
  workspaceRoot?: string,
  concurrencyWorkers: number = 1,
): Promise<StressLoopResult> {
  let completedRuns = 0;
  let executionCount = 0;
  let maxConcurrentObserved = 0;
  let inFlight = 0;
  let lastOutput = "";
  let raceCollisions = 0;
  const latencies: number[] = [];

  const isBroadSuite =
    testCommand.includes("./...") ||
    testCommand.includes("npm test") ||
    testCommand.includes("bun test") ||
    testCommand.trim() === "pytest" ||
    testCommand.trim() === "cargo test";
  const targetCount = count ?? (isBroadSuite ? 1 : 3);
  const spec = parseCommandSpec(testCommand);

  const executeOne = async () => {
    executionCount++;
    inFlight++;
    maxConcurrentObserved = Math.max(maxConcurrentObserved, inFlight);
    const start = Date.now();
    try {
      const res = await defaultSandboxRuntime.executeAsync({
        cwd,
        workspaceRoot,
        commandSpec: spec,
        timeoutMs: 30000,
      });
      return {
        passed: res.passed,
        output: res.output,
        elapsed: Date.now() - start,
      };
    } finally {
      inFlight--;
    }
  };

  const workerCount = Math.max(1, concurrencyWorkers);
  let results: Array<{ passed: boolean; output: string; elapsed: number }>;
  if (workerCount > 1) {
    let releaseBarrier!: () => void;
    const startBarrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const workers = Array.from({ length: workerCount }, async () => {
      await startBarrier;
      return executeOne();
    });
    // All workers have been created and are waiting before the barrier opens.
    releaseBarrier();
    results = await Promise.all(workers);
  } else {
    results = [];
    for (let index = 0; index < targetCount; index++) {
      const result = await executeOne();
      results.push(result);
      if (!result.passed) break;
    }
  }

  let allPassed = true;
  for (const result of results) {
    latencies.push(result.elapsed);
    lastOutput = result.output;
    if (result.passed) completedRuns++;
    else {
      allPassed = false;
      if (
        /data race|race detected|concurrent map|deadlock|collision/i.test(
          result.output,
        )
      ) {
        raceCollisions++;
      }
    }
  }

  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
  const concurrencyStampedePassed =
    allPassed &&
    raceCollisions === 0 &&
    (workerCount === 1 || maxConcurrentObserved >= workerCount);

  return {
    passed: allPassed,
    completedRuns,
    executionCount,
    maxConcurrentObserved,
    lastOutput,
    concurrencyWorkers: workerCount,
    concurrencyStampedePassed,
    raceCollisionsDetected: raceCollisions,
    latencyJitterMs: maxLatency - minLatency,
  };
}

export function verifyEmpiricalReproduction(input: {
  cwd: string;
  workspaceRoot?: string;
  reproductionScriptPath?: string;
  testCommand?: string;
  runnerCommand?: string;
}): {
  isFailingOnBaseline: boolean;
  baselineOutput: string;
  assertionCaptured: boolean;
  exitCode?: number;
} {
  const {
    cwd,
    workspaceRoot,
    reproductionScriptPath,
    testCommand,
    runnerCommand = "bun",
  } = input;

  let res: SandboxExecutionResult;
  if (reproductionScriptPath) {
    res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      command: runnerCommand,
      args: [reproductionScriptPath],
      timeoutMs: 15000,
    });
  } else if (testCommand) {
    const spec = parseCommandSpec(testCommand);
    res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      commandSpec: spec,
      timeoutMs: 20000,
    });
  } else {
    return {
      isFailingOnBaseline: false,
      baselineOutput: "No reproduction script or test command provided.",
      assertionCaptured: false,
    };
  }

  const full = res.output;
  // Guard against common false positives such as "0 errors", "0 failed", or benign mentions of error handling
  const isFalsePositiveZeroError =
    /\b0\s+(errors?|failed|failures)\b/i.test(full) &&
    !/\b[1-9]\d*\s+(errors?|failed|failures)\b/i.test(full);
  const isRealFailurePattern =
    /(?:BUG CONFIRMED|\bFAILED\b|\bFAIL\b|assertion failed|\berror:|TypeError:|AssertionError:|panic:|\bstack trace:)/i.test(
      full,
    );

  const hasFailureFlag =
    !res.passed || (isRealFailurePattern && !isFalsePositiveZeroError);

  let exitCode = res.exitCode;
  if (exitCode === null) exitCode = hasFailureFlag ? 1 : 0;
  return {
    isFailingOnBaseline: hasFailureFlag,
    baselineOutput: full,
    assertionCaptured: hasFailureFlag,
    exitCode,
  };
}

export function matchExpectedFailure(input: {
  output: string;
  pattern?: string;
  mode?: "regex" | "literal";
}): { matched: boolean; expected?: string; observedSnippet?: string } {
  const { output, pattern, mode = "regex" } = input;
  if (!pattern || pattern.trim().length === 0) {
    return { matched: true };
  }

  const cleanPattern = pattern.trim();
  if (mode === "literal") {
    const matched = output.includes(cleanPattern);
    return {
      matched,
      expected: cleanPattern,
      observedSnippet: output.slice(0, 500),
    };
  }

  try {
    const rx = new RegExp(cleanPattern, "i");
    const matched = rx.test(output);
    return {
      matched,
      expected: cleanPattern,
      observedSnippet: output.slice(0, 500),
    };
  } catch {
    const matched = output.includes(cleanPattern);
    return {
      matched,
      expected: cleanPattern,
      observedSnippet: output.slice(0, 500),
    };
  }
}

export function capturePreFixAssertion(
  cwd: string,
  testCommand: string,
  workspaceRoot?: string,
  expectedAssertion?: string,
) {
  const repro = verifyEmpiricalReproduction({
    cwd,
    testCommand,
    workspaceRoot,
  });
  if (!repro.assertionCaptured) {
    return repro;
  }

  if (expectedAssertion) {
    const match = matchExpectedFailure({
      output: repro.baselineOutput,
      pattern: expectedAssertion,
    });
    return {
      ...repro,
      assertionCaptured: repro.assertionCaptured && match.matched,
      expectedAssertionMatched: match.matched,
      exitCode: repro.exitCode,
    };
  }

  return repro;
}

/** Deterministic ASCII comparator (locale-independent) for hash stability. */
function byAsciiOrder(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function parsePorcelainV1ZForHash(
  output: string,
): Array<{ status: string; path: string }> {
  const tokens = output.split("\0");
  const records: Array<{ status: string; path: string }> = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4 || token[2] !== " ") continue;
    const status = token.slice(0, 2);
    const firstPath = token.slice(3);
    if (!firstPath) continue;
    if (status.includes("R") || status.includes("C")) {
      const nextPath = tokens[++index];
      if (nextPath) records.push({ status, path: nextPath });
    } else {
      records.push({ status, path: firstPath });
    }
  }
  return records;
}

/**
 * Compute a stable content fingerprint of the source tree at `cwd`.
 * In git repositories, hashes HEAD commit, index staging, unstaged tracked diff,
 * and contents of untracked files. Falls back to hashing all files deterministically
 * by relative path and content hash.
 */
export function computeSourceTreeHash(cwd: string): string {
  try {
    const gitHead = execSync("git rev-parse HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    const gitStatus = execSync(
      "git status --porcelain=v1 -z --untracked-files=all",
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const gitDiff = execSync("git diff --binary HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    // Content hashes of untracked files for true content immutability
    const untrackedHashes: string[] = [];
    const untrackedLines = parsePorcelainV1ZForHash(gitStatus)
      .filter((record) => record.status === "??")
      .map((record) => record.path);

    for (const rel of untrackedLines) {
      const full = join(cwd, rel);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) {
          // No-follow: bind the fingerprint to the link's target string, never
          // to the content the link points at (which may live outside the host).
          const target = readlinkSync(full);
          const h = createHash("sha256")
            .update(`symlink:${target}`)
            .digest("hex");
          untrackedHashes.push(`${rel}:symlink:${h}`);
        } else if (!st.isDirectory()) {
          const buf = readFileSync(full);
          const h = createHash("sha256").update(buf).digest("hex");
          untrackedHashes.push(`${rel}:${String(st.size)}:${h}`);
        }
      } catch {
        // Untracked file vanished or is unreadable at capture time — skip it;
        // the git status/diff lines still contribute to the fingerprint.
      }
    }
    untrackedHashes.sort(byAsciiOrder);

    const fingerprint = `git:${gitHead}\n${gitStatus}\n${gitDiff}\n${untrackedHashes.join("\n")}`;
    return createHash("sha256").update(fingerprint).digest("hex");
  } catch {
    try {
      const entries: string[] = [];
      const walk = (dir: string) => {
        let items: string[] = [];
        try {
          items = readdirSync(dir);
        } catch {
          return;
        }
        for (const item of items) {
          if (
            item === "node_modules" ||
            item === ".git" ||
            item.startsWith(".opencontrib")
          ) {
            continue;
          }
          const full = join(dir, item);
          let st: ReturnType<typeof statSync>;
          try {
            st = lstatSync(full);
          } catch {
            continue;
          }
          if (st.isSymbolicLink()) {
            // No-follow: hash the link target string, never the external file.
            try {
              const target = readlinkSync(full);
              const relPath = full
                .slice(cwd.length)
                .replace(/^[\\/]+/, "")
                .replace(/\\/g, "/");
              const linkHash = createHash("sha256")
                .update(`symlink:${target}`)
                .digest("hex");
              entries.push(`${relPath}:symlink:${linkHash}`);
            } catch {
              entries.push(`${item}:symlink:unreadable`);
            }
          } else if (st.isDirectory()) {
            walk(full);
          } else {
            try {
              const relPath = full
                .slice(cwd.length)
                .replace(/^[\\/]+/, "")
                .replace(/\\/g, "/");
              const fileContent = readFileSync(full);
              const fileHash = createHash("sha256")
                .update(fileContent)
                .digest("hex");
              entries.push(`${relPath}:${String(st.size)}:${fileHash}`);
            } catch {
              entries.push(`${item}:${String(st.size)}`);
            }
          }
        }
      };
      walk(cwd);
      entries.sort(byAsciiOrder);
      return createHash("sha256")
        .update(`fallback:${entries.join("\n")}`)
        .digest("hex");
    } catch {
      return "";
    }
  }
}

export function computeTestIdentityFingerprint(input: {
  testCommand: string;
  expectedAssertion?: string;
  testFileSha256?: string;
}): string {
  const normCmd = input.testCommand.trim().replace(/\s+/g, " ");
  const normAssert = (input.expectedAssertion || "").trim();
  const filePart = input.testFileSha256 || "";
  return createHash("sha256")
    .update(`identity:${normCmd}:${normAssert}:${filePart}`)
    .digest("hex");
}

/**
 * Extract the concrete test file path(s) a test command targets, and hash
 * their current on-disk contents. Deterministic between RED and GREEN because
 * both derive the same candidate paths from the same command string; only the
 * content sha256 changes if the Agent edits a test file in between.
 *
 * This closes the "same command, mutated test file" bypass: the identity
 * fingerprint is bound to test-file CONTENT, not just the command string.
 */
function isWithinDirectory(root: string, target: string): boolean {
  const rootPath = resolve(root);
  const targetPath = resolve(target);
  return targetPath === rootPath || targetPath.startsWith(`${rootPath}${sep}`);
}

function isLikelyTestFile(pathName: string): boolean {
  const normalized = pathName.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || normalized;
  return (
    /(?:^|\/)(?:tests?|__tests__|spec)(?:\/|$)/i.test(normalized) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(base) ||
    /(?:^|_)test\.(?:py|go|rs|rb|php)$/i.test(base) ||
    /^test_[^/]+\.py$/i.test(base) ||
    /Test\.(?:java|kt|cs)$/i.test(base)
  );
}

function addFileIdentity(
  cwd: string,
  candidate: string,
  files: Map<string, TestIdentityFile>,
): void {
  const full = resolve(cwd, candidate);
  if (!isWithinDirectory(cwd, full)) return;
  const normalizedPath = relative(cwd, full).replace(/\\/g, "/");
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) {
      // No-follow: a symlinked test file is bound to the link target string,
      // never to the content it points at (which may live outside the host).
      const target = readlinkSync(full);
      files.set(normalizedPath, {
        path: normalizedPath,
        sha256: createHash("sha256").update(`symlink:${target}`).digest("hex"),
      });
      return;
    }
    if (st.isDirectory()) {
      const entries = readdirSync(full, { withFileTypes: true });
      for (const entry of entries) {
        if (
          [
            "node_modules",
            ".git",
            ".opencontrib",
            "dist",
            "build",
            "coverage",
            "target",
          ].includes(entry.name)
        )
          continue;
        addFileIdentity(cwd, join(full, entry.name), files);
      }
      return;
    }
    if (!st.isFile()) return;
    const content = readFileSync(full);
    files.set(normalizedPath, {
      path: normalizedPath,
      sha256: createHash("sha256").update(content).digest("hex"),
    });
  } catch {
    // Missing explicit paths remain represented with an empty digest, so RED
    // and GREEN cannot silently switch to a different file.
    files.set(normalizedPath, { path: normalizedPath, sha256: "" });
  }
}

function discoverTestFiles(
  cwd: string,
  files: Map<string, TestIdentityFile>,
): void {
  // Walk once and retain only deterministic test candidates for broad commands.
  // only deterministic test candidates for broad commands.
  const discovered = new Map<string, TestIdentityFile>();
  const walk = (dir: string): void => {
    let entries: Array<{
      name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }> = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (
        [
          "node_modules",
          ".git",
          ".opencontrib",
          "dist",
          "build",
          "coverage",
          "target",
        ].includes(entry.name)
      )
        continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() || entry.isSymbolicLink()) {
        const pathName = relative(cwd, full).replace(/\\/g, "/");
        if (isLikelyTestFile(pathName)) addFileIdentity(cwd, full, discovered);
      }
    }
  };
  walk(cwd);
  for (const [pathName, identity] of discovered) files.set(pathName, identity);
}

export function resolveTestFiles(
  cwd: string,
  testCommand: string,
  explicitTestFile?: string | string[],
): TestIdentityFile[] {
  const spec = parseCommandSpec(testCommand);
  const candidates = new Set<string>();
  let explicit: string[] = [];
  if (Array.isArray(explicitTestFile)) explicit = explicitTestFile;
  else if (explicitTestFile) explicit = [explicitTestFile];
  for (const candidate of explicit)
    if (candidate.trim()) candidates.add(candidate.trim());

  const testFileToken =
    /\.(test|spec)\.[cm]?[jt]sx?$|\.(test|spec)\.py$|_test\.(?:go|rs)$|^test_[a-z0-9_.]+\.py$|\.test$|\.spec$/i;
  for (const token of spec.args) {
    const cleaned = token.replace(/^[^=]+=\s*/, "").trim();
    if (
      testFileToken.test(cleaned) ||
      cleaned.includes("/") ||
      cleaned.includes("\\") ||
      /^[A-Za-z]:/.test(cleaned)
    ) {
      candidates.add(cleaned);
    }
  }

  const files = new Map<string, TestIdentityFile>();
  for (const candidate of candidates) addFileIdentity(cwd, candidate, files);
  // Broad commands such as `bun test`, `pytest`, `cargo test`, and `npm test`
  // receive a deterministic repository test-file set rather than an empty
  // identity. If no set can be resolved, the phase gate remains unavailable.
  if (files.size === 0) discoverTestFiles(cwd, files);

  // Security: bind execution harness / test runner configuration files into execution identity
  // so agents cannot bypass tests by mutating npm scripts (e.g. "test": "echo PASS") or runner configs
  const harnessFiles = [
    "package.json",
    "vitest.config.ts",
    "vitest.config.js",
    "jest.config.js",
    "jest.config.ts",
    "pytest.ini",
    "pyproject.toml",
    "Cargo.toml",
  ];
  for (const hf of harnessFiles) {
    const full = resolve(cwd, hf);
    if (isWithinDirectory(cwd, full) && existsSync(full)) {
      addFileIdentity(cwd, hf, files);
    }
  }

  return [...files.values()].sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    return 0;
  });
}

/** Compute the stable TestIdentity for a test command at `cwd`. */
export function computeTestIdentity(
  cwd: string,
  testCommand: string,
  expectedAssertion?: string,
  explicitTestFile?: string | string[],
): TestIdentity {
  const normalizedCommand = testCommand.trim().replace(/\s+/g, " ");
  const testFiles = resolveTestFiles(cwd, testCommand, explicitTestFile);
  const normAssert = (expectedAssertion || "").trim();
  const filePart = testFiles.map((f) => `${f.path}:${f.sha256}`);
  const identitySha256 = createHash("sha256")
    .update(
      `testIdentity:${normalizedCommand}:${normAssert}:${filePart.join("|")}`,
    )
    .digest("hex");
  return {
    normalizedCommand,
    testFiles,
    expectedAssertion,
    identitySha256,
  };
}

/** Content-derived diff identity for test files; never caller supplied. */
export function computeTestFileDiffSha256(
  redFiles: TestIdentityFile[],
  greenFiles: TestIdentityFile[],
): string | undefined {
  const red = new Map(redFiles.map((file) => [file.path, file.sha256]));
  const green = new Map(greenFiles.map((file) => [file.path, file.sha256]));
  const paths = [...new Set([...red.keys(), ...green.keys()])].sort();
  const changes = paths.flatMap((path) => {
    const before = red.get(path) || "";
    const after = green.get(path) || "";
    return before === after ? [] : [`${path}:${before}->${after}`];
  });
  if (changes.length === 0) return undefined;
  return createHash("sha256")
    .update(`testDiff:${changes.join("|")}`)
    .digest("hex");
}

/**
 * Evidence V2 — capture an immutable RED baseline artifact.
 * Runs the test command once, records the observed failure, and binds the
 * current source tree hash so a later GREEN can be proven to have mutated the tree.
 */
export function captureRedEvidence(input: {
  cwd: string;
  testCommand: string;
  workspaceRoot?: string;
  expectedAssertion?: string;
  testFile?: string | string[];
  testFileSha256?: string;
  baselineCommitSha?: string;
  testMutationAllowed?: boolean;
}): RedEvidence {
  const preFix = capturePreFixAssertion(
    input.cwd,
    input.testCommand,
    input.workspaceRoot,
    input.expectedAssertion,
  );
  const assertionMatched = Boolean(preFix.assertionCaptured);
  const observedExitCode = (preFix as { exitCode?: number }).exitCode;
  let exitCode = observedExitCode;
  if (typeof exitCode !== "number") exitCode = assertionMatched ? 1 : 0;
  // Bind the concrete test-file CONTENT identity so GREEN must prove the same
  // test body went fail -> pass, not merely that the same command now passes.
  const testIdentity = computeTestIdentity(
    input.cwd,
    input.testCommand,
    input.expectedAssertion,
    input.testFile,
  );
  const assertionMatchedFingerprint = computeTestIdentityFingerprint({
    testCommand: input.testCommand,
    expectedAssertion: input.expectedAssertion,
  });
  if (
    input.testFileSha256 &&
    testIdentity.testFiles.length === 1 &&
    testIdentity.testFiles[0].sha256 !== input.testFileSha256
  ) {
    throw new Error(
      "EvidenceIdentityError: supplied testFileSha256 does not match the on-disk RED test file content.",
    );
  }

  return {
    command: input.testCommand,
    expectedAssertion: input.expectedAssertion,
    observedOutputSnippet: (
      (preFix as { baselineOutput?: string }).baselineOutput ?? ""
    ).slice(0, 500),
    exitCode,
    sourceTreeSha256: computeSourceTreeHash(input.cwd),
    testFileSha256:
      testIdentity.testFiles.length === 1
        ? testIdentity.testFiles[0].sha256
        : undefined,
    baselineCommitSha: input.baselineCommitSha,
    capturedAt: new Date().toISOString(),
    assertionMatched,
    assertionMatchedFingerprint,
    testIdentity,
    testMutationAllowed: input.testMutationAllowed,
  };
}

/** Build GREEN evidence from one already-completed asynchronous stress run. */
function buildGreenEvidenceFromStress(input: {
  cwd: string;
  testCommand: string;
  redEvidence: RedEvidence;
  stressResult: StressLoopResult;
}): {
  greenEvidence: GreenEvidence;
  reproductionVerified: boolean;
  allTestsPassing: boolean;
} {
  const { cwd, testCommand, redEvidence, stressResult } = input;
  const passed = stressResult.passed;
  const greenTreeHash = computeSourceTreeHash(cwd);
  const treeChanged = greenTreeHash !== redEvidence.sourceTreeSha256;
  const greenFingerprint = computeTestIdentityFingerprint({
    testCommand,
    expectedAssertion: redEvidence.expectedAssertion,
  });
  const explicitTestFiles =
    redEvidence.testIdentity?.testFiles.map((file) => file.path) || [];
  const greenTestIdentity = computeTestIdentity(
    cwd,
    testCommand,
    redEvidence.testIdentity?.expectedAssertion ??
      redEvidence.expectedAssertion,
    explicitTestFiles,
  );

  let testIdentityValid = false;
  let actualTestDiffSha256: string | undefined;
  if (redEvidence.testIdentity) {
    const redFiles = redEvidence.testIdentity.testFiles || [];
    const greenFiles = greenTestIdentity.testFiles || [];
    actualTestDiffSha256 = computeTestFileDiffSha256(redFiles, greenFiles);
    testIdentityValid =
      redFiles.length > 0 &&
      greenFiles.length > 0 &&
      greenTestIdentity.identitySha256 ===
        redEvidence.testIdentity.identitySha256;
    if (
      !testIdentityValid &&
      redEvidence.testMutationPolicy?.allowed === true &&
      actualTestDiffSha256 &&
      redEvidence.testMutationPolicy.expectedDiffSha256 === actualTestDiffSha256
    ) {
      testIdentityValid = true;
    }
  }

  const greenEvidence: GreenEvidence = {
    command: testCommand,
    exitCode: passed ? 0 : 1,
    outputSnippet: stressResult.lastOutput.slice(0, 500),
    passed,
    sourceTreeSha256: greenTreeHash,
    capturedAt: new Date().toISOString(),
    treeChangedComparedToRed: treeChanged,
    treeHashMatchesRed: !treeChanged,
    stressLoopPassed: stressResult.passed,
    allTestsPassing: passed,
    assertionMatchedFingerprint: greenFingerprint,
    testIdentity: greenTestIdentity,
    actualTestDiffSha256,
    appliedPatchSha256: "",
  };
  return {
    greenEvidence,
    reproductionVerified:
      redEvidence.assertionMatched === true &&
      passed &&
      treeChanged &&
      testIdentityValid,
    allTestsPassing: passed,
  };
}

/**
 * Evidence V2 — verify GREEN and bind it to a previously captured RedEvidence.
 * `reproductionVerified` is only true when the RED baseline assertion matched AND
 * the current run passes AND the source tree actually changed since the RED capture.
 */
export async function verifyGreenEvidence(input: {
  cwd: string;
  testCommand: string;
  workspaceRoot?: string;
  redEvidence: RedEvidence;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
}): Promise<{
  greenEvidence: GreenEvidence;
  reproductionVerified: boolean;
  allTestsPassing: boolean;
  stressResult: StressLoopResult;
}> {
  const { redEvidence } = input;
  const stressResult = await runStressLoopAsync(
    input.cwd,
    input.testCommand,
    input.stressLoopCount ?? 1,
    input.workspaceRoot,
    input.concurrencyWorkers ?? 1,
  );
  const result = buildGreenEvidenceFromStress({
    cwd: input.cwd,
    testCommand: input.testCommand,
    redEvidence,
    stressResult,
  });
  return { ...result, stressResult };
}

/**
 * Executes a full dual-stage empirical verification:
 * 1. Verifies pre-fix failure baseline (reproduction proof)
 * 2. Runs post-fix validation & stress loop (fix proof)
 */
export async function verifyDualStageReproduction(input: {
  cwd: string;
  workspaceRoot?: string;
  testCommand: string;
  preFixBaselineCaptured: boolean;
  preFixFailureOutput?: string;
  stressLoopCount?: number;
}): Promise<DualStageReproductionResult> {
  const {
    cwd,
    workspaceRoot,
    testCommand,
    preFixBaselineCaptured,
    preFixFailureOutput = "",
    stressLoopCount = 5,
  } = input;

  const stressResult = await runStressLoopAsync(
    cwd,
    testCommand,
    stressLoopCount,
    workspaceRoot,
  );
  const postFixPassed = stressResult.passed;

  // True empirical reproduction is verified when pre-fix had failure/assertion and post-fix passes all runs cleanly
  const isReproductionVerified = preFixBaselineCaptured && postFixPassed;

  return {
    preFixFailingAssertionCaptured: preFixBaselineCaptured,
    preFixOutput: preFixFailureOutput,
    postFixPassed,
    postFixOutput: stressResult.lastOutput,
    isReproductionVerified,
    stressLoopPassed: stressResult.passed,
    completedRuns: stressResult.completedRuns,
  };
}

export function parseAddedTestCasesFromDiffText(diffText: string): number {
  if (!diffText || typeof diffText !== "string") return 0;
  const addedLines = diffText
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"));
  // Comprehensive multi-language test case pattern:
  // - JS/TS: it(...), test(...)
  // - Python: def test_...(...)
  // - Go: func Test...(...)
  // - Rust: #[test], #[tokio::test]
  // - Java/Kotlin: @Test, @ParameterizedTest, fun test...(...)
  // - C#: [Fact], [Theory], [Test]
  // - C/C++: TEST(...), TEST_F(...)
  // - Ruby: it "...", specify "...", test "..."
  // - PHP: public function test...(...), #[Test]
  // - Swift: func test...(...)
  const testCasePattern =
    /^\+\s*(?:(?:it|test)(?:\.(?:skip|only|concurrent|todo|each))?\s*\(|def\s+test_[a-zA-Z0-9_]+\s*\(|func\s+Test[a-zA-Z0-9_]+\s*\(|#\[(?:tokio::)?test\]|@(?:Parameterized|Repeated)?Test\b|fun\s+test[a-zA-Z0-9_]*\s*\(|\[(?:Fact|Theory|Test|TestCase)\]|TEST(?:_[FP])?\s*\(|BOOST_AUTO_TEST_CASE\s*\(|(?:it|specify|test)\s+['"][^'"]+['"]|public\s+function\s+test[a-zA-Z0-9_]+\s*\(|func\s+test[a-zA-Z0-9_]+\s*\()/;
  // Comment pattern excludes //, /*, *, and # (except Rust/PHP attribute syntax #[...])
  const commentPattern = /^\+\s*(?:\/\/|\/\*|\*|#(?!\[))/;

  const matches = addedLines.filter(
    (l) => !commentPattern.test(l) && testCasePattern.test(l),
  );
  return matches.length;
}

export async function countAddedTestCasesFromGitDiff(
  cwd: string,
  baselineCommitSha?: string,
  vcsAdapter: VcsDeltaPort = defaultVcsDeltaAdapter,
): Promise<number | undefined> {
  const diffText = await vcsAdapter.getDiff({ cwd, baselineCommitSha });
  if (diffText !== undefined) {
    return parseAddedTestCasesFromDiffText(diffText);
  }
  return undefined;
}

export async function collectEvidence(
  options: EvidenceCollectionOptions,
  vcsAdapter: VcsDeltaPort = defaultVcsDeltaAdapter,
): Promise<EvidenceReport> {
  const {
    cwd,
    workspaceRoot,
    baselineCommitSha,
    testCommand,
    stressLoopCount = 1,
    concurrencyWorkers = 1,
    runFlakyBaseline = true,
    redEvidence,
  } = options;

  // Generic coverage adapter seam: an explicit caller-supplied percentage
  // always wins; otherwise ask the adapter (if any) for runner-produced
  // coverage data. Neither present => UNAVAILABLE downstream.
  let changedCodeCoveragePercent: number | undefined =
    options.changedCodeCoveragePercent;
  if (changedCodeCoveragePercent === undefined && options.coverageAdapter) {
    changedCodeCoveragePercent = await options.coverageAdapter.resolve(cwd);
  }

  // 1. Initial System Handle & FD Sampling
  const initialHandles = getProcessHandleCount();

  // 2. Step 4.0 Flaky Baseline Isolation
  const baselineFlakyTests = runFlakyBaseline
    ? recordFlakyBaseline(cwd, testCommand, 3, workspaceRoot)
    : [];

  // 3. Stress Test Loop (consecutive runs executed in sanitized sandbox)
  const stressResult = await runStressLoopAsync(
    cwd,
    testCommand,
    stressLoopCount,
    workspaceRoot,
    concurrencyWorkers,
  );

  // 4. Final System Handle & FD Sampling
  const finalHandles = getProcessHandleCount();

  // 5. Real Test Metrics Extraction (diff-backed additions + output parser)
  const parsedCounts = parseTestCountsFromOutput(stressResult.lastOutput);
  const addedUnitTestsCount = await countAddedTestCasesFromGitDiff(
    cwd,
    baselineCommitSha,
    vcsAdapter,
  );

  const hasZeroAssertions =
    parsedCounts.passed === 0 &&
    parsedCounts.total === 0 &&
    !/PASS|pass/i.test(stressResult.lastOutput);

  let handleLeakCheckPassed: "PASS" | "FAIL" | "UNAVAILABLE";
  if (initialHandles === null || finalHandles === null) {
    handleLeakCheckPassed = "UNAVAILABLE";
  } else if (finalHandles - initialHandles < 15) {
    handleLeakCheckPassed = "PASS";
  } else {
    handleLeakCheckPassed = "FAIL";
  }
  let testCoverageStatus: "PASS" | "FAIL" | "UNAVAILABLE";
  if (typeof changedCodeCoveragePercent !== "number") {
    testCoverageStatus = "UNAVAILABLE";
  } else if (changedCodeCoveragePercent >= 85) {
    testCoverageStatus = "PASS";
  } else {
    testCoverageStatus = "FAIL";
  }
  const greenVerification = redEvidence
    ? buildGreenEvidenceFromStress({
        cwd,
        testCommand,
        redEvidence,
        stressResult,
      })
    : undefined;
  const allTestsPassing =
    stressResult.passed &&
    parsedCounts.failed === 0 &&
    (greenVerification?.allTestsPassing ?? true);

  return {
    baselineTestedAt: new Date().toISOString(),
    baselineFlakyTests,
    stressLoopRuns: stressResult.executionCount,
    stressLoopPassed: stressResult.passed,
    executionCount: stressResult.executionCount,
    maxConcurrentObserved: stressResult.maxConcurrentObserved,
    concurrencyWorkers,
    concurrencyStampedePassed: stressResult.concurrencyStampedePassed,
    raceCollisionsDetected: stressResult.raceCollisionsDetected,
    latencyJitterMs: stressResult.latencyJitterMs,
    zeroAssertionWarning: hasZeroAssertions,
    handleLeakCheckPassed,
    initialDescriptorCount: initialHandles ?? undefined,
    finalDescriptorCount: finalHandles ?? undefined,
    passedUnitTestsCount: parsedCounts.passed,
    failedUnitTestsCount: parsedCounts.failed,
    addedUnitTestsCount,
    testCoverageStatus,
    changedCodeCoveragePercent,
    changedCodeCoverageStatus: testCoverageStatus,
    allTestsPassing,
    greenEvidence: greenVerification?.greenEvidence,
    reproductionVerified: greenVerification
      ? greenVerification.reproductionVerified && allTestsPassing
      : undefined,
  };
}
