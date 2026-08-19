/** `opencontrib doctor` — Host environment health audit. */

import { Command } from 'commander';
import { runDoctorAudit } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

export const doctorCommand = new Command('doctor')
  .description('Audit host environment health (Git, Node/Bun, Docker, WSL, storage)')
  .option('--pretty', 'Pretty-print output with indentation', false)
  .action(async (opts: { pretty?: boolean }) => {
    const report = runDoctorAudit();
    printJSON({ status: 'success', report }, opts.pretty);
  });