#!/usr/bin/env node

import { Command } from 'commander';

import { doctorCommand } from './commands/doctor.js';
import { discoveryCommand } from './commands/discovery.js';
import { probeCommand } from './commands/probe.js';
import { capabilityCommand } from './commands/capability.js';
import { configCommand } from './commands/config.js';
import { verifyCommand } from './commands/verify.js';
import { pluginCommand } from './commands/plugin.js';
import { pointerCommand } from './commands/pointer.js';
import { evidenceCommand } from './commands/evidence.js';
import { flywheelCommand } from './commands/flywheel.js';
import { governanceCommand } from './commands/governance.js';
import { runCommand } from './commands/run.js';
import { scoutCommand } from './commands/scout.js';
import { workspaceCommand } from './commands/workspace.js';
import { evalCommand } from './commands/eval.js';
import { setupCommand } from './commands/setup.js';

const program = new Command();

program
  .name('opencontrib')
  .description('Agent-Native Open Source Contribution Engine — CLI')
  .version('1.0.0')
  .option('--home <dir>', 'Set custom OpenContrib home directory (overrides ~/.opencontrib and OPENCONTRIB_HOME env)', process.env.OPENCONTRIB_HOME)
  .hook('preAction', (parsed) => {
    if (parsed.options.home && typeof parsed.options.home === 'string') {
      process.env.OPENCONTRIB_HOME = parsed.options.home;
    }
  })
  .configureHelp({
    subcommandTerm: (cmd) => cmd.name() + ((cmd.options as any[]).length ? ' [options]' : ''),
    argumentTerm: (arg) => `<${arg.name()}>`,
  });

program.addCommand(doctorCommand);
program.addCommand(discoveryCommand);
program.addCommand(probeCommand);
program.addCommand(capabilityCommand);
program.addCommand(configCommand);
program.addCommand(verifyCommand);
program.addCommand(pluginCommand);
program.addCommand(pointerCommand);
program.addCommand(evidenceCommand);
program.addCommand(flywheelCommand);
program.addCommand(governanceCommand);
program.addCommand(runCommand);
program.addCommand(scoutCommand);
program.addCommand(workspaceCommand);
program.addCommand(evalCommand);
program.addCommand(setupCommand);

// Graceful shutdown on SIGINT / SIGTERM
const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
  console.error(`\n⚠️  OpenContrib received ${signal}. Shutting down gracefully...`);
  process.exit(signal === 'SIGINT' ? 130 : 143);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

program.parse();