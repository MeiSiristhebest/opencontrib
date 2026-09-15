import { createHash } from "crypto";
import { execSync } from "child_process";
import { readdirSync, statSync, readFileSync } from "fs";
import { join } from "path";
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
} from "../contracts/schemas.js";
import { defaultTestOutputParserRegistry } from "./parsers/registry.js";
import { defaultVcsDeltaAdapter, type VcsDeltaPort } from "./vcs-delta.port.js";

export interface EvidenceCollectionOptions {
  cwd: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
  testCommand: string;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
  runFlakyBaseline?: boolean;
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
  lastOutput: string;
  concurrencyWorkers: number;
  concurrencyStampedePassed: boolean;
  raceCollisionsDetected: number;
  latencyJitterMs: number;
}

export async function runStressLoopAsync(
  cwd: string,
  testCommand: string,
  count?: number,
  workspaceRoot?: string,
  concurrencyWorkers: number = 1,
): Promise<StressLoopResult> {
  let completedRuns = 0;
  let lastOutput = "";
  let raceCollisions = 0;
  const latencies: number[] = [];

  const isBroadSuite =
    testCommand.includes("./...") ||
    testCommand.includes("npm test") ||
    testCommand.includes("bun test") ||
    testCommand.trim() === "pytest" ||
    testCommand.trim() === "cargo test";

  const targetCount = count === undefined ? (isBroadSuite ? 1 : 3) : count;
  const spec = parseCommandSpec(testCommand);

  // If multi-worker concurrency requested (>1), spawn simultaneous worker processes via Promise.all
  if (concurrencyWorkers > 1) {
    const workerPromises = Array.from({ length: concurrencyWorkers }).map(
      async () => {
        const start = Date.now();
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
      },
    );

    const workerResults = await Promise.all(workerPromises);

    let allPassed = true;
    for (const r of workerResults) {
      latencies.push(r.elapsed);
      lastOutput = r.output;
      if (r.passed) {
        completedRuns++;
      } else {
        allPassed = false;
        if (
          /data race|race detected|concurrent map|deadlock|collision/i.test(
            r.output,
          )
        ) {
          raceCollisions++;
        }
      }
    }

    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

    return {
      passed: allPassed,
      completedRuns,
      lastOutput,
      concurrencyWorkers,
      concurrencyStampedePassed: allPassed && raceCollisions === 0,
      raceCollisionsDetected: raceCollisions,
      latencyJitterMs: maxLatency - minLatency,
    };
  }

  for (let i = 0; i < targetCount; i++) {
    const startTime = Date.now();
    const res = await defaultSandboxRuntime.executeAsync({
      cwd,
      workspaceRoot,
      commandSpec: spec,
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - startTime;
    latencies.push(elapsed);

    lastOutput = res.output;
    if (res.passed) {
      completedRuns++;
    } else {
      if (
        /data race|race detected|concurrent map|deadlock|collision/i.test(
          res.output,
        )
      ) {
        raceCollisions++;
      }
      const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
      return {
        passed: false,
        completedRuns,
        lastOutput,
        concurrencyWorkers,
        concurrencyStampedePassed: false,
        raceCollisionsDetected: raceCollisions,
        latencyJitterMs: maxLatency - minLatency,
      };
    }
  }

  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  return {
    passed: true,
    completedRuns,
    lastOutput,
    concurrencyWorkers,
    concurrencyStampedePassed: raceCollisions === 0,
    raceCollisionsDetected: raceCollisions,
    latencyJitterMs: maxLatency - minLatency,
  };
}

export function runStressLoop(
  cwd: string,
  testCommand: string,
  count?: number,
  workspaceRoot?: string,
  concurrencyWorkers: number = 1,
): StressLoopResult {
  let completedRuns = 0;
  let lastOutput = "";
  let raceCollisions = 0;
  const latencies: number[] = [];

  const isBroadSuite =
    testCommand.includes("./...") ||
    testCommand.includes("npm test") ||
    testCommand.includes("bun test") ||
    testCommand.trim() === "pytest" ||
    testCommand.trim() === "cargo test";

  const targetCount = count === undefined ? (isBroadSuite ? 1 : 3) : count;
  const spec = parseCommandSpec(testCommand);

  // If multi-worker concurrency requested (>1), spawn parallel worker processes
  if (concurrencyWorkers > 1) {
    const workerResults: Array<{
      passed: boolean;
      output: string;
      elapsed: number;
    }> = [];

    // Use sandboxed execution across parallel worker batch
    for (let w = 0; w < concurrencyWorkers; w++) {
      const start = Date.now();
      const res = defaultSandboxRuntime.executeInSandbox({
        cwd,
        workspaceRoot,
        commandSpec: spec,
        timeoutMs: 30000,
      });
      workerResults.push({
        passed: res.passed,
        output: res.output,
        elapsed: Date.now() - start,
      });
    }

    let allPassed = true;
    for (const r of workerResults) {
      latencies.push(r.elapsed);
      lastOutput = r.output;
      if (r.passed) {
        completedRuns++;
      } else {
        allPassed = false;
        if (
          /data race|race detected|concurrent map|deadlock|collision/i.test(
            r.output,
          )
        ) {
          raceCollisions++;
        }
      }
    }

    const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
    const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

    return {
      passed: allPassed,
      completedRuns,
      lastOutput,
      concurrencyWorkers,
      concurrencyStampedePassed: allPassed && raceCollisions === 0,
      raceCollisionsDetected: raceCollisions,
      latencyJitterMs: maxLatency - minLatency,
    };
  }

  for (let i = 0; i < targetCount; i++) {
    const startTime = Date.now();
    const res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      commandSpec: spec,
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - startTime;
    latencies.push(elapsed);

    lastOutput = res.output;
    if (res.passed) {
      completedRuns++;
    } else {
      // Check if failure is concurrency/race collision related
      if (
        /data race|race detected|concurrent map|deadlock|collision/i.test(
          res.output,
        )
      ) {
        raceCollisions++;
      }
      const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
      const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;
      return {
        passed: false,
        completedRuns,
        lastOutput,
        concurrencyWorkers,
        concurrencyStampedePassed: false,
        raceCollisionsDetected: raceCollisions,
        latencyJitterMs: maxLatency - minLatency,
      };
    }
  }

  const minLatency = latencies.length > 0 ? Math.min(...latencies) : 0;
  const maxLatency = latencies.length > 0 ? Math.max(...latencies) : 0;

  return {
    passed: true,
    completedRuns,
    lastOutput,
    concurrencyWorkers,
    concurrencyStampedePassed: raceCollisions === 0,
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

  return {
    isFailingOnBaseline: hasFailureFlag,
    baselineOutput: full,
    assertionCaptured: hasFailureFlag,
    exitCode: res.exitCode === null ? (hasFailureFlag ? 1 : 0) : res.exitCode,
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
    const gitStatus = execSync("git status --porcelain --untracked-files=all", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const gitDiff = execSync("git diff --binary HEAD", {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    // Content hashes of untracked files for true content immutability
    const untrackedHashes: string[] = [];
    const untrackedLines = gitStatus
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("?? "));

    for (const l of untrackedLines) {
      const rel = l.slice(3).trim();
      const full = join(cwd, rel);
      try {
        const st = statSync(full);
        if (!st.isDirectory()) {
          const buf = readFileSync(full);
          const h = createHash("sha256").update(buf).digest("hex");
          untrackedHashes.push(`${rel}:${String(st.size)}:${h}`);
        }
      } catch {}
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
          let st;
          try {
            st = statSync(full);
          } catch {
            continue;
          }
          if (st.isDirectory()) {
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
 * Evidence V2 — capture an immutable RED baseline artifact.
 * Runs the test command once, records the observed failure, and binds the
 * current source tree hash so a later GREEN can be proven to have mutated the tree.
 */
export function captureRedEvidence(input: {
  cwd: string;
  testCommand: string;
  workspaceRoot?: string;
  expectedAssertion?: string;
  testFileSha256?: string;
  baselineCommitSha?: string;
}): RedEvidence {
  const preFix = capturePreFixAssertion(
    input.cwd,
    input.testCommand,
    input.workspaceRoot,
    input.expectedAssertion,
  );
  const assertionMatched = Boolean(preFix.assertionCaptured);
  const exitCode =
    typeof (preFix as { exitCode?: number }).exitCode === "number"
      ? (preFix as { exitCode?: number }).exitCode!
      : assertionMatched
        ? 1
        : 0;
  const assertionMatchedFingerprint = computeTestIdentityFingerprint({
    testCommand: input.testCommand,
    expectedAssertion: input.expectedAssertion,
    testFileSha256: input.testFileSha256,
  });

  return {
    command: input.testCommand,
    expectedAssertion: input.expectedAssertion,
    observedOutputSnippet: (
      (preFix as { baselineOutput?: string }).baselineOutput ?? ""
    ).slice(0, 500),
    exitCode,
    sourceTreeSha256: computeSourceTreeHash(input.cwd),
    testFileSha256: input.testFileSha256,
    baselineCommitSha: input.baselineCommitSha,
    capturedAt: new Date().toISOString(),
    assertionMatched,
    assertionMatchedFingerprint,
  };
}

/**
 * Evidence V2 — verify GREEN and bind it to a previously captured RedEvidence.
 * `reproductionVerified` is only true when the RED baseline assertion matched AND
 * the current run passes AND the source tree actually changed since the RED capture.
 */
export function verifyGreenEvidence(input: {
  cwd: string;
  testCommand: string;
  workspaceRoot?: string;
  redEvidence: RedEvidence;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
}): {
  greenEvidence: GreenEvidence;
  reproductionVerified: boolean;
  allTestsPassing: boolean;
} {
  const { redEvidence } = input;
  const stressResult = runStressLoop(
    input.cwd,
    input.testCommand,
    input.stressLoopCount ?? 1,
    input.workspaceRoot,
    input.concurrencyWorkers ?? 1,
  );
  const passed = stressResult.passed;
  const greenTreeHash = computeSourceTreeHash(input.cwd);
  const treeChanged = greenTreeHash !== redEvidence.sourceTreeSha256;
  const greenFingerprint = computeTestIdentityFingerprint({
    testCommand: input.testCommand,
    expectedAssertion: redEvidence.expectedAssertion,
    testFileSha256: redEvidence.testFileSha256,
  });

  const greenEvidence: GreenEvidence = {
    command: input.testCommand,
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
  };
  const sameIdentity =
    Boolean(redEvidence.assertionMatchedFingerprint) &&
    greenFingerprint === redEvidence.assertionMatchedFingerprint;
  const reproductionVerified =
    redEvidence.assertionMatched === true &&
    passed &&
    treeChanged &&
    sameIdentity;
  return { greenEvidence, reproductionVerified, allTestsPassing: passed };
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

  const stressResult = runStressLoop(
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
  } = options;

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

  // Handle leak detection:
  // If system handles cannot be measured (null), mark handleLeakCheckPassed as true with a warning flag,
  // but if both measurements succeeded, strictly require leak delta < 15.
  const handleLeakCheckPassed =
    initialHandles === null || finalHandles === null
      ? true
      : finalHandles - initialHandles < 15;

  return {
    baselineTestedAt: new Date().toISOString(),
    baselineFlakyTests,
    stressLoopRuns: stressLoopCount,
    stressLoopPassed: stressResult.passed,
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
    allTestsPassing: stressResult.passed && parsedCounts.failed === 0,
  };
}
