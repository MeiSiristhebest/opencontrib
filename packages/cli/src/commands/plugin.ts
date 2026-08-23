/** `opencontrib plugin` — Manage microkernel plugins, probe extensions, and SAST adapters. */

import { Command } from 'commander';
import { createDefaultPluginHost, defaultPluginManager } from '@opencontrib/core';
import { TOOL_REGISTRY, PROBE_TOOLS_MAP, getInstallSteps, isBinaryOnPath } from '@opencontrib/core';
import { printJSON, printTable } from '../utils/output.js';

export const pluginCommand = new Command('plugin')
  .description('Manage OpenContrib microkernel plugins, probe extensions, and SAST adapters');

pluginCommand
  .command('list')
  .description('List all active plugins and probes in the microkernel')
  .option('--pretty', 'Pretty-print output as an ASCII table', false)
  .action(async (opts) => {
    try {
      const host = await createDefaultPluginHost();
      const pm = defaultPluginManager;
      const probes = host.listAll();

      const rows = probes.map((p) => {
        const state = pm.getState(p.id);
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          enabled: state.enabled ? 'yes' : 'no',
          reason: state.disabledReason || '-',
        };
      });

      if (opts.pretty) {
        printTable(rows, ['id', 'name', 'category', 'enabled', 'reason']);
      } else {
        printJSON({ status: 'success', pluginsCount: rows.length, rows }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to list plugins: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('status')
  .description('Show enable/disable status of all known plugins and tools')
  .option('--pretty', 'Pretty-print output as an ASCII table', false)
  .action(async (opts) => {
    try {
      const pm = defaultPluginManager;
      const states = pm.getAllStates();

      const rows = TOOL_REGISTRY.map((tool) => {
        const state = pm.getState(tool.id);
        const binAvailable = tool.bin.some((b) => isBinaryOnPath(b));
        return {
          tool: tool.id,
          enabled: state.enabled ? 'yes' : 'no',
          binary: binAvailable ? 'found' : 'missing',
          reason: state.disabledReason || '-',
        };
      });

      const disabledCount = Object.values(states).filter((s) => !s.enabled).length;
      const totalCount = TOOL_REGISTRY.length;

      if (opts.pretty) {
        console.log(`  OpenContrib Plugin Status — ${totalCount} tools, ${disabledCount} disabled\n`);
        printTable(rows, ['tool', 'enabled', 'binary', 'reason']);
      } else {
        printJSON({ status: 'success', total: totalCount, disabled: disabledCount, rows }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to get status: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('enable <toolId>')
  .description('Enable a plugin/tool that was previously disabled')
  .option('--pretty', 'Pretty-print output', false)
  .action(async (toolId, opts) => {
    try {
      const pm = defaultPluginManager;
      pm.enable(toolId);
      if (opts.pretty) {
        console.log(`  ✅ ${toolId} enabled`);
      } else {
        printJSON({ status: 'success', toolId }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to enable ${toolId}: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('disable <toolId> [reason]')
  .description('Disable a plugin/tool with an optional reason')
  .option('--pretty', 'Pretty-print output', false)
  .action(async (toolId, reason, opts) => {
    try {
      const pm = defaultPluginManager;
      const r = reason || 'user-disabled';
      pm.disable(toolId, r);
      if (opts.pretty) {
        console.log(`  ⛔ ${toolId} disabled — ${r}`);
      } else {
        printJSON({ status: 'success', toolId, reason: r }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to disable ${toolId}: ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('install <id>')
  .description('Install a tool or probe and its required binaries (accepts toolId or probeId)')
  .option('--pretty', 'Pretty-print output', false)
  .action(async (id, opts) => {
    try {
      let toolIds: string[];

      // Resolve probeId -> toolIds via PROBE_TOOLS_MAP
      if (PROBE_TOOLS_MAP[id]) {
        toolIds = PROBE_TOOLS_MAP[id];
        if (toolIds.length === 0) {
          console.error(`❌ Probe "${id}" has no associated tools`);
          process.exit(1);
        }
      } else {
        const entry = TOOL_REGISTRY.find((t) => t.id === id);
        if (!entry) {
          console.error(`❌ Unknown tool or probe: "${id}"`);
          process.exit(1);
        }
        toolIds = [id];
      }

      const allSteps: Array<{ toolId: string; name: string; steps: { cmd: string; desc: string }[] }> = [];
      for (const tid of toolIds) {
        const entry = TOOL_REGISTRY.find((t) => t.id === tid);
        if (entry) {
          const steps = getInstallSteps(tid);
          allSteps.push({ toolId: tid, name: entry.name, steps });
        }
      }

      if (opts.pretty) {
        console.log(`\n  📦 Installing ${allSteps.length} tool(s) for "${id}"\n`);
        for (const item of allSteps) {
          console.log(`  ${item.toolId} — ${item.name}`);
          for (const step of item.steps) {
            console.log(`    → ${step.desc}`);
            console.log(`      ${step.cmd}`);
          }
          console.log('');
        }
      } else {
        printJSON({ status: 'success', id, toolIds, steps: allSteps }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to install "${id}": ${err.message}`);
      process.exit(1);
    }
  });

pluginCommand
  .command('reset')
  .description('Reset all plugin states to defaults (everything enabled)')
  .option('--pretty', 'Pretty-print output', false)
  .action(async (opts) => {
    try {
      const pm = defaultPluginManager;
      pm.reset();
      if (opts.pretty) {
        console.log('  🔄 All plugins reset to default (enabled)');
      } else {
        printJSON({ status: 'success' }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to reset plugins: ${err.message}`);
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

      const tools = PROBE_TOOLS_MAP[probeId] || [];
      const binStatus = tools.map((t) => {
        const entry = TOOL_REGISTRY.find((e) => e.id === t);
        return {
          tool: t,
          binary: entry?.bin.some((b) => isBinaryOnPath(b)) ? 'found' : 'missing',
        };
      });

      printJSON(
        {
          status: 'success',
          probe: {
            id: probe.id,
            name: probe.name,
            category: probe.category,
            description: probe.description,
            requiredTools: tools,
            binStatus,
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
  .option('--pretty', 'Pretty-print output', false)
  .action(async (opts) => {
    try {
      const host = await createDefaultPluginHost();
      const pm = defaultPluginManager;
      const probes = host.listAll();

      const diagnostics = probes.map((p) => {
        const state = pm.getState(p.id);
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

        const isDisabled = !state.enabled;
        return {
          id: p.id,
          name: p.name,
          category: p.category,
          enabled: state.enabled,
          disabledReason: state.disabledReason || '-',
          requiredBinaries,
          availableBinaries,
          missingBinaries,
          status: isDisabled ? 'disabled' : missingBinaries.length === 0 ? 'healthy' : 'degraded',
        };
      });

      const healthy = diagnostics.filter((d) => d.status === 'healthy').length;
      const degraded = diagnostics.filter((d) => d.status === 'degraded').length;
      const disabled = diagnostics.filter((d) => d.status === 'disabled').length;

      if (opts.pretty) {
        console.log(`\n  🩺 OpenContrib Probe Doctor — ${probes.length} probes (🟢${healthy} 🟡${degraded} ⛔${disabled})\n`);
        printTable(diagnostics.map((d) => ({
          id: d.id,
          name: d.name,
          status: d.status === 'healthy' ? '🟢 healthy' : d.status === 'degraded' ? '🟡 degraded' : '⛔ disabled',
          missing: d.missingBinaries.join(', ') || 'none',
          reason: d.disabledReason,
        })), ['id', 'name', 'status', 'missing', 'reason']);
      } else {
        printJSON({
          status: degraded === 0 && disabled === 0 ? 'healthy' : 'degraded',
          totalProbes: probes.length,
          healthy,
          degraded,
          disabled,
          diagnostics,
        }, true);
      }
    } catch (err: any) {
      console.error(`❌ Failed to run doctor: ${err.message}`);
      process.exit(1);
    }
  });
