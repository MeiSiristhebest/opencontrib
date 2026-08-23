/** `opencontrib setup` — Toolchain installation and environment setup. */

import { spawnSync } from 'node:child_process';
import { Command } from 'commander';
import {
  TOOL_REGISTRY,
  currentPlatform,
  isBinaryOnPath,
  areBinariesOnPath,
  getInstallSteps,
  type ToolRegistryEntry,
} from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

interface SetupResult {
  status: 'success' | 'error' | 'partial';
  platform: string;
  tools: Array<{
    id: string;
    name: string;
    installed: boolean;
    installSteps?: Array<{ cmd: string; desc: string }>;
    installNote?: string;
  }>;
  summary: {
    total: number;
    alreadyInstalled: number;
    installed: number;
    failed: number;
    skipped: number;
  };
}

export const setupCommand = new Command('setup')
  .description('Check installed tools and install missing ones')
  .option('--install', 'Auto-install all missing tools', false)
  .option('--only <tools>', 'Only check/install specified tool IDs (comma-separated)')
  .option('--pretty', 'Pretty-print output', false)
  .action(async (opts: { install?: boolean; only?: string; pretty?: boolean }) => {
    try {
      const platform = currentPlatform();
      let toolIds: string[];

      if (opts.only) {
        toolIds = opts.only.split(',').map((t) => t.trim()).filter(Boolean);
      } else {
        toolIds = TOOL_REGISTRY.map((t) => t.id);
      }

      const validIds = new Set(TOOL_REGISTRY.map((t) => t.id));
      const invalid = toolIds.filter((id) => !validIds.has(id));
      if (invalid.length > 0) {
        printJSON({
          status: 'error',
          message: `Unknown tool IDs: ${invalid.join(', ')}. Valid: ${Array.from(validIds).join(', ')}`,
        }, opts.pretty);
        process.exit(1);
      }

      const results = TOOL_REGISTRY.filter((t) => toolIds.includes(t.id)).map((entry) => {
        const found = entry.bin.some((bin) => isBinaryOnPath(bin));
        return {
          id: entry.id,
          name: entry.name,
          installed: found,
          installSteps: found ? undefined : getInstallSteps(entry.id),
          installNote: entry.installNote,
        };
      });

      const alreadyInstalled = results.filter((r) => r.installed).length;
      const missing = results.filter((r) => !r.installed);

      let installedCount = 0;
      let failedCount = 0;

      if (opts.install) {
        const isWindows = platform === 'win32';
        for (const tool of missing) {
          if (!tool.installSteps || tool.installSteps.length === 0) {
            printJSON({ status: 'error', message: `No install method for ${tool.id}` }, opts.pretty);
            failedCount++;
            continue;
          }

          const step = tool.installSteps[0];
          const shell = isWindows ? 'cmd.exe' : 'sh';
          const shellArgs = isWindows ? ['/c', step.cmd] : ['-c', step.cmd];

          try {
            const child = spawnSync(shell, shellArgs, {
              encoding: 'utf-8',
              timeout: 60_000,
              stdio: ['ignore', 'pipe', 'pipe'],
            });
            const ok = child.status === 0;
            if (ok) { installedCount++; } else { failedCount++; }
          } catch (err: any) {
            console.error(`Failed to install ${tool.id}: ${err.message}`);
            failedCount++;
          }
        }
      }

      const result: SetupResult = {
        status: failedCount > 0 && installedCount === 0 ? 'error' : failedCount > 0 ? 'partial' : 'success',
        platform,
        tools: results,
        summary: {
          total: results.length,
          alreadyInstalled,
          installed: installedCount,
          failed: failedCount,
          skipped: 0,
        },
      };

      printJSON(result, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });
