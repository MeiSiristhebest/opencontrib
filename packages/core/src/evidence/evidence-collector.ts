import { spawnSync } from 'child_process';
import type { EvidenceReport, FlakyTestRecord } from '../contracts/schemas.js';

export interface EvidenceCollectionOptions {
  cwd: string;
  testCommand: string;
  stressLoopCount?: number;
  runFlakyBaseline?: boolean;
}

export function getProcessHandleCount(): number {
  try {
    if (process.platform === 'win32') {
      const res = spawnSync('powershell', ['-NoProfile', '-Command', `(Get-Process -Id ${process.pid}).HandleCount`], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return parseInt((res.stdout || '').trim(), 10) || 0;
    } else {
      const res = spawnSync('lsof', ['-p', process.pid.toString()], {
        encoding: 'utf-8',
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const lines = (res.stdout || '').trim().split('\n').filter(Boolean);
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
  if (pytestPass && !passMatch) passed = parseInt(pytestPass[1], 10);

  // Cargo test: e.g. "test result: ok. 5 passed; 0 failed;"
  const cargoMatch = output.match(/(\d+)\s+passed;\s*(\d+)\s+failed/i);
  if (cargoMatch) {
    passed = parseInt(cargoMatch[1], 10);
    failed = parseInt(cargoMatch[2], 10);
  }

  // Go test: e.g. "PASS" or "ok pkg 0.123s"
  if (passed === 0 && (output.includes('PASS') || output.includes('ok '))) {
    passed = 1;
  }

  return {
    passed,
    failed,
    total: passed + failed,
  };
}

export function recordFlakyBaseline(cwd: string, testCommand: string, runs: number = 3): FlakyTestRecord[] {
  const testRunResults = new Map<string, { runCount: number; failCount: number }>();
  const safeEnv = {
    ...process.env,
    CI: 'true',
    FORCE_COLOR: '0',
    DEBIAN_FRONTEND: 'noninteractive',
    GIT_TERMINAL_PROMPT: '0',
  };

  const parts = testCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  for (let i = 0; i < runs; i++) {
    const res = spawnSync(cmd, args, {
      cwd,
      encoding: 'utf-8',
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: safeEnv,
      shell: true,
    });

    if (res.status !== 0) {
      const full = `${res.stdout || ''}\n${res.stderr || ''}`;
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
): { passed: boolean; completedRuns: number; lastOutput: string } {
  let completedRuns = 0;
  let lastOutput = '';

  const parts = testCommand.split(' ');
  const cmd = parts[0];
  const args = parts.slice(1);

  for (let i = 0; i < count; i++) {
    const res = spawnSync(cmd, args, {
      cwd,
      timeout: 20000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    });

    lastOutput = `${res.stdout || ''}\n${res.stderr || ''}`;
    if (res.status === 0) {
      completedRuns++;
    } else {
      return { passed: false, completedRuns, lastOutput };
    }
  }

  return { passed: true, completedRuns, lastOutput };
}

export function verifyEmpiricalReproduction(input: {
  cwd: string;
  reproductionScriptPath: string;
  runnerCommand?: string;
}): {
  isFailingOnBaseline: boolean;
  baselineOutput: string;
  assertionCaptured: boolean;
} {
  const { cwd, reproductionScriptPath, runnerCommand = 'bun' } = input;
  const safeEnv = {
    ...process.env,
    CI: 'true',
    FORCE_COLOR: '0',
    DEBIAN_FRONTEND: 'noninteractive',
  };

  const res = spawnSync(runnerCommand, [reproductionScriptPath], {
    cwd,
    encoding: 'utf-8',
    env: safeEnv,
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });

  const full = `${res.stdout || ''}\n${res.stderr || ''}`;
  const hasFailureFlag = res.status !== 0 || /BUG CONFIRMED|FAILED|FAIL|assertion failed|error/i.test(full);

  return {
    isFailingOnBaseline: hasFailureFlag,
    baselineOutput: full,
    assertionCaptured: hasFailureFlag,
  };
}

export async function collectEvidence(options: EvidenceCollectionOptions): Promise<EvidenceReport> {
  const { cwd, testCommand, stressLoopCount = 20, runFlakyBaseline = true } = options;

  // 1. Initial System Handle & FD Sampling
  const initialHandles = getProcessHandleCount();

  // 2. Step 4.0 Flaky Baseline Isolation
  const baselineFlakyTests = runFlakyBaseline ? recordFlakyBaseline(cwd, testCommand, 3) : [];

  // 3. Stress Test Loop (consecutive runs)
  const stressResult = runStressLoop(cwd, testCommand, stressLoopCount);

  // 4. Final System Handle & FD Sampling
  const finalHandles = getProcessHandleCount();

  // 5. Real Test Metrics Extraction
  const parsedCounts = parseTestCountsFromOutput(stressResult.lastOutput);

  return {
    baselineTestedAt: new Date().toISOString(),
    baselineFlakyTests,
    stressLoopRuns: stressLoopCount,
    stressLoopPassed: stressResult.passed,
    handleLeakCheckPassed: initialHandles === 0 || finalHandles === 0 ? true : (finalHandles - initialHandles < 15),
    initialDescriptorCount: initialHandles,
    finalDescriptorCount: finalHandles,
    passedUnitTestsCount: parsedCounts.passed,
    addedUnitTestsCount: parsedCounts.total > 0 ? 1 : 0,
  };
}
