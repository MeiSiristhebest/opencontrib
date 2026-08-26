import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ContributionRunManager } from '@opencontrib/core';

export function registerRunTools(server: McpServer, runManager: ContributionRunManager): void {
  // -------------------------------------------------------------
  // Tool: contrib_create_run (贡献会话初始化与会话目录锚定)
  // -------------------------------------------------------------
  server.tool(
    'contrib_create_run',
    'Initialize an auditable contribution run session under ~/.opencontrib/runs/<runId>/ for structured state and artifact tracking',
    {
      repoFullName: z.string().describe('Target repository full name, e.g. "owner/repo"'),
      issueNumber: z.number().optional().describe('Optional issue number associated with this contribution run'),
      issueTitle: z.string().optional().describe('Optional issue title'),
      tags: z.array(z.string()).optional().describe('Optional tags for indexing and telemetry'),
    },
    async (args) => {
      try {
        const manifest = runManager.createRun({
          repoFullName: args.repoFullName,
          issueNumber: args.issueNumber,
          issueTitle: args.issueTitle,
          tags: args.tags,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  manifest,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Security error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_save_artifact (阶段性物证快照落盘)
  // -------------------------------------------------------------
  server.tool(
    'contrib_save_artifact',
    'Save discrete stage artifact (opportunity, context, workspace, patch, evidence, governance, pr_draft, result) to run bundle',
    {
      runId: z.string().describe('Unique contribution run ID'),
      artifactType: z.enum([
        'opportunity',
        'probe',
        'context',
        'workspace',
        'poc',
        'patch',
        'evidence',
        'governance',
        'pr_draft',
        'result',
      ]),
      content: z.union([z.string(), z.record(z.unknown())]).describe('Artifact payload or raw markdown/diff string'),
      autoAdvancePhase: z
        .enum([
          'INITIALIZED',
          'OPPORTUNITY_SCOUTED',
          'PROBE_COMPLETED',
          'CONTEXT_ASSEMBLED',
          'WORKSPACE_PREPARED',
          'POC_GENERATED',
          'PATCH_DRAFTED',
          'EVIDENCE_COLLECTED',
          'GOVERNANCE_AUDITED',
          'PR_SUBMITTED',
          'COMPLETED',
          'FAILED',
        ])
        .optional()
        .describe('Optional phase to advance run manifest to'),
    },
    async (args) => {
      try {
        const saved = runManager.saveArtifact(
          args.runId,
          args.artifactType,
          args.content,
          args.autoAdvancePhase,
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  saved,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Security error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_get_run (查询指定 Run 的完整状态与物证清单)
  // -------------------------------------------------------------
  server.tool(
    'contrib_get_run',
    'Retrieve full manifest and all saved artifacts of a contribution run',
    {
      runId: z.string().describe('Unique contribution run ID'),
    },
    async (args) => {
      try {
        const run = runManager.getRun(args.runId);
        if (!run) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Contribution run "${args.runId}" not found.` }],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  run,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Security error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_resume_run (断点恢复贡献会话)
  // -------------------------------------------------------------
  server.tool(
    'contrib_resume_run',
    'Resume an interrupted contribution run by loading its latest phase, existing artifacts, and suggested next action',
    {
      runId: z.string().describe('Unique contribution run ID to resume'),
    },
    async (args) => {
      try {
        const resume = runManager.resumeRun(args.runId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  resume,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Resume error: ${err.message}` }],
        };
      }
    },
  );
}
