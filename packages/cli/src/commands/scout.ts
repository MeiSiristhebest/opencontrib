/** `opencontrib scout <target>` — Discover high-value contribution opportunities. */

import { Command, Argument } from 'commander';
import { scoutOpportunities } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

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
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });