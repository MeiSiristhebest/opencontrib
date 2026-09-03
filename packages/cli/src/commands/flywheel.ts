/** `opencontrib flywheel <sub>` — Profile flywheel and PR tracking. */

import { Command } from 'commander';
import { ProfileFlywheel, buildContributionRunManager, defaultActiveSessionManager, type ContributionRunManager } from '@opencontrib/core';
import { printJSON, parseJSON, readStdin, printPhaseGuidance } from '../utils/output.js';
import * as fs from 'fs';

const flywheel = new ProfileFlywheel();
// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

// ─── flywheel sync ────────────────────────────────────────────────────────────
const flywheelSync = new Command('sync')
  .description('Persist contribution memory, update skill weights, refine heuristics')
  .requiredOption('--repo <name>', 'Repository full name')
  .option('-f, --input-file <path>', 'Path to JSON file containing record')
  .option('--input <json>', 'Record JSON (runId, status, techStack, etc.)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { repo: string; inputFile?: string; input?: string; pretty?: boolean }) => {
    try {
      let input = '';
      if (opts.inputFile && fs.existsSync(opts.inputFile)) {
        input = fs.readFileSync(opts.inputFile, 'utf-8');
      } else if (opts.input) {
        input = opts.input;
      } else {
        input = await readStdin();
      }
      const parsed = (parseJSON(input, 'stdin/--input') as any) || {};

      const runId = parsed.runId || getRunManager().resolveRunId();
      const status = parsed.status || 'submitted';
      const techStack = parsed.techStack && parsed.techStack.length > 0 ? parsed.techStack : ['general'];

      if (!runId) {
        console.error('❌ Missing runId (no active session found and not provided in input JSON)');
        process.exit(1);
      }

      const result = await flywheel.recordContribution(opts.repo, {
        id: runId,
        repoFullName: opts.repo,
        issueNumber: parsed.issueNumber,
        issueTitle: parsed.issueTitle || '',
        prNumber: parsed.prNumber,
        prUrl: parsed.prUrl || '',
        status,
        provenance: parsed.provenance || { source: 'agent_claim', verified: false },
        submittedAt: parsed.submittedAt || new Date().toISOString(),
        mergedAt: parsed.mergedAt,
        closedAt: parsed.closedAt,
        diffStat: parsed.diffStat || '',
        evidenceSummary: parsed.evidenceSummary || '',
      } as any);

      try {
        getRunManager().saveArtifact(runId, 'result', { flywheelResult: result, status } as any, 'COMPLETED');
        defaultActiveSessionManager.updatePhase('COMPLETED');
      } catch {
        // Flywheel artifact persistence is best-effort; the result is still
        // reported to stdout below even if the manifest write fails.
      }

      printJSON({ status: 'success', flywheelResult: result }, opts.pretty);

      printPhaseGuidance({
        currentPhase: 'COMPLETED',
        runId,
        status: 'SUCCESS',
        invariants: [
          'All 9 phases of OpenContrib contribution engine completed successfully.',
          'Memory ledger and developer heuristics synchronized.',
        ],
      });
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── flywheel pr-track ────────────────────────────────────────────────────────
const prTrackCommand = new Command('pr-track')
  .description('Track PR merge readiness, CI checks, and review feedback')
  .option('-f, --input-file <path>', 'Path to JSON file containing PR track data')
  .option('--input <json>', 'JSON with pr, reviews, checkRuns, comments')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { inputFile?: string; input?: string; pretty?: boolean }) => {
    try {
      let input = '';
      if (opts.inputFile && fs.existsSync(opts.inputFile)) {
        input = fs.readFileSync(opts.inputFile, 'utf-8');
      } else if (opts.input) {
        input = opts.input;
      } else {
        input = await readStdin();
      }
      const parsed = parseJSON(input, 'stdin/--input') as any;

      if (!parsed?.pr) {
        console.error('❌ Missing required "pr" field in input JSON');
        process.exit(1);
      }
      const { trackPrStatus } = await import('@opencontrib/core');
      const evaluation = trackPrStatus({
        pr: parsed.pr,
        reviews: (parsed.reviews || []).map((r: any) => ({
          id: r.id,
          user: r.user,
          state: r.state,
          body: r.body,
          submittedAt: r.submittedAt,
        })),
        checkRuns: (parsed.checkRuns || []).map((c: any) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          detailsUrl: c.detailsUrl,
        })),
        comments: (parsed.comments || []).map((c: any) => ({
          id: c.id,
          user: c.user,
          body: c.body,
          createdAt: c.createdAt,
        })),
      });
      printJSON({ status: 'success', evaluation }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const flywheelCommand = new Command('flywheel')
  .description('Profile flywheel persistence and PR lifecycle tracking')
  .addCommand(flywheelSync)
  .addCommand(prTrackCommand);