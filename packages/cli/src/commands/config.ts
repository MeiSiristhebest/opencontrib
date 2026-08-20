import { Command } from 'commander';
import { loadWorkspaceConfig, initWorkspaceConfig } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';
import * as path from 'path';

export const configCommand = new Command('config')
  .description('Manage and inspect OpenContrib capability configuration and security policies');

configCommand
  .command('init [workspacePath]')
  .description('Generate an initial .opencontrib.json configuration file in the target workspace')
  .option('--pretty', 'Pretty-print output', false)
  .action((workspacePath = '.', opts) => {
    try {
      const resolved = path.resolve(workspacePath);
      const filePath = initWorkspaceConfig(resolved);
      printJSON(
        {
          status: 'success',
          message: 'Initialized OpenContrib workspace configuration',
          configFile: filePath,
          config: loadWorkspaceConfig(resolved),
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to initialize configuration: ${err.message}`);
      process.exit(1);
    }
  });

configCommand
  .command('show [workspacePath]')
  .description('Display the active effective OpenContrib capability configuration and policies')
  .option('--pretty', 'Pretty-print output', false)
  .action((workspacePath = '.', opts) => {
    try {
      const resolved = path.resolve(workspacePath);
      const config = loadWorkspaceConfig(resolved);
      printJSON(
        {
          status: 'success',
          workspacePath: resolved,
          config,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Failed to load configuration: ${err.message}`);
      process.exit(1);
    }
  });
