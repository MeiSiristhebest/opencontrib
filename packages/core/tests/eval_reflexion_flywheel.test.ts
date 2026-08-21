import { describe, expect, it } from 'bun:test';
import {
  evaluateTrajectoryWithJudge,
  synthesizeReflexionInsights,
  persistReflexionToMemoryLedger,
  executeBenchmarkScenario,
  STANDARD_BENCHMARK_SCENARIOS,
  type TrajectoryEvent,
  type TrajectoryMetrics,
} from '../src/eval/index.js';
import { RepoMemoryLedger } from '../src/memory/repo-memory.js';


describe('Reflexion Self-Evolution Flywheel & Benchmark Runner', () => {
  it('synthesizes actionable Lessons Learned and Prompt Additions from failure traces', () => {
    const events: TrajectoryEvent[] = [];
    const metrics: TrajectoryMetrics = {
      totalSteps: 80,
      totalCommandsRun: 75,
      failedCommandsCount: 12,
      viewFileCalls: 10,
      maxConsecutiveFileViews: 6,
      wholeFileRgDumpsDetected: 4,
      shellScriptWriteHacksDetected: 3,
    };

    const report = evaluateTrajectoryWithJudge(events, metrics);
    const insight = synthesizeReflexionInsights(report, events, {
      runId: 'run_test_001',
      repoFullName: 'test-owner/test-repo',
    });

    expect(insight.failureMode).toContain('rg dumps');
    expect(insight.failureMode).toContain('Shell script');
    expect(insight.lessonsLearned.length).toBeGreaterThanOrEqual(2);
    expect(insight.suggestedPromptAdditions.some((p) => p.includes('write_to_file'))).toBe(true);
    expect(insight.suggestedPromptAdditions.some((p) => p.includes('rg -n ".*"'))).toBe(true);
  });

  it('persists distilled Reflexion lessons into the local RepoMemoryLedger', () => {
    const ledger = new RepoMemoryLedger();
    const insight = {
      repoFullName: 'org/critical-repo',
      failureMode: 'Standard Execution',
      rootCause: 'None',
      lessonsLearned: ['Use pointer slices to inspect AST findings.'],
      suggestedPromptAdditions: ['Always use opencontrib pointer resolve.'],
      createdAt: new Date().toISOString(),
    };

    persistReflexionToMemoryLedger(insight, ledger);
    const memory = ledger.getMemory('org/critical-repo');

    expect(memory).toBeDefined();
    expect(memory.pastFailures.length).toBeGreaterThan(0);
    expect(memory.pastFailures[0].context).toContain('pointer slices');
  });

  it('executes standard benchmark scenario verification with phase gating and budget checks', () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];

    // Case 1: Compliant execution
    const validExecution = executeBenchmarkScenario(
      scenario,
      scenario.requiredPhaseSequence,
      15, // <= 25 steps
      12000
    );
    expect(validExecution.success).toBe(true);
    expect(validExecution.phaseGatingVerified).toBe(true);
    expect(validExecution.errors.length).toBe(0);

    // Case 2: Missing phase execution
    const invalidExecution = executeBenchmarkScenario(
      scenario,
      ['PROBE_SCANNED', 'GREEN_FIXED'], // Skipped WORKSPACE and RED
      10,
      5000
    );
    expect(invalidExecution.success).toBe(false);
    expect(invalidExecution.phaseGatingVerified).toBe(false);
    expect(invalidExecution.errors.some((e) => e.includes('Missing required'))).toBe(true);
  });
});
