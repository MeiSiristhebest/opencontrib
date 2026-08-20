import { Command } from 'commander';
import { createDefaultPluginHost } from '@opencontrib/core';
import { extractRepoFingerprint } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';
import * as path from 'path';

export const capabilityCommand = new Command('capability')
  .alias('cap')
  .description('Inspect, score, and route OpenContrib agent capabilities (Level 0 ~ Level 3)');

capabilityCommand
  .command('list')
  .description('List available capability domains (Level 0) and detailed capability types (Level 1)')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (opts) => {
    try {
      const host = await createDefaultPluginHost();
      const level0 = host.router.getLevel0Domains();
      const level1 = host.router.getLevel1Capabilities();
      const providers = host.router.listProviders();

      printJSON(
        {
          status: 'success',
          level0Domains: level0,
          level1Capabilities: level1,
          providersCount: providers.length,
          providers: providers.map((p) => ({
            id: p.providerId,
            name: p.name,
            capability: p.capability,
            defectCategory: p.defectCategory,
            languages: p.languages,
            detects: p.detects,
            cost: p.cost,
            isCore: p.isCore,
          })),
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to list capabilities: ${err.message}`);
      process.exit(1);
    }
  });

capabilityCommand
  .command('plan [targetPath]')
  .description('Run the Capability Scoring Engine against a repository and generate a ranked execution plan')
  .option('--intent <intent>', 'Agent high-level intent (e.g. general, deep_security, concurrency_hunt)', 'general')
  .option('--enable-heavy', 'Enable heavy/slow scan providers (e.g. CodeQL)', false)
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (targetPath = '.', opts) => {
    try {
      const resolved = path.resolve(targetPath);
      const fingerprint = await extractRepoFingerprint(resolved);
      const host = await createDefaultPluginHost({ workspacePath: resolved });

      const plan = host.router.planRouting(fingerprint, {
        intent: opts.intent,
        enableHeavy: opts.enableHeavy,
      });

      printJSON(
        {
          status: 'success',
          plan,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to generate capability routing plan: ${err.message}`);
      process.exit(1);
    }
  });
