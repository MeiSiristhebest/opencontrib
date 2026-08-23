/** `opencontrib flywheel <sub>` — Profile flywheel and PR tracking. */

import { Command } from 'commander';
import { ProfileFlywheel } from '@opencontrib/core';
import { printJSON, parseJSON, readStdin } from '../utils/output.js';

const flywheel = new ProfileFlywheel();

// ─── flywheel sync ────────────────────────────────────────────────────────────
const flywheelSync = new Command('sync')
  .description('Persist contribution memory, update skill weights, refine heuristics')
  .requiredOption('--repo <name>', 'Repository full name')
  .option('--input <json>', 'Record JSON (runId, status, techStack, etc.)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { repo: string; input?: string; pretty?: boolean }) => {
    try {
      const input = opts.input || await readStdin();
      const parsed = parseJSON(input, 'stdin/--input') as any;
      if (!parsed?.runId || !parsed.status || !parsed.techStack) {
        console.error('❌ Missing required fields: runId, status, techStack');
        process.exit(1);
      }
      const result = await flywheel.recordContribution(opts.repo, {
        id: parsed.runId,
        repoFullName: opts.repo,
        issueNumber: parsed.issueNumber,
        issueTitle: parsed.issueTitle || '',
        prNumber: parsed.prNumber,
        prUrl: parsed.prUrl || '',
        status: parsed.status,
        provenance: parsed.provenance || { source: 'agent_claim', verified: false },
        submittedAt: parsed.submittedAt || new Date().toISOString(),
        mergedAt: parsed.mergedAt,
        closedAt: parsed.closedAt,
        diffStat: parsed.diffStat || '',
        evidenceSummary: parsed.evidenceSummary || '',
      } as any);
      printJSON({ status: 'success', flywheelResult: result }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── flywheel pr-track ────────────────────────────────────────────────────────
const prTrackCommand = new Command('pr-track')
  .description('Track PR merge readiness, CI checks, and review feedback')
  .option('--input <json>', 'JSON with pr, reviews, checkRuns, comments')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { input?: string; pretty?: boolean }) => {
    try {
      const input = opts.input || await readStdin();
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