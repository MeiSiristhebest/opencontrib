/** `opencontrib doctor` — Host environment health audit. */

import { Command } from 'commander';
import { runDoctorAudit } from '@opencontrib/core';
import { printJSON, printTable } from '../utils/output.js';

export const doctorCommand = new Command('doctor')
  .description('Audit host environment health (Git, Node/Bun, Docker, WSL, storage)')
  .option('--pretty', 'Render output as an ASCII table', false)
  .option('--json', 'Force JSON output (default is table)', false)
  .action(async (opts: { pretty?: boolean; json?: boolean }) => {
    try {
      const report = runDoctorAudit();

    const useTable = opts.pretty || !opts.json;

    if (useTable) {
      const rows = report.checks.map((c) => ({
        category: c.category,
        name: c.name,
        status: c.status === 'PASSED' ? 'PASSED' : c.status === 'WARNING' ? 'WARNING' : 'FAILED',
        message: c.message.length > 60 ? c.message.slice(0, 57) + '...' : c.message,
      }));

      console.log(`\n  🩺 OpenContrib Doctor — Overall Health: ${report.overallHealth}\n`);
      console.log(`  Environment: ${report.environment.os} | Node ${report.environment.nodeVersion} | Bun ${report.environment.bunVersion || 'N/A'}\n`);
      printTable(rows, ['category', 'name', 'status', 'message']);
      console.log('');

      if (report.contingenciesSummary && report.contingenciesSummary.length > 0) {
        console.log(`  🛡️  Active Contingency Plans & Fallback Strategies (${report.contingenciesSummary.length} active fallback(s)):\n`);
        for (const item of report.contingenciesSummary) {
          console.log(`  ┌── 🎯 Feature: ${item.feature}`);
          console.log(`  │   ⚠️  Impact: ${item.impactDescription}`);
          console.log(`  │   ⚡ Active Plan: ${item.activePlan}`);
          if (item.alternatives && item.alternatives.length > 0) {
            console.log(`  │   🔄 Available Alternatives:`);
            for (const alt of item.alternatives) {
              console.log(`  │      • ${alt}`);
            }
          }
          if (item.remediationAction) {
            console.log(`  │   💡 Suggested Remedy: ${item.remediationAction}`);
          }
          console.log(`  └──\n`);
        }
      }
    } else {
      printJSON({ status: 'success', report }, true);
    }
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, true);
      process.exit(1);
    }
  });
