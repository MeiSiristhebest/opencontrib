import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
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
      stressLoopCount: z.number().optional().default(1).describe('Number of test execution runs / stress loop iterations (default 1, use >1 for concurrency/race tests)'),
      runId: z.string().optional().describe('Optional runId to automatically resolve workspaceRoot and save evidence.json artifact'),
    },
    async (args) => {
      // Validate cwd against workspaceRoot boundary
      const resolvedCwd = path.resolve(args.cwd);
      if (args.workspaceRoot) {
        const resolvedRoot = path.resolve(args.workspaceRoot);
        if (!resolvedCwd.startsWith(resolvedRoot + path.sep) && resolvedCwd !== resolvedRoot) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'error', message: `cwd "${resolvedCwd}" is outside workspaceRoot "${resolvedRoot}"` }, null, 2),
            }],
          };
        }
      } else {
        // Validate cwd is within home directory
        const home = process.env.OPENCONTRIB_HOME || process.env.HOME || os.homedir();
        if (!resolvedCwd.startsWith(path.resolve(home) + path.sep) && resolvedCwd !== path.resolve(home)) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'error', message: `cwd "${resolvedCwd}" is outside the allowed workspace boundary. Set workspaceRoot explicitly.` }, null, 2),
            }],
          };
        }
      }

      // Limit stress loop count
      if (args.stressLoopCount > 100) {
        args.stressLoopCount = 100;
      }

      let resolvedWorkspaceRoot = args.workspaceRoot;
      let resolvedBaselineCommitSha = args.baselineCommitSha;

      // Auto-resolve workspaceRoot and baselineCommitSha from runId if not explicitly provided
      if (args.runId) {
        try {
          const run = runManager.getRun(args.runId);
          if (!run) {
            console.warn(`[evidence-tools] Run "${args.runId}" not found; skipping workspaceRoot/baseline auto-resolution`);
          } else if (run.artifacts?.workspace?.workspacePath && !resolvedWorkspaceRoot) {
            resolvedWorkspaceRoot = String(run.artifacts.workspace.workspacePath);
          } else if (run.artifacts?.workspace?.baseCommitSha && !resolvedBaselineCommitSha) {
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
          stressLoopCount: args.stressLoopCount ?? 1,
        });
      }

      // 2. Comprehensive evidence metrics collection (flaky test baseline + handle leak check)
      const evidence = await collectEvidence({
        cwd: args.cwd,
        workspaceRoot: resolvedWorkspaceRoot,
        baselineCommitSha: resolvedBaselineCommitSha,
        testCommand: args.testCommand,
        stressLoopCount: args.stressLoopCount ?? 1,
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

  // -------------------------------------------------------------
  // Tool: contrib_verify_poc (执行自主 Fail-First PoC 闭环验证)
  // -------------------------------------------------------------
  server.tool(
    'contrib_verify_poc',
    'Execute autonomous 4-phase closed-loop verification (Red -> Green -> Blue) for a Smart Pointer finding inside a clean-room worktree sandbox',
    {
      repoPath: z.string().describe('Target repository path'),
      pointerUri: z.string().describe('Smart Pointer URI to verify, e.g. "ptr://ast-grep/ssrf-test/src/fetch.ts:42"'),
      testCommand: z.string().optional().describe('Optional custom test command override'),
      timeoutMs: z.number().optional().default(30000).describe('Execution timeout in ms'),
      runId: z.string().optional().describe('Optional runId to automatically record poc artifact and advance phase to POC_GENERATED'),
    },
    async (args) => {
      try {
        const { AutonomousPoCVerifier, SmartPointerStore } = await import('@opencontrib/core');

        // Validate repoPath against home directory boundary
        const resolvedRepoPath = path.resolve(args.repoPath);
        const home = process.env.OPENCONTRIB_HOME || process.env.HOME || os.homedir();
        const allowedRoot = path.resolve(home);
        if (!resolvedRepoPath.startsWith(allowedRoot + path.sep) && resolvedRepoPath !== allowedRoot) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'error', message: `repoPath "${resolvedRepoPath}" is outside the allowed workspace boundary` }, null, 2),
            }],
          };
        }

        const store = new SmartPointerStore(path.join(resolvedRepoPath, '.opencontrib', 'pointers'));
        
        let finding: any;
        try {
          const resolved = store.resolve(args.pointerUri, 'stub');
          finding = resolved;
        } catch {
          // Fallback minimal finding stub
          finding = {
            id: args.pointerUri.split('/').pop() || 'finding-0',
            namespace: 'custom',
            title: 'Custom Defect Finding',
            category: 'security_cwe',
            severity: 'high',
            file: 'unknown',
            line: 1,
            confidence: 80,
          };
        }

        const report = await AutonomousPoCVerifier.verifyFinding(resolvedRepoPath, finding, {
          testCommand: args.testCommand,
          timeoutMs: args.timeoutMs,
        });

        if (args.runId) {
          try {
            runManager.saveArtifact(args.runId, 'poc', report as any, 'POC_GENERATED');
          } catch {}
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: report.status === 'VERIFIED' ? 'success' : 'failed',
                  report,
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
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }, null, 2) }],
        };
      }
    },
  );
}
