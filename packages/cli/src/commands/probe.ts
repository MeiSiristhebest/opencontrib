import { Command } from 'commander';
import {
  extractRepoFingerprint,
  negotiateProbes,
  runProbes,
  analyzeGitHotspots,
  generatePropertyTest,
  ProbeRegistry,
  type ProbeCost,
  type DefectCategory,
} from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

export const probeCommand = new Command('probe')
  .description('Progressive probe discovery, repository fingerprinting, hotspot forensics, and targeted scanning');

probeCommand
  .command('plan [target]')
  .description('Extract repository fingerprint and negotiate active probes without executing them')
  .option('--only <probes>', 'Comma-separated probe names to exclusively consider')
  .option('--skip <probes>', 'Comma-separated probe names to ignore')
  .option('--max-cost <cost>', 'Maximum allowed execution cost: fast, medium, deep', 'medium')
  .option('--no-check-binaries', 'Skip checking host binary existence')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (target = '.', opts) => {
    try {
      const fingerprint = await extractRepoFingerprint(target);
      const only = opts.only ? opts.only.split(',').map((s: string) => s.trim()) : undefined;
      const skip = opts.skip ? opts.skip.split(',').map((s: string) => s.trim()) : undefined;

      const plan = negotiateProbes(
        fingerprint,
        {
          only,
          skip,
          maxCost: opts.maxCost as ProbeCost,
          checkBinaries: opts.checkBinaries,
        },
        new ProbeRegistry(),
      );

      printJSON(
        {
          status: 'success',
          plan,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Probe planning failed: ${err.message}`);
      process.exit(1);
    }
  });

probeCommand
  .command('run [target]')
  .description('Negotiate and execute targeted probes against repository, returning normalized findings')
  .option('--only <probes>', 'Comma-separated probe names to exclusively consider')
  .option('--skip <probes>', 'Comma-separated probe names to ignore')
  .option('--max-cost <cost>', 'Maximum allowed execution cost: fast, medium, deep', 'medium')
  .option('--min-score <score>', 'Minimum PR potential score threshold (0-100)', '0')
  .option('--timeout <ms>', 'Per-probe execution timeout in ms', '30000')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (target = '.', opts) => {
    try {
      const fingerprint = await extractRepoFingerprint(target);
      const only = opts.only ? opts.only.split(',').map((s: string) => s.trim()) : undefined;
      const skip = opts.skip ? opts.skip.split(',').map((s: string) => s.trim()) : undefined;

      const plan = negotiateProbes(
        fingerprint,
        {
          only,
          skip,
          maxCost: opts.maxCost as ProbeCost,
        },
        new ProbeRegistry(),
      );

      const result = await runProbes(plan, {
        timeoutMs: parseInt(opts.timeout, 10),
        minScore: parseInt(opts.minScore, 10),
      });

      printJSON(
        {
          status: 'success',
          result,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Probe execution failed: ${err.message}`);
      process.exit(1);
    }
  });

probeCommand
  .command('hotspot [target]')
  .description('Run Code as a Crime Scene Git churn and cyclomatic complexity hotspot analysis')
  .option('--limit <number>', 'Number of top hotspot files to return', '5')
  .option('--since-months <number>', 'Months of commit history to inspect', '6')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action((target = '.', opts) => {
    try {
      const result = analyzeGitHotspots(target, {
        limit: parseInt(opts.limit, 10),
        sinceMonths: parseInt(opts.sinceMonths, 10),
      });

      printJSON(
        {
          status: 'success',
          result,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Hotspot analysis failed: ${err.message}`);
      process.exit(1);
    }
  });

probeCommand
  .command('fuzz [target]')
  .description('Generate property-based boundary fuzzing test harness for target repo language & defect category')
  .option('--category <category>', 'Target defect category (e.g. numerical_bounds, protocol_drift, distributed_cache)', 'numerical_bounds')
  .option('--function-name <name>', 'Target function to fuzz', 'processInput')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (target = '.', opts) => {
    try {
      const fingerprint = await extractRepoFingerprint(target);
      const langLower = fingerprint.primaryLanguage.toLowerCase();
      const lang = ['typescript', 'javascript', 'python', 'rust', 'go'].includes(langLower)
        ? (langLower as any)
        : 'typescript';

      const spec = generatePropertyTest(opts.category as DefectCategory, lang, opts.functionName);

      printJSON(
        {
          status: 'success',
          spec,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Fuzz harness generation failed: ${err.message}`);
      process.exit(1);
    }
  });
