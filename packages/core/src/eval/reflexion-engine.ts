/**
 * Reflexion & Self-Evolving Memory Distillation Engine (MIT Reflexion Architecture)
 */

import type { JudgeEvaluationReport, ReflexionInsight, TrajectoryEvent } from './types.js';
import { RepoMemoryLedger } from '../memory/repo-memory.js';


export function synthesizeReflexionInsights(
  report: JudgeEvaluationReport,
  events: TrajectoryEvent[],
  context?: { runId?: string; repoFullName?: string }
): ReflexionInsight {
  const failureModes: string[] = [];
  const rootCauses: string[] = [];
  const lessons: string[] = [];
  const promptAdditions: string[] = [];

  // 1. Analyze Context Economy & RG Dumps
  if (report.metrics.wholeFileRgDumpsDetected > 0) {
    failureModes.push('Bypassing view limits with whole-file rg dumps');
    rootCauses.push('Agent attempted to read entire source files by matching all lines via regex instead of using Smart Pointer slices.');
    lessons.push('Always resolve Smart Pointers with "opencontrib pointer resolve ptr://... --view slice" to inspect code without context bloat.');
    promptAdditions.push('STRICT MANDATE: Never run whole-file regex dump commands like `rg -n ".*"` or `rg "^"`.');
  }

  // 2. Analyze Shell Script Write Hacks & Mojibake
  if (report.metrics.shellScriptWriteHacksDetected > 0) {
    failureModes.push('Shell script file writing and encoding corruption');
    rootCauses.push('Agent wrote markdown files via node -e or Buffer.from in terminal, causing PowerShell character escaping corruption.');
    lessons.push('Always use the native write_to_file tool with clean UTF-8 encoding to create markdown files before passing to --body-file.');
    promptAdditions.push('STRICT MANDATE: Never write Markdown files using inline shell one-liners; always use write_to_file.');
  }

  // 3. Analyze Command Count & Convergence Velocity
  if (report.metrics.totalCommandsRun > 40) {
    failureModes.push('Exploratory wandering and excessive command loops');
    rootCauses.push('Agent performed extensive manual directory listings and searches instead of relying on probe plan and capability negotiation.');
    lessons.push('Use "opencontrib probe plan" to negotiate matching analyzers and jump directly to Top-K Smart Pointer targets.');
    promptAdditions.push('EFFICIENCY: Use probe plan and Top-K pointers to converge onto target defects within 15 steps.');
  }

  // 4. Extract Golden Action Sequence (if report score is high)
  const goldenSequence: string[] = [];
  if (report.overallScore >= 85) {
    for (const e of events) {
      if (e.toolCalls) {
        for (const t of e.toolCalls) {
          if (t.name === 'run_command' && String(t.args?.CommandLine || '').startsWith('opencontrib')) {
            goldenSequence.push(String(t.args.CommandLine));
          }
        }
      }
    }
  }

  return {
    runId: context?.runId,
    repoFullName: context?.repoFullName,
    failureMode: failureModes.join('; ') || 'Standard Execution',
    rootCause: rootCauses.join('; ') || 'No critical failure modes observed.',
    lessonsLearned: lessons.length > 0 ? lessons : ['Maintain current high-precision contribution standards.'],
    suggestedPromptAdditions: promptAdditions,
    goldenActionSequence: goldenSequence.length > 0 ? goldenSequence : undefined,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Persists Reflexion insights into the local repository memory ledger
 */
export function persistReflexionToMemoryLedger(
  insight: ReflexionInsight,
  ledger?: RepoMemoryLedger
): void {
  const memLedger = ledger || new RepoMemoryLedger();
  if (insight.repoFullName) {
    memLedger.recordReflexionInsight(insight.repoFullName, {
      failureMode: insight.failureMode,
      rootCause: insight.rootCause,
      lessonsLearned: insight.lessonsLearned,
    });
  }
}
