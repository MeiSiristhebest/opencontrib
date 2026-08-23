/** `opencontrib doctor` — Host environment health audit. */

import { Command } from 'commander';
import { runDoctorAudit } from '@opencontrib/core';
import { printJSON, printTable } from '../utils/output.js';

export const doctorCommand = new Command('doctor')
  .description('Audit host environment health (Git, Node/Bun, Docker, WSL, storage)')
  .option('--pretty', 'Render output as an ASCII table', false)
  .option('--json', 'Force JSON output (default is table)', false)
  .action(async (opts: { pretty?: boolean; json?: boolean }) => {
    const report = runDoctorAudit();

    const useTable = opts.pretty || !opts.json;

    if (useTable) {
      const rows = report.checks.map((c) => ({
        category: c.category,
        name: c.name,
        status: c.status === 'PASSED' ? 'PASSED' : c.status === 'WARNING' ? 'WARNING' : 'FAILED',
        message: c.message.length > 60 ? c.message.slice(0, 57) + '...' : c.message,
      }));

      console.log(`\n  🩺 OpenContrib Doctor — Overall: ${report.overallHealth}\n`);
      console.log(`  Environment: ${report.environment.os} | Node ${report.environment.nodeVersion}\n`);
      printTable(rows, ['category', 'name', 'status', 'message']);
      console.log('');
    } else {
      printJSON({ status: 'success', report }, true);
    }
  });
