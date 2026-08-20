import { Command } from 'commander';
import * as fs from 'fs';
import { ProbeRegistry, type ProbeManifest } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

export const pluginCommand = new Command('plugin')
  .description('Manage OpenContrib probe plugins, custom scanners, and external SAST adapters');

pluginCommand
  .command('list')
  .description('List all registered builtin and custom probe plugins')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action((opts) => {
    try {
      const registry = new ProbeRegistry();
      const plugins = registry.listAll();

      printJSON(
        {
          status: 'success',
          count: plugins.length,
          plugins: plugins.map((p) => ({
            name: p.name,
            version: p.version,
            description: p.description,
            category: p.category,
            author: p.author || 'community',
            languages: p.activation.languages,
            manifests: p.activation.manifestFiles || [],
            requiresBinaries: p.activation.requiresBinaries || [],
            cost: p.execution.cost,
            stage: p.execution.stage,
          })),
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to list plugins: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('add <manifestFileOrJson>')
  .description('Register a new custom probe plugin manifest')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action((input, opts) => {
    try {
      let manifest: ProbeManifest;
      if (fs.existsSync(input)) {
        const content = fs.readFileSync(input, 'utf8');
        manifest = JSON.parse(content);
      } else {
        manifest = JSON.parse(input);
      }

      const registry = new ProbeRegistry();
      registry.saveToDisk(manifest);

      printJSON(
        {
          status: 'success',
          message: `Probe plugin "${manifest.name}" registered successfully.`,
          manifest,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to add plugin: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('remove <name>')
  .description('Remove a custom probe plugin by name')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action((name, opts) => {
    try {
      const registry = new ProbeRegistry();
      const removed = registry.unregister(name);

      if (!removed) {
        console.error(`❌ Cannot remove builtin probe or probe not found: "${name}"`);
        process.exit(1);
      }

      printJSON(
        {
          status: 'success',
          message: `Probe plugin "${name}" removed successfully.`,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to remove plugin: ${err.message}`);
      process.exit(1);
    }
  });
