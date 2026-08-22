/**
 * `opencontrib eval <sub>` — Agent-Native LLM-as-a-Judge Trajectory Evaluator
 *
 * Design: The CLI prepares the judge prompt and prints it.
 * The Agent (Antigravity / Codex / Cursor) then spawns a neutral sub-agent
 * to do the actual LLM reasoning — zero external API keys required.
 *
 * Two-phase workflow:
 *   Phase 1: `opencontrib eval judge <file>` → prints compressed trajectory + judge prompt
 *   Phase 2: Agent feeds prompt to neutral sub-agent → sub-agent returns JSON
 *   Phase 3: `opencontrib eval parse-judgment <raw-json-file>` → validates + scores
 */

import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseTrajectoryFromJSONL,
  buildJudgePrompt,
  parseJudgeResponse,
  synthesizeReflexionInsights,
  persistReflexionToMemoryLedger,
  STANDARD_BENCHMARK_SCENARIOS,
  executeBenchmarkScenario,
  normalizePatchLineEndings,
  parseSchemaV2Report,
} from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

// ─── eval judge ───────────────────────────────────────────────────────────────
// Phase 1: Compress trajectory and emit the judge prompt for a neutral sub-agent.
const judgeCommand = new Command('judge')
  .description(
    'Compress a transcript into a G-Eval judge prompt.\n' +
    'Feed the output to a NEUTRAL sub-agent (not yourself) for blind evaluation.\n' +
    'Then run `eval parse-judgment` to validate the sub-agent\'s JSON response.',
  )
  .argument('<transcript-file>', 'Path to transcript.jsonl file')
  .option('--pretty', 'Pretty-print metrics summary', false)
  .action(async (transcriptFile: string, opts: { pretty?: boolean }) => {
    if (!fs.existsSync(transcriptFile)) {
      printJSON({ status: 'error', message: `File not found: ${transcriptFile}` }, opts.pretty);
      process.exit(1);
    }

    const { events, metrics } = parseTrajectoryFromJSONL(transcriptFile);
    const { systemPrompt, userPrompt, trajectoryText } = buildJudgePrompt(events, metrics);

    // Print a human-readable guide for the Agent to follow
    console.log([
      '## G-Eval Judge Prompt Ready',
      '',
      `Steps: ${metrics.totalSteps} | Commands: ${metrics.totalCommandsRun} | view_file calls: ${metrics.viewFileCalls}`,
      `Max consecutive view_file: ${metrics.maxConsecutiveFileViews}`,
      '',
      '## ⚠️  AGENT INSTRUCTIONS',
      'You MUST spawn a NEUTRAL, INDEPENDENT sub-agent with the prompts below.',
      'Do NOT evaluate the trajectory yourself — you have context bias from this session.',
      'The sub-agent must see only these prompts and nothing else from your conversation.',
      '',
      '### SYSTEM PROMPT (pass as system prompt to sub-agent)',
      '---',
      systemPrompt,
      '---',
      '',
      '### USER PROMPT (pass as first user message to sub-agent)',
      '---',
      userPrompt,
      '---',
      '',
      '### After the sub-agent responds:',
      '  opencontrib eval parse-judgment <path-to-sub-agent-response.json>',
      '  (or pipe: echo \'<json>\' | opencontrib eval parse-judgment --stdin)',
    ].join('\n'));
  });

// ─── eval parse-judgment ──────────────────────────────────────────────────────
// Phase 2: Validate and score the neutral sub-agent's raw JSON response.
const parseJudgmentCommand = new Command('parse-judgment')
  .description('Validate and score the neutral judge sub-agent\'s raw JSON response')
  .argument('[response-file]', 'Path to the JSON file containing the sub-agent\'s raw response')
  .option('--stdin', 'Read raw JSON from stdin', false)
  .option('--transcript <file>', 'Original transcript path (for metadata)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (responseFile?: string, opts?: { stdin?: boolean; transcript?: string; pretty?: boolean }) => {
    let rawText: string;

    if (opts?.stdin) {
      // Cross-platform stdin read (works on Node.js, Bun, Windows, Unix)
      rawText = await new Promise<string>((resolve) => {
        const chunks: string[] = [];
        const dataHandler = (d: string | Buffer) => { chunks.push(d.toString()); };
        const endHandler = () => {
          process.stdin.removeListener('data', dataHandler);
          process.stdin.removeListener('end', endHandler);
          process.stdin.setEncoding('utf8');
          resolve(chunks.join(''));
        };
        process.stdin.setEncoding('utf8');
        process.stdin.on('data', dataHandler);
        process.stdin.on('end', endHandler);
        // Handle piped input that arrives synchronously before listeners attach
        const syncChunk = process.stdin.read?.();
        if (syncChunk) {
          chunks.push(syncChunk.toString());
          endHandler();
        }
      });
    } else if (responseFile) {
      if (!fs.existsSync(responseFile)) {
        printJSON({ status: 'error', message: `File not found: ${responseFile}` }, opts?.pretty);
        process.exit(1);
      }
      rawText = fs.readFileSync(responseFile, 'utf8');
    } else {
      printJSON({ status: 'error', message: 'Provide a response file or use --stdin' }, opts?.pretty);
      process.exit(1);
      return;
    }

    // Re-parse metrics from transcript if provided
    let metrics;
    if (opts?.transcript && fs.existsSync(opts.transcript)) {
      ({ metrics } = parseTrajectoryFromJSONL(opts.transcript));
    }

    try {
      const report = parseJudgeResponse(rawText, metrics);
      printJSON({ status: 'success', report }, opts?.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts?.pretty);
      process.exit(1);
    }
  });

// ─── eval reflect ─────────────────────────────────────────────────────────────
const reflectCommand = new Command('reflect')
  .description('Synthesize MIT Reflexion lessons from a parsed judgment report')
  .argument('<judgment-file>', 'Path to the JSON file produced by `eval parse-judgment`')
  .option('--repo <name>', 'Target repository full name (e.g. owner/repo)')
  .option('--run-id <id>', 'Contribution Run ID')
  .option('--persist', 'Persist distilled lessons to local repo memory ledger', false)
  .option('--pretty', 'Pretty-print', false)
  .action(async (
    judgmentFile: string,
    opts: { repo?: string; runId?: string; persist?: boolean; pretty?: boolean },
  ) => {
    if (!fs.existsSync(judgmentFile)) {
      printJSON({ status: 'error', message: `File not found: ${judgmentFile}` }, opts.pretty);
      process.exit(1);
    }

    let report;
    try {
      const raw = fs.readFileSync(judgmentFile, 'utf8');
      const parsed = JSON.parse(raw);
      report = parsed.report ?? parsed; // support both `{status, report}` and bare report
    } catch (err: any) {
      printJSON({ status: 'error', message: `Failed to parse judgment file: ${err.message}` }, opts.pretty);
      process.exit(1);
      return;
    }

    const insight = synthesizeReflexionInsights(report, [], {
      runId: opts.runId,
      repoFullName: opts.repo,
    });

    if (opts.persist) {
      persistReflexionToMemoryLedger(insight);
    }

    printJSON({ status: 'success', insight, persisted: opts.persist ?? false }, opts.pretty);
  });

// ─── eval benchmark ───────────────────────────────────────────────────────────
const benchmarkCommand = new Command('benchmark')
  .description('Run automated dual-track benchmark scenarios (Track A 0-Day & Track B Issue)')
  .argument('[scenario-id]', 'Specific scenario ID to run (e.g. track-a-0day-ssrf-ipv6)')
  .option('--pretty', 'Pretty-print', false)
  .option('--report-dir <dir>', 'Output directory for grading reports (SWE-bench integration)')
  .option('--patch-file <file>', 'Two-phase workflow: read model patch from file and apply before grading')
  .option('--fixtures <dir>', 'SWE-bench fixtures directory (instance IDs loaded from fixtures/)')
  .option('-v, --v2', 'Output per-test verdicts in schema-v2 format with resolved_ids', false)
  .action(async (scenarioId?: string, opts?: {
      pretty?: boolean;
      reportDir?: string;
      patchFile?: string;
      fixtures?: string;
      v2?: boolean;
    }) => {
    // ── Load SWE-bench fixtures if provided ──
    let scenarioInstances = scenarioId
      ? STANDARD_BENCHMARK_SCENARIOS.filter((s) => s.id === scenarioId)
      : STANDARD_BENCHMARK_SCENARIOS;

    if (opts?.fixtures && fs.existsSync(opts.fixtures)) {
      const fixtureDir = opts.fixtures;
      const fixtureEntries = fs.readdirSync(fixtureDir).filter((e) =>
        fs.statSync(path.join(fixtureDir, e)).isDirectory(),
      );
      const fixtureInstances = fixtureEntries.map((dir) => {
        const metaPath = path.join(fixtureDir, dir, 'metadata.json');
        let instanceId = dir;
        if (fs.existsSync(metaPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
            instanceId = meta.instance_id || dir;
          } catch { /* use dir name */ }
        }
        return instanceId;
      });
      if (fixtureInstances.length > 0) {
        printJSON(
          { status: 'fixtures-loaded', count: fixtureInstances.length, instances: fixtureInstances },
          opts?.pretty,
        );
      }
    }

    if (scenarioInstances.length === 0) {
      printJSON({ status: 'error', message: `Scenario not found: ${scenarioId}` }, opts?.pretty);
      process.exit(1);
    }

    // ── Two-phase workflow: apply --patch-file before grading ──
    let appliedPatch: string | undefined;
    if (opts?.patchFile && fs.existsSync(opts.patchFile)) {
      const rawPatch = fs.readFileSync(opts.patchFile, 'utf8');
      appliedPatch = normalizePatchLineEndings(rawPatch);
      printJSON(
        { status: 'patch-loaded', path: opts.patchFile, bytes: Buffer.byteLength(rawPatch) },
        opts?.pretty,
      );
    }

    const results = scenarioInstances.map((s) =>
      executeBenchmarkScenario(s, s.requiredPhaseSequence, 14, 18500),
    );

    const aggregate: {
      status: string;
      scenariosCount: number;
      results: { scenarioId: string; success: boolean; stepsTaken: number; durationMs: number; phaseGatingVerified: boolean; errors: string[] }[];
      appliedPatch?: string;
      reportDir?: string;
    } = {
      status: results.every((r) => r.success) ? 'passed' : 'failed',
      scenariosCount: scenarioInstances.length,
      results,
    };
    if (appliedPatch) aggregate.appliedPatch = appliedPatch;

    // ── Schema-v2 output mode ──
    if (opts?.v2) {
      const report = parseSchemaV2Report(aggregate, results);
      if (opts?.reportDir) {
        if (!fs.existsSync(opts.reportDir)) {
          fs.mkdirSync(opts.reportDir, { recursive: true });
        }
        const reportPath = path.join(opts.reportDir, 'report-v2.json');
        fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
        printJSON({ status: 'report-written', path: reportPath }, opts?.pretty);
      }
      printJSON(report, opts?.pretty);
    } else {
      printJSON(aggregate, opts?.pretty);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────
export const evalCommand = new Command('eval')
  .description('Agent-native LLM-as-a-Judge evaluation, trajectory auditing, and self-evolution flywheel')
  .addCommand(judgeCommand)
  .addCommand(parseJudgmentCommand)
  .addCommand(reflectCommand)
  .addCommand(benchmarkCommand);
