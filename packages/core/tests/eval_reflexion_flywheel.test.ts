import { describe, expect, it } from 'bun:test';
import { synthesizeReflexionInsights, persistReflexionToMemoryLedger } from '../src/eval/reflexion-engine.js';
import { RepoMemoryLedger } from '../src/memory/repo-memory.js';
import type { JudgeEvaluationReport, TrajectoryMetrics } from '../src/eval/types.js';

// ────────────────────────────────────────────────────────────────────────────
// Reflexion Flywheel Tests
//
// Validates that the reflexion engine:
//   1. Extracts lessons from LLM Judge output (criticalCritiques + actionableDirectives)
//   2. Does NOT apply any hardcoded metric-based rules
//   3. Identifies failing dimensions from the Judge's per-dimension scores
//   4. Persists insights correctly into the memory ledger
// ────────────────────────────────────────────────────────────────────────────

const MOCK_METRICS: TrajectoryMetrics = {
  totalSteps: 50,
  totalCommandsRun: 30,
  failedCommandsCount: 0,
  viewFileCalls: 8,
  maxConsecutiveFileViews: 3,
  wholeFileRgDumpsDetected: 2,
  shellScriptWriteHacksDetected: 1,
};

function makeReport(overrides: Partial<JudgeEvaluationReport> = {}): JudgeEvaluationReport {
  return {
    overallScore: 55,
    verdict: 'NEEDS_IMPROVEMENT',
    summary: 'LLM Judge: 55/100 (NEEDS_IMPROVEMENT).',
    dimensions: [
      { dimension: 'problemFormulation', title: 'Problem Formulation & Defect Convergence', weight: 0.20, score: 70, reasoning: 'Reasonable convergence.', evidenceQuotes: [] },
      { dimension: 'contextEconomy',     title: 'Context Economy & Anti-Drift',              weight: 0.20, score: 20, reasoning: 'Whole-file rg dumps detected.', evidenceQuotes: ['[Step 7] run_command: rg -n ".*"'] },
      { dimension: 'empiricalRigor',     title: 'Empirical Rigor & Dual-Stage Reproduction', weight: 0.25, score: 65, reasoning: 'Evidence collected.', evidenceQuotes: [] },
      { dimension: 'concurrencyStress',  title: 'Concurrency & Chaos Stress Testing',        weight: 0.15, score: 40, reasoning: 'Only single-run.', evidenceQuotes: [] },
      { dimension: 'communityCraftsmanship', title: 'Community Craftsmanship & Zero-Mojibake Protocol', weight: 0.20, score: 15, reasoning: 'node -e file write detected.', evidenceQuotes: ['[Step 8] run_command: node -e'] },
    ],
    strengths: ['Used opencontrib probe for initial discovery'],
    criticalCritiques: [
      'Whole-file rg dumps (rg -n ".*") bypassed context limits at Step 7.',
      'node -e shell hack used at Step 8 to write markdown, risking mojibake.',
    ],
    actionableDirectives: [
      'Use grep_search with targeted patterns instead of whole-file dumps.',
      'Always use write_to_file tool for all markdown artifacts.',
      'Add concurrency stress with --concurrency 8 before submitting PR.',
    ],
    metrics: MOCK_METRICS,
    chainOfThought: 'The agent showed some targeted navigation but violated context economy rules...',
    ...overrides,
  };
}

describe('Reflexion Flywheel — lessons come from LLM Judge output, not hardcoded rules', () => {
  it('extracts lessonsLearned directly from report.actionableDirectives', () => {
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], { repoFullName: 'owner/repo' });

    // Every lesson must come verbatim from the judge's actionableDirectives
    expect(insight.lessonsLearned).toContain('Use grep_search with targeted patterns instead of whole-file dumps.');
    expect(insight.lessonsLearned).toContain('Always use write_to_file tool for all markdown artifacts.');
    expect(insight.lessonsLearned).toContain('Add concurrency stress with --concurrency 8 before submitting PR.');
  });

  it('builds suggestedPromptAdditions from report.criticalCritiques (prefixed with MANDATE)', () => {
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], {});

    expect(insight.suggestedPromptAdditions.length).toBe(2);
    // Each addition is derived from the Judge's critiques, not hardcoded strings
    expect(insight.suggestedPromptAdditions[0]).toContain('MANDATE (from LLM Judge)');
    expect(insight.suggestedPromptAdditions[0]).toContain('rg -n');
  });

  it('identifies failureMode from dimensions that scored below 60, sorted worst-first', () => {
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], {});

    // contextEconomy=20 and communityCraftsmanship=15 are below 60
    expect(insight.failureMode).toContain('Community Craftsmanship');
    expect(insight.failureMode).toContain('Context Economy');
    // problemFormulation=70 is fine — should NOT appear as failure mode
    expect(insight.failureMode).not.toContain('Problem Formulation');
  });

  it('does NOT emit golden sequence for NEEDS_IMPROVEMENT sessions (score < 85)', () => {
    const report = makeReport({ overallScore: 55 });
    const insight = synthesizeReflexionInsights(report, [], {});
    expect(insight.goldenActionSequence).toBeUndefined();
  });

  it('captures golden opencontrib command sequence for EXEMPLARY sessions (score >= 85)', () => {
    const report = makeReport({ overallScore: 90, verdict: 'EXEMPLARY' });
    const events = [
      {
        stepIndex: 1, type: 'PLANNER_RESPONSE',
        toolCalls: [
          { name: 'run_command', args: { CommandLine: 'opencontrib probe run ./repo' } },
          { name: 'run_command', args: { CommandLine: 'gh issue create --body-file issue.md' } },
        ],
      },
    ];
    const insight = synthesizeReflexionInsights(report, events, {});
    // Only opencontrib commands captured, not gh commands
    expect(insight.goldenActionSequence).toBeDefined();
    expect(insight.goldenActionSequence!.length).toBe(1);
    expect(insight.goldenActionSequence![0]).toContain('opencontrib probe run');
  });

  it('persists insight to memory ledger without throwing', () => {
    const report = makeReport();
    const insight = synthesizeReflexionInsights(report, [], { repoFullName: 'owner/repo' });
    const ledger = new RepoMemoryLedger();
    // Should not throw
    expect(() => persistReflexionToMemoryLedger(insight, ledger)).not.toThrow();
  });
});
