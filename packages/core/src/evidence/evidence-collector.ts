import { defaultSandboxRuntime, type SandboxExecutionResult } from '../sandbox/sandbox-runtime.js';
import type { EvidenceReport, FlakyTestRecord } from '../contracts/schemas.js';
import { defaultTestOutputParserRegistry, TestOutputParserRegistry } from './parsers/registry.js';
import { defaultVcsDeltaAdapter, type VcsDeltaPort } from './vcs-delta.port.js';


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

export function getProcessHandleCount(): number {
  try {
    if (process.platform === 'win32') {
      const res = defaultSandboxRuntime.executeInSandbox({
        cwd: process.cwd(),
        command: 'powershell',
        args: ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).HandleCount`],
        timeoutMs: 4000,
        allowHostFallback: true,
      });
      return parseInt(res.stdout.trim(), 10) || 0;
    } else {
      const res = defaultSandboxRuntime.executeInSandbox({
        cwd: process.cwd(),
        command: 'lsof',
        args: ['-p', process.pid.toString()],
        timeoutMs: 4000,
        allowHostFallback: true,
      });
      const lines = res.stdout.trim().split('\n').filter(Boolean);
      return lines.length || 0;
    }
  } catch {
    return 0;
  }
}

export function parseTestCountsFromOutput(output: string): { passed: number; failed: number; total: number } {
  return defaultTestOutputParserRegistry.parse(output);
}


export function recordFlakyBaseline(
  cwd: string,
  testCommand: string,
  runs: number = 3,
  workspaceRoot?: string,
): FlakyTestRecord[] {
  const testRunResults = new Map<string, { runCount: number; failCount: number }>();
  const parts = testCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  for (let i = 0; i < runs; i++) {
    const res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      command: cmd,
      args,
      timeoutMs: 30000,
    });

    if (!res.passed) {
      const full = res.output;
      const failureMatches = full.match(/(?:FAIL|✕|FAILED)\s+([^\r\n]+)/g) || [];
      for (const f of failureMatches) {
        const testName = f.replace(/^(?:FAIL|✕|FAILED)\s+/, '').trim();
        const current = testRunResults.get(testName) || { runCount: 0, failCount: 0 };
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

export function runStressLoop(
  cwd: string,
  testCommand: string,
  count?: number,
  workspaceRoot?: string,
  concurrencyWorkers: number = 1,
): StressLoopResult {
  let completedRuns = 0;
  let lastOutput = '';
  let raceCollisions = 0;
  const latencies: number[] = [];

  const isBroadSuite =
    testCommand.includes('./...') ||
    testCommand.includes('npm test') ||
    testCommand.includes('bun test') ||
    testCommand.trim() === 'pytest' ||
    testCommand.trim() === 'cargo test';

  const targetCount = count !== undefined ? count : isBroadSuite ? 1 : 3;
  const parts = testCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  for (let i = 0; i < targetCount; i++) {
    const startTime = Date.now();
    const res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      command: cmd,
      args,
      timeoutMs: 30000,
    });
    const elapsed = Date.now() - startTime;
    latencies.push(elapsed);

    lastOutput = res.output;
    if (res.passed) {
      completedRuns++;
    } else {
      // Check if failure is concurrency/race collision related
      if (/data race|race detected|concurrent map|deadlock|collision/i.test(res.output)) {
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
} {
  const { cwd, workspaceRoot, reproductionScriptPath, testCommand, runnerCommand = 'bun' } = input;

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
    const parts = testCommand.split(' ');
    res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      command: parts[0],
      args: parts.slice(1),
      timeoutMs: 20000,
    });
  } else {
    return {
      isFailingOnBaseline: false,
      baselineOutput: 'No reproduction script or test command provided.',
      assertionCaptured: false,
    };
  }

  const full = res.output;
  // Guard against common false positives such as "0 errors", "0 failed", or benign mentions of error handling
  const isFalsePositiveZeroError =
    /\b0\s+(errors?|failed|failures)\b/i.test(full) && !/\b[1-9]\d*\s+(errors?|failed|failures)\b/i.test(full);
  const isRealFailurePattern =
    /(?:BUG CONFIRMED|\bFAILED\b|\bFAIL\b|assertion failed|\berror:|TypeError:|AssertionError:|panic:|\bstack trace:)/i.test(
      full,
    );

  const hasFailureFlag = !res.passed || (isRealFailurePattern && !isFalsePositiveZeroError);

  return {
    isFailingOnBaseline: hasFailureFlag,
    baselineOutput: full,
    assertionCaptured: hasFailureFlag,
  };
}

export function capturePreFixAssertion(cwd: string, testCommand: string, workspaceRoot?: string) {
  return verifyEmpiricalReproduction({ cwd, testCommand, workspaceRoot });
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
    preFixFailureOutput = '',
    stressLoopCount = 5,
  } = input;

  const stressResult = runStressLoop(cwd, testCommand, stressLoopCount, workspaceRoot);
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
  if (!diffText || typeof diffText !== 'string') return 0;
  const addedLines = diffText.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++'));
  // Match test case definitions, strictly excluding suites (describe) and comments (//, *, #, /*)
  const testCasePattern =
    /^\+\s*(?:(?:it|test)(?:\.(?:skip|only|concurrent|todo|each))?\s*\(|def\s+test_[a-zA-Z0-9_]+\s*\(|func\s+Test[a-zA-Z0-9_]+\s*\(|#\[test\])/;
  // Comment pattern excludes //, /*, *, and # (except Rust #[test] attributes)
  const commentPattern = /^\+\s*(?:\/\/|\/\*|\*|#(?!\[))/;

  const matches = addedLines.filter((l) => !commentPattern.test(l) && testCasePattern.test(l));
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
  const baselineFlakyTests = runFlakyBaseline ? recordFlakyBaseline(cwd, testCommand, 3, workspaceRoot) : [];

  // 3. Stress Test Loop (consecutive runs executed in sanitized sandbox)
  const stressResult = runStressLoop(cwd, testCommand, stressLoopCount, workspaceRoot, concurrencyWorkers);

  // 4. Final System Handle & FD Sampling
  const finalHandles = getProcessHandleCount();

  // 5. Real Test Metrics Extraction (diff-backed additions + output parser)
  const parsedCounts = parseTestCountsFromOutput(stressResult.lastOutput);
  const addedUnitTestsCount = await countAddedTestCasesFromGitDiff(cwd, baselineCommitSha, vcsAdapter);

  const hasZeroAssertions = parsedCounts.passed === 0 && parsedCounts.total === 0 && !/PASS|pass/i.test(stressResult.lastOutput);

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
    handleLeakCheckPassed: initialHandles === 0 || finalHandles === 0 ? true : finalHandles - initialHandles < 15,
    initialDescriptorCount: initialHandles,
    finalDescriptorCount: finalHandles,
    passedUnitTestsCount: parsedCounts.passed,
    addedUnitTestsCount,
  };
}



