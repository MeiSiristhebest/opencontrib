import { Command } from 'commander';
import { createDefaultPluginHost } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

export const pluginCommand = new Command('plugin')
  .description('Manage OpenContrib microkernel plugins, probe extensions, and SAST adapters');

pluginCommand
  .command('list')
  .description('List all active plugins and probes in the microkernel')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (opts) => {
    try {
      const host = await createDefaultPluginHost();
      const plugins = host.listPlugins();
      const probes = host.listAll();

      printJSON(
        {
          status: 'success',
          pluginsCount: plugins.length,
          probesCount: probes.length,
          plugins,
          probes: probes.map((p) => ({
            id: p.id,
            name: p.name,
            category: p.category,
            description: p.description,
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
  .command('info <probeId>')
  .description('Get detailed information for a specific active probe')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (probeId, opts) => {
    try {
      const host = await createDefaultPluginHost();
      const probe = host.get(probeId);

      if (!probe) {
        console.error(`❌ Probe not found: "${probeId}"`);
        process.exit(1);
      }

      printJSON(
        {
          status: 'success',
          probe: {
            id: probe.id,
            name: probe.name,
            category: probe.category,
            description: probe.description,
          },
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to get probe info: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('doctor')
  .description('Run a health diagnostic on all probes: binaries, permissions, and dependencies')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (opts) => {
    try {
      const host = await createDefaultPluginHost();
      const probes = host.listAll();

      const diagnostics = probes.map((p) => {
        const requiredBinaries = (p.requiredBinaries || []);
        const availableBinaries: string[] = [];
        const missingBinaries: string[] = [];

        for (const bin of requiredBinaries) {
          if (host.isBinaryAvailable(bin)) {
            availableBinaries.push(bin);
          } else {
            missingBinaries.push(bin);
          }
        }

        return {
          id: p.id,
          name: p.name,
          category: p.category,
          requiredBinaries,
          availableBinaries,
          missingBinaries,
          status: missingBinaries.length === 0 ? 'healthy' : 'degraded',
        };
      });

      const healthy = diagnostics.filter((d) => d.status === 'healthy').length;
      const degraded = diagnostics.filter((d) => d.status === 'degraded').length;

      const summary = {
        status: degraded === 0 ? 'healthy' : 'degraded',
        totalProbes: probes.length,
        healthy,
        degraded,
        diagnostics,
      };

      if (opts.pretty) {
        printJSON(summary, true);
      } else {
        console.log(`\n🩺 OpenContrib Probe Doctor Report`);
        console.log(`  Total probes: ${probes.length}  |  Healthy: ${healthy}  |  Degraded: ${degraded}\n`);
        for (const d of diagnostics) {
          const icon = d.status === 'healthy' ? '✅' : '⚠️';
          console.log(`  ${icon} ${d.id} (${d.name})`);
          if (d.missingBinaries.length > 0) {
            console.log(`     Missing: ${d.missingBinaries.join(', ')}`);
          }
        }
        console.log('');
      }
    } catch (err: any) {
      console.error(`❌ Failed to run doctor: ${err.message}`);
      process.exit(1);
    }
  });
