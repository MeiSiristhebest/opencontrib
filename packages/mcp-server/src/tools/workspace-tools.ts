import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'path';
import * as os from 'os';
import { ContributionRunManager, WorktreeManager } from '@opencontrib/core';

export function registerWorkspaceTools(
  server: McpServer,
  worktreeManager: WorktreeManager,
  runManager: ContributionRunManager,
): void {
  // -------------------------------------------------------------
  // Tool: contrib_prepare_workspace (本地沙箱：Git Worktree)
  // -------------------------------------------------------------
  server.tool(
    'contrib_prepare_workspace',
    'Create an isolated Git worktree under ~/.opencontrib/workspaces to develop a fix without touching main workspace',
    {
      repoFullName: z.string().describe('Target repository, e.g. "microsoft/vscode"'),
      issueOrTaskId: z.union([z.string(), z.number()]).describe('Issue number or task identifier'),
      localRepoPath: z.string().optional().describe('Optional local path of existing repo to create worktree from'),
      runId: z.string().optional().describe('Optional runId to automatically save workspace.json artifact and advance phase'),
    },
    async (args) => {
      const context = worktreeManager.createIsolatedWorkspace({
        repoFullName: args.repoFullName,
        issueOrTaskId: args.issueOrTaskId,
        localRepoPath: args.localRepoPath,
        runId: args.runId,
      });

      let persistence: { saved: boolean; error?: string } = { saved: false };
      if (args.runId) {
        try {
          runManager.saveArtifact(
            args.runId,
            'workspace',
            {
              workspacePath: context.workspacePath,
              branchName: context.branchName,
              isWorktree: context.isWorktree,
              baseRepoPath: context.baseRepoPath,
              baseCommitSha: context.baseCommitSha,
              repoFullName: args.repoFullName,
            },
            'WORKSPACE_PREPARED',
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
                workspacePath: context.workspacePath,
                branchName: context.branchName,
                isWorktree: context.isWorktree,
                baseCommitSha: context.baseCommitSha,
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
  // Tool: contrib_purge_sandbox (沙箱与临时测试工作区一键清理)
  // -------------------------------------------------------------
  server.tool(
    'contrib_purge_sandbox',
    'Purge all ephemeral git worktrees, temporary scratch test scripts, and cached bare repos',
    {
      cleanRepos: z.boolean().optional().describe('Whether to also delete bare repo cache (~/.opencontrib/repos)'),
      cleanScratchDir: z.string().optional().describe('Optional path to local scratch directory to clean'),
    },
    async (args) => {
      if (args.cleanScratchDir) {
        const resolved = path.resolve(args.cleanScratchDir);
        const home = process.env.OPENCONTRIB_HOME || process.env.HOME || os.homedir();
        const allowedRoot = path.resolve(home);
        if (!resolved.startsWith(allowedRoot)) {
          return {
            isError: true,
            content: [{
              type: 'text',
              text: JSON.stringify({ status: 'error', message: `cleanScratchDir "${resolved}" is outside the allowed directory "${allowedRoot}"` }, null, 2),
            }],
          };
        }
      }

      const report = worktreeManager.purgeAllWorkspaces({
        cleanRepos: args.cleanRepos ?? false,
        cleanScratchDir: args.cleanScratchDir,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                message: 'Sandbox cleanup completed',
                report,
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
