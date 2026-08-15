import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  capturePreFixAssertion,
  collectEvidence,
  ContributionRunManager,
  verifyDualStageReproduction,
} from '@opencontrib/core';

export function registerEvidenceTools(server: McpServer, runManager: ContributionRunManager): void {
  // -------------------------------------------------------------
  // Tool: contrib_collect_evidence (双阶段物证：Pre-Fix 失败断言 + Post-Fix 压测)
  // -------------------------------------------------------------
  server.tool(
    'contrib_collect_evidence',
    'Execute dual-stage empirical verification (capturing pre-fix failing baseline assertion and post-fix stress loop pass)',
    {
      cwd: z.string().describe('Workspace directory to execute test command in'),
      workspaceRoot: z.string().optional().describe('Optional root workspace directory to enforce security boundary (auto-resolved from runId if omitted)'),
      baselineCommitSha: z.string().optional().describe('Optional baseline commit SHA before contribution changes (auto-resolved from workspace artifact in runId)'),
      testCommand: z.string().describe('Exact test command, e.g. "npm test" or "pytest"'),
      preFixAssertionProbe: z
        .string()
        .optional()
        .describe('Expected failure assertion regex or snippet observed before fix (for dual-stage verification)'),
      preFixTestCommand: z
        .string()
        .optional()
        .describe('Optional separate reproduction script/command to trigger pre-fix failure baseline'),
      stressLoopCount: z.number().optional().describe('Number of stress loop iterations (default 20)'),
      runId: z.string().optional().describe('Optional runId to automatically resolve workspaceRoot and save evidence.json artifact'),
    },
    async (args) => {
      let resolvedWorkspaceRoot = args.workspaceRoot;
      let resolvedBaselineCommitSha = args.baselineCommitSha;

      // Auto-resolve workspaceRoot and baselineCommitSha from runId if not explicitly provided
      if (args.runId) {
        try {
          const run = runManager.getRun(args.runId);
          if (run?.artifacts?.workspace?.workspacePath && !resolvedWorkspaceRoot) {
            resolvedWorkspaceRoot = String(run.artifacts.workspace.workspacePath);
          }
          if (run?.artifacts?.workspace?.baseCommitSha && !resolvedBaselineCommitSha) {
            resolvedBaselineCommitSha = String(run.artifacts.workspace.baseCommitSha);
          }
        } catch {}
      }

      let dualStageResult: any = undefined;

      // 1. Dual-stage verification if preFixAssertionProbe is provided
      if (args.preFixAssertionProbe) {
        const preFixCheck = capturePreFixAssertion(
          args.cwd,
          args.preFixTestCommand || args.testCommand,
          resolvedWorkspaceRoot,
        );
        dualStageResult = await verifyDualStageReproduction({
          cwd: args.cwd,
          workspaceRoot: resolvedWorkspaceRoot,
          testCommand: args.testCommand,
          preFixBaselineCaptured: preFixCheck.assertionCaptured,
          preFixFailureOutput: preFixCheck.baselineOutput,
          stressLoopCount: args.stressLoopCount ?? 5,
        });
      }

      // 2. Comprehensive evidence metrics collection (flaky test baseline + handle leak check)
      const evidence = await collectEvidence({
        cwd: args.cwd,
        workspaceRoot: resolvedWorkspaceRoot,
        baselineCommitSha: resolvedBaselineCommitSha,
        testCommand: args.testCommand,
        stressLoopCount: args.stressLoopCount ?? 20,
      });

      const fullEvidenceReport = {
        ...evidence,
        dualStage: dualStageResult,
      };

      let persistence: { saved: boolean; error?: string } = { saved: false };
      if (args.runId) {
        try {
          runManager.saveArtifact(
            args.runId,
            'evidence',
            fullEvidenceReport,
            'EVIDENCE_COLLECTED',
          );
          persistence = { saved: true };
        } catch (err: any) {
          persistence = { saved: false, error: err.message };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: persistence.error ? 'PARTIAL_SUCCESS' : 'success',
                evidence: fullEvidenceReport,
                persistence: args.runId ? persistence : undefined,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
