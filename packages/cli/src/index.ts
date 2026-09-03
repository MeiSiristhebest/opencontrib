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
import { displayFirstRunBannerIfNeeded } from './utils/banner.js';
import { sendAnonymousPing } from './utils/telemetry.js';
import { CliExitError } from './utils/exit.js';

const program = new Command();

program
  .name('opencontrib')
  .description('Agent-Native Open Source Contribution Engine — CLI')
  .version('1.0.0')
  .option('--home <dir>', 'Set custom OpenContrib home directory (overrides ~/.opencontrib and OPENCONTRIB_HOME env)', process.env.OPENCONTRIB_HOME)
  .hook('preAction', (thisCommand, actionCommand) => {
    if ((thisCommand.opts() as any).home && typeof (thisCommand.opts() as any).home === 'string') {
      process.env.OPENCONTRIB_HOME = (thisCommand.opts() as any).home;
    }
    // 1. Display onboarding banner on first interactive run
    displayFirstRunBannerIfNeeded(process.env.OPENCONTRIB_HOME);
    // 2. Dispatch lightweight non-blocking telemetry heartbeat
    const cmdName = actionCommand ? actionCommand.name() : thisCommand.name();
    sendAnonymousPing(cmdName, '1.0.0');
  })
  .configureHelp({
    subcommandTerm: (cmd) => cmd.name() + ((cmd.options as any[]).length ? ' [options]' : ''),
    argumentTerm: (arg) => `<${arg.name()}>`,
  })
  .addHelpText('after', `
⭐ Star OpenContrib on GitHub: https://github.com/MeiSiristhebest/opencontrib
💬 Found a defect or feature request? Open an issue: https://github.com/MeiSiristhebest/opencontrib/issues
`);

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

// Boundary: the single place that owns process termination. Command actions
// signal intent via `CliExitError` (passive view) and never call process.exit
// themselves; here we translate that signal into the real exit code. Any other
// unexpected rejection is surfaced with a stack trace and a non-zero exit.
program
  .parseAsync()
  .catch((err: unknown) => {
    if (err instanceof CliExitError) {
      process.exit(err.exitCode);
    }
    console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
    process.exit(1);
  });