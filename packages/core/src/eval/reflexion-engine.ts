/**
 * Reflexion & Self-Evolving Memory Distillation Engine (MIT Reflexion Architecture)
 *
 * Design: The LLM Judge (neutral sub-agent) has already produced critiques and
 * actionable directives in its evaluation report. This engine's job is to take
 * that LLM-reasoned output and distill it into durable memory — NOT to re-apply
 * hardcoded heuristics on top of metrics.
 *
 * Rule: All lessons come from report.criticalCritiques + report.actionableDirectives
 * (what the LLM Judge actually said), never from IF/ELSE rules on metric numbers.
 */

import type { JudgeEvaluationReport, ReflexionInsight, TrajectoryEvent } from './types.js';
import { RepoMemoryLedger } from '../memory/repo-memory.js';

export function synthesizeReflexionInsights(
  report: JudgeEvaluationReport,
  events: TrajectoryEvent[],
  context?: { runId?: string; repoFullName?: string },
): ReflexionInsight {
  // ── Source of truth: what the neutral LLM Judge said, verbatim ──────────────
  const lessons: string[] = (report.actionableDirectives || []).length > 0
    ? report.actionableDirectives
    : ['Maintain current contribution standards.'];

  const critiques: string[] = report.criticalCritiques || [];

  // ── Failure mode and root cause: distilled from Judge's dimension reasoning ─
  const dimensions = report.dimensions || [];
  const failingDimensions = dimensions
    .filter((d) => (d.score || 0) < 60)
    .sort((a, b) => (a.score || 0) - (b.score || 0));

  const failureMode = failingDimensions.length > 0
    ? failingDimensions.map((d) => d.title).join('; ')
    : 'No critical failure modes (all dimensions ≥ 60)';

  const rootCause = failingDimensions.length > 0
    ? failingDimensions.map((d) => `[${d.title}] ${d.reasoning}`).join('\n')
    : (report.summary || 'No summary available');

  // ── Prompt additions: derived from Judge critiques + dimension evidence ───────
  const promptAdditions: string[] = critiques.length > 0
    ? critiques.map((c) => `MANDATE (from LLM Judge): ${c}`)
    : [];

  // ── Golden sequence: opencontrib commands from exemplary sessions only ───────
  const goldenSequence: string[] = [];
  if ((report.overallScore ?? 0) >= 85) {
    for (const e of events) {
      for (const t of e.toolCalls ?? []) {
        if (
          t.name === 'run_command' &&
          String(t.args?.CommandLine ?? '').startsWith('opencontrib')
        ) {
          goldenSequence.push(String(t.args.CommandLine));
        }
      }
    }
  }

  return {
    runId: context?.runId,
    repoFullName: context?.repoFullName,
    failureMode,
    rootCause,
    lessonsLearned: lessons,
    suggestedPromptAdditions: promptAdditions,
    goldenActionSequence: goldenSequence.length > 0 ? goldenSequence : undefined,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Persists Reflexion insights into the local repository memory ledger.
 */
export function persistReflexionToMemoryLedger(
  insight: ReflexionInsight,
  ledger?: RepoMemoryLedger,
): void {
  const memLedger = ledger ?? new RepoMemoryLedger();
  if (insight.repoFullName) {
    memLedger.recordReflexionInsight(insight.repoFullName, {
      failureMode: insight.failureMode,
      rootCause: insight.rootCause,
      lessonsLearned: insight.lessonsLearned,
    });
  }
}
