/** `opencontrib run <sub>` — Manage contribution run sessions. */

import { Command, Argument } from 'commander';
import { ContributionRunManager } from '@opencontrib/core';
import { printJSON, parseJSON, readStdin } from '../utils/output.js';

const runManager = new ContributionRunManager();

// ─── run create ───────────────────────────────────────────────────────────────
const runCreate = new Command('create')
  .description('Initialize a new contribution run')
  .requiredOption('--repo <name>', 'Repository full name, e.g. "facebook/react"')
  .option('--issue <num>', 'Issue number')
  .option('--title <text>', 'Issue title')
  .option('--tags <list>', 'Comma-separated tags', (v) => v.split(','))
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { repo: string; issue?: string; title?: string; tags?: string[]; pretty?: boolean }) => {
    try {
      const manifest = runManager.createRun({
        repoFullName: opts.repo,
        issueNumber: opts.issue ? Number(opts.issue) : undefined,
        issueTitle: opts.title,
        tags: opts.tags,
      });
      printJSON({ status: 'success', manifest }, opts.pretty);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── run get <runId> ─────────────────────────────────────────────────────────
const runGet = new Command('get')
  .description('Retrieve full manifest and artifacts for a run')
  .addArgument(new Argument('<runId>', 'Run ID'))
  .option('--pretty', 'Pretty-print', false)
  .action(async (runId: string, opts: { pretty?: boolean }) => {
    try {
      const run = runManager.getRun(runId);
      if (!run) {
        console.error(`❌ Run "${runId}" not found`);
        process.exit(1);
      }
      printJSON({ status: 'success', run }, opts.pretty);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── run resume <runId> ──────────────────────────────────────────────────────
const runResume = new Command('resume')
  .description('Resume an interrupted run with latest phase, artifacts, and suggested next action')
  .addArgument(new Argument('<runId>', 'Run ID'))
  .option('--pretty', 'Pretty-print', false)
  .action(async (runId: string, opts: { pretty?: boolean }) => {
    try {
      const resume = runManager.resumeRun(runId);
      printJSON({ status: 'success', resume }, opts.pretty);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── run save <runId> ────────────────────────────────────────────────────────
const runSave = new Command('save')
  .description('Save a stage artifact to a run (reads JSON from stdin or --content)')
  .addArgument(new Argument('<runId>', 'Run ID'))
  .requiredOption('--type <type>', 'Artifact type', (v) => {
    const valid = [
      'opportunity', 'context', 'workspace', 'patch',
      'evidence', 'governance', 'pr_draft', 'result',
    ];
    if (!valid.includes(v)) {
      throw new Error(`Invalid type "${v}". Must be one of: ${valid.join(', ')}`);
    }
    return v;
  })
  .option('--content <json>', 'Artifact payload as JSON string')
  .option('--phase <phase>', 'Phase to auto-advance to')
  .option('--pretty', 'Pretty-print', false)
  .action(async (runId: string, opts: { type: string; content?: string; phase?: string; pretty?: boolean }) => {
    let payload: string | Record<string, unknown>;
    if (opts.content) {
      payload = (parseJSON(opts.content, '--content') as Record<string, unknown>) || {};
    } else {
      const stdinData = await readStdin();
      if (!stdinData) {
        console.error('❌ No content provided. Use --content <json> or pipe via stdin');
        process.exit(1);
      }
      payload = (parseJSON(stdinData, 'stdin') as Record<string, unknown>) || {};
    }
    try {
      const saved = runManager.saveArtifact(
        runId,
        opts.type as any,
        payload,
        opts.phase as any,
      );
      printJSON({ status: 'success', saved }, opts.pretty);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const runCommand = new Command('run')
  .description('Manage auditable contribution run sessions under ~/.opencontrib/runs/')
  .addCommand(runCreate)
  .addCommand(runGet)
  .addCommand(runResume)
  .addCommand(runSave);