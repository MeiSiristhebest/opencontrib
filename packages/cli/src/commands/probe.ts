import * as fs from 'fs';
import * as path from 'path';
import { Command } from 'commander';
import {
  extractRepoFingerprint,
  negotiateProbes,
  runProbes,
  analyzeGitHotspots,
  generatePropertyTest,
  ProbeRegistry,
  createDefaultPluginHost,
  triagePointerFindings,
  ActiveSessionManager,
  type ProbeCost,
  type DefectCategory,
} from '@opencontrib/core';
import { printJSON, printPhaseGuidance } from '../utils/output.js';

function resolveTargetDirectory(target?: string): string {
  if (target && target !== '.') {
    return path.resolve(target);
  }
  const active = ActiveSessionManager.getActiveSession();
  if (active?.workspacePath && fs.existsSync(active.workspacePath)) {
    return active.workspacePath;
  }
  return path.resolve('.');
}

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
  .action(async (target, opts) => {
    try {
      const resolved = resolveTargetDirectory(target);
      const fingerprint = await extractRepoFingerprint(resolved);

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
  .option('--min-confidence <confidence>', 'Minimum finding confidence threshold (0-100)', '80')
  .option('--limit <n>', 'Maximum number of top high-value Smart Pointers to output (default: 5)', '5')
  .option('--all', 'Output all raw pointers without top-K triage', false)
  .option('--timeout <ms>', 'Per-probe execution timeout in ms', '30000')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (target, opts) => {
    try {
      const resolved = resolveTargetDirectory(target);
      const fingerprint = await extractRepoFingerprint(resolved);
      const host = await createDefaultPluginHost({ workspacePath: resolved });
      
      const only = opts.only ? opts.only.split(',').map((s: string) => s.trim()) : undefined;
      const skip = opts.skip ? opts.skip.split(',').map((s: string) => s.trim()) : undefined;

      // Negotiate active probes from both Microkernel Plugins and Probe Registry
      const matchingProbes = host.listAll().filter((probe) => {
        if (only && !only.includes(probe.id)) return false;
        if (skip && skip.includes(probe.id)) return false;
        return probe.match(fingerprint);
      });

      // Execute full plugin scan through ProbeScanScheduler
      const scanResult = await host.executeScan(resolved, matchingProbes);

      // Rank and triage pointers using pure core domain function
      const minConfidence = parseInt(opts.minConfidence ?? '80', 10);
      const limit = parseInt(opts.limit ?? '5', 10);
      const triaged = triagePointerFindings(scanResult.pointersCreated, {
        limit,
        minConfidence,
        includeAll: Boolean(opts.all),
      });

      printJSON(
        {
          status: 'success',
          target: resolved,
          executedProbes: scanResult.executedProbes,
          totalPointersCount: scanResult.pointersCreated.length,
          triagedPointersCount: triaged.triagedCount,
          triageSummary: triaged.summary,
          topPointers: triaged.topPointers,
        },
        opts.pretty,
      );

      const firstPointer = triaged.topPointers[0];
      const nextCmd = firstPointer
        ? `opencontrib pointer resolve ${firstPointer.uri} --view slice`
        : `opencontrib pointer list`;

      printPhaseGuidance({
        currentPhase: 'PROBE_COMPLETED',
        status: 'SUCCESS',
        humanCheckpoint: 'Checkpoint 1 (Review Smart Pointer Findings)',
        nextCommand: nextCmd,
        forbiddenActions: [
          'DO NOT perform blind sequential file reads (> 3 views) across the repository.',
          'Pinpoint symbols and defect context strictly via Smart Pointer slices (ptr://...).',
        ],
        invariants: [
          'Pointers have been persisted to session store and can be dereferenced via opencontrib pointer resolve.',
        ],
      });
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
  .action((target, opts) => {
    try {
      const resolved = resolveTargetDirectory(target);
      const result = analyzeGitHotspots(resolved, {
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
  .action(async (target, opts) => {
    try {
      const resolved = resolveTargetDirectory(target);
      const fingerprint = await extractRepoFingerprint(resolved);

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
