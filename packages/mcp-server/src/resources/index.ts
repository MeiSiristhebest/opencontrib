import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ContributionRunManager, RepoMemoryLedger, runDoctorAudit } from '@opencontrib/core';

export function registerResources(
  server: McpServer,
  memory: RepoMemoryLedger,
  runManager: ContributionRunManager,
): void {
  // Resource 1: opencontrib://doctor
  server.resource(
    'opencontrib-doctor-report',
    'opencontrib://doctor',
    async (uri) => {
      const report = runDoctorAudit();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(report, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // Resource 2: opencontrib://memory
  server.resource(
    'opencontrib-memory-ledger',
    'opencontrib://memory',
    async (uri) => {
      const report = memory.getMemoryReport();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(report, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // Resource 3: opencontrib://runs
  server.resource(
    'opencontrib-runs-list',
    'opencontrib://runs',
    async (uri) => {
      const runs = runManager.listRuns();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(runs, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );
}
