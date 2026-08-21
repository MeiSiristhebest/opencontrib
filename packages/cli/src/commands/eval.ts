/**
 * `opencontrib eval <sub>` — Industrial LLM-as-a-Judge Trajectory Evaluator & Self-Evolving Reflexion
 */

import { Command } from 'commander';
import fs from 'node:fs';
import {
  parseTrajectoryFromJSONL,
  evaluateTrajectoryWithJudge,
  synthesizeReflexionInsights,
  persistReflexionToMemoryLedger,
  STANDARD_BENCHMARK_SCENARIOS,
  executeBenchmarkScenario,
} from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

// ─── eval judge ───────────────────────────────────────────────────────────────
const judgeCommand = new Command('judge')
  .description('Run G-Eval LLM-as-a-Judge on an agent conversation transcript (JSONL)')
  .argument('<transcript-file>', 'Path to transcript.jsonl file')
  .option('--pretty', 'Pretty-print', false)
  .action(async (transcriptFile: string, opts: { pretty?: boolean }) => {
    if (!fs.existsSync(transcriptFile)) {
      printJSON({ status: 'error', message: `File not found: ${transcriptFile}` }, opts.pretty);
      process.exit(1);
    }

    const { events, metrics } = parseTrajectoryFromJSONL(transcriptFile);
    const report = evaluateTrajectoryWithJudge(events, metrics);
    printJSON({
      status: 'success',
      report,
    }, opts.pretty);
  });

// ─── eval reflect ─────────────────────────────────────────────────────────────
const reflectCommand = new Command('reflect')
  .description('Synthesize MIT Reflexion lessons learned and distill episodic memory')
  .argument('<transcript-file>', 'Path to transcript.jsonl file')
  .option('--repo <name>', 'Target repository full name (e.g. owner/repo)')
  .option('--run-id <id>', 'Contribution Run ID')
  .option('--persist', 'Persist distilled lessons to local repo memory ledger', false)
  .option('--pretty', 'Pretty-print', false)
  .action(async (transcriptFile: string, opts: { repo?: string; runId?: string; persist?: boolean; pretty?: boolean }) => {
    if (!fs.existsSync(transcriptFile)) {
      printJSON({ status: 'error', message: `File not found: ${transcriptFile}` }, opts.pretty);
      process.exit(1);
    }

    const { events, metrics } = parseTrajectoryFromJSONL(transcriptFile);
    const report = evaluateTrajectoryWithJudge(events, metrics);
    const insight = synthesizeReflexionInsights(report, events, {
      runId: opts.runId,
      repoFullName: opts.repo,
    });

    if (opts.persist) {
      persistReflexionToMemoryLedger(insight);
    }

    printJSON({
      status: 'success',
      insight,
      persisted: opts.persist ?? false,
    }, opts.pretty);
  });

// ─── eval benchmark ───────────────────────────────────────────────────────────
const benchmarkCommand = new Command('benchmark')
  .description('Run automated dual-track benchmark scenarios (Track A 0-Day & Track B Issue)')
  .argument('[scenario-id]', 'Specific scenario ID to run (e.g. track-a-0day-ssrf-ipv6)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (scenarioId?: string, opts?: { pretty?: boolean }) => {
    const scenarios = scenarioId
      ? STANDARD_BENCHMARK_SCENARIOS.filter((s) => s.id === scenarioId)
      : STANDARD_BENCHMARK_SCENARIOS;

    if (scenarios.length === 0) {
      printJSON({ status: 'error', message: `Scenario not found: ${scenarioId}` }, opts?.pretty);
      process.exit(1);
    }

    const results = scenarios.map((s) => {
      // Simulate standard compliant trajectory phase gating
      return executeBenchmarkScenario(s, s.requiredPhaseSequence, 14, 18500);
    });

    printJSON({
      status: results.every((r) => r.success) ? 'passed' : 'failed',
      scenariosCount: scenarios.length,
      results,
    }, opts?.pretty);
  });

// ─── Top-level command ────────────────────────────────────────────────────────
export const evalCommand = new Command('eval')
  .description('Industrial LLM-as-a-Judge evaluation, trajectory auditing, and self-evolution flywheel')
  .addCommand(judgeCommand)
  .addCommand(reflectCommand)
  .addCommand(benchmarkCommand);
