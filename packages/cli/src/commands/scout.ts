/** `opencontrib scout <target>` — Discover high-value contribution opportunities. */

import { Command, Argument } from 'commander';
import { scoutOpportunities } from '@opencontrib/core';
import { printJSON, printPhaseGuidance } from '../utils/output.js';

export const scoutCommand = new Command('scout')
  .description('Scout high-value, unclaimed contribution opportunities for a repo or org')
  .addArgument(new Argument('<target>', 'Repo full name (owner/repo) or org name'))
  .option('--tech-stack <list>', 'Developer tech stack keywords, comma-separated', (v) => v.split(','))
  .option('--focus <list>', 'Focus areas, comma-separated', (v) => v.split(','))
  .option('--limit <n>', 'Max candidates to return', (v) => Number(v), 5)
  .option('--min-stars <n>', 'Minimum repository stars', (v) => Number(v), 50)
  .option('--token <token>', 'GitHub token (or set GITHUB_TOKEN env)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (target: string, opts: {
    techStack?: string[];
    focus?: string[];
    limit?: number;
    minStars?: number;
    token?: string;
    pretty?: boolean;
  }) => {
    try {
      const profile = {
        techStack: opts.techStack ?? ['typescript', 'javascript'],
        focusAreas: opts.focus ?? ['bugfix', 'testing', 'docs'],
        proficiency: 'intermediate' as const,
        minMatchScore: 60,
      };
      const isOrg = !target.includes('/');
      const opportunities = await scoutOpportunities(profile, {
        repo: isOrg ? undefined : target,
        limit: opts.limit ?? 5,
        minStars: opts.minStars ?? (isOrg ? 100 : 0),
        githubToken: opts.token || process.env.GITHUB_TOKEN,
      });

      printJSON({ status: 'success', target, foundCount: opportunities.length, opportunities }, opts.pretty);

      const top = opportunities[0];
      const nextCmd = top
        ? `opencontrib workspace prepare --repo ${top.repoFullName} --issue ${top.issueNumber}`
        : `opencontrib workspace prepare --repo ${target} --issue <id>`;

      printPhaseGuidance({
        currentPhase: 'OPPORTUNITY_SCOUTED',
        status: 'SUCCESS',
        humanCheckpoint: 'Checkpoint 1 (Candidate Issue Selection)',
        nextCommand: nextCmd,
        forbiddenActions: [
          'DO NOT select issues that have existing PRs or active claims by other developers.',
          'DO NOT begin editing without preparing an isolated Git worktree.',
        ],
      });
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });