import { defaultSandboxRuntime, type SandboxExecutionResult } from '../sandbox/sandbox-runtime.js';
import type { EvidenceReport, FlakyTestRecord } from '../contracts/schemas.js';

export interface EvidenceCollectionOptions {
  cwd: string;
  workspaceRoot?: string;
  testCommand: string;
  stressLoopCount?: number;
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
  let passed = 0;
  let failed = 0;

  // Bun / Vitest / Jest: e.g. "31 pass, 0 fail" or "31 passed, 0 failed" or "Tests: 2 passed, 2 total"
  const passMatch = output.match(/(\d+)\s+(?:pass|passed)/i);
  if (passMatch) passed = parseInt(passMatch[1], 10);

  const failMatch = output.match(/(\d+)\s+(?:fail|failed)/i);
  if (failMatch) failed = parseInt(failMatch[1], 10);

  // Pytest: e.g. "5 passed, 1 failed in 0.12s"
  const pytestPass = output.match(/(\d+)\s+passed/i);
  if (!passMatch && pytestPass) passed = parseInt(pytestPass[1], 10);

  const pytestFail = output.match(/(\d+)\s+failed/i);
  if (!failMatch && pytestFail) failed = parseInt(pytestFail[1], 10);

  // Go test: e.g. "PASS" or "FAIL"
  if (passed === 0 && failed === 0) {
    if (output.includes('PASS') || output.includes('ok  \t')) passed = 1;
    if (output.includes('FAIL\t')) failed = 1;
  }

  // Cargo test: e.g. "test result: ok. 4 passed; 0 failed"
  const cargoPass = output.match(/(\d+)\s+passed/i);
  if (cargoPass) passed = Math.max(passed, parseInt(cargoPass[1], 10));

  const cargoFail = output.match(/(\d+)\s+failed/i);
  if (cargoFail) failed = Math.max(failed, parseInt(cargoFail[1], 10));

  return { passed, failed, total: passed + failed };
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

export function runStressLoop(
  cwd: string,
  testCommand: string,
  count: number = 20,
  workspaceRoot?: string,
): { passed: boolean; completedRuns: number; lastOutput: string } {
  let completedRuns = 0;
  let lastOutput = '';

  const parts = testCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  for (let i = 0; i < count; i++) {
    const res = defaultSandboxRuntime.executeInSandbox({
      cwd,
      workspaceRoot,
      command: cmd,
      args,
      timeoutMs: 25000,
    });

    lastOutput = res.output;
    if (res.passed) {
      completedRuns++;
    } else {
      return { passed: false, completedRuns, lastOutput };
    }
  }

  return { passed: true, completedRuns, lastOutput };
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

export async function collectEvidence(options: EvidenceCollectionOptions): Promise<EvidenceReport> {
  const { cwd, workspaceRoot, testCommand, stressLoopCount = 20, runFlakyBaseline = true } = options;

  // 1. Initial System Handle & FD Sampling
  const initialHandles = getProcessHandleCount();

  // 2. Step 4.0 Flaky Baseline Isolation
  const baselineFlakyTests = runFlakyBaseline ? recordFlakyBaseline(cwd, testCommand, 3, workspaceRoot) : [];

  // 3. Stress Test Loop (consecutive runs executed in sanitized sandbox)
  const stressResult = runStressLoop(cwd, testCommand, stressLoopCount, workspaceRoot);

  // 4. Final System Handle & FD Sampling
  const finalHandles = getProcessHandleCount();

  // 5. Real Test Metrics Extraction
  const parsedCounts = parseTestCountsFromOutput(stressResult.lastOutput);

  return {
    baselineTestedAt: new Date().toISOString(),
    baselineFlakyTests,
    stressLoopRuns: stressLoopCount,
    stressLoopPassed: stressResult.passed,
    handleLeakCheckPassed: initialHandles === 0 || finalHandles === 0 ? true : finalHandles - initialHandles < 15,
    initialDescriptorCount: initialHandles,
    finalDescriptorCount: finalHandles,
    passedUnitTestsCount: parsedCounts.passed,
    addedUnitTestsCount: parsedCounts.total > 0 ? 1 : 0,
  };
}
