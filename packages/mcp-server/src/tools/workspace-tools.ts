import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "path";
import {
  ContributionRunManager,
  WorktreeManager,
  WorkspaceService,
  resolveOpenContribPaths,
} from "@opencontrib/core";

export function registerWorkspaceTools(
  server: McpServer,
  worktreeManager: WorktreeManager,
  runManager: ContributionRunManager,
): void {
  const workspaceService = new WorkspaceService(runManager, worktreeManager);

  // -------------------------------------------------------------
  // Tool: contrib_prepare_workspace (本地沙箱：Git Worktree)
  // -------------------------------------------------------------
  server.tool(
    "contrib_prepare_workspace",
    "Create an isolated Git worktree under ~/.opencontrib/workspaces to develop a fix without touching main workspace",
    {
      repoFullName: z
        .string()
        .describe('Target repository, e.g. "microsoft/vscode"'),
      issueOrTaskId: z
        .union([z.string(), z.number()])
        .describe("Issue number or task identifier"),
      localRepoPath: z
        .string()
        .optional()
        .describe(
          "Optional local path of existing repo to create worktree from",
        ),
      runId: z
        .string()
        .optional()
        .describe(
          "Optional runId to automatically save workspace.json artifact and advance phase",
        ),
    },
    async (args) => {
      try {
        if (args.runId) {
          const { context, artifact, alreadyPrepared } =
            workspaceService.prepare({
              runId: args.runId,
              issueOrTaskId: args.issueOrTaskId,
              localRepoPath: args.localRepoPath,
              repoFullName: args.repoFullName,
            });

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "success",
                    workspacePath: context.workspacePath,
                    branchName: context.branchName,
                    isWorktree: context.isWorktree,
                    baseCommitSha: context.baseCommitSha,
                    baseBranch: artifact.baseBranch,
                    alreadyPrepared,
                    persistence: { saved: true },
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const context = worktreeManager.createIsolatedWorkspace({
          repoFullName: args.repoFullName,
          issueOrTaskId: args.issueOrTaskId,
          localRepoPath: args.localRepoPath,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  workspacePath: context.workspacePath,
                  branchName: context.branchName,
                  isWorktree: context.isWorktree,
                  baseCommitSha: context.baseCommitSha,
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { status: "error", message: err.message },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_purge_sandbox (沙箱与临时测试工作区一键清理)
  // -------------------------------------------------------------
  server.tool(
    "contrib_purge_sandbox",
    "Purge all ephemeral git worktrees, temporary scratch test scripts, and cached bare repos",
    {
      cleanRepos: z
        .boolean()
        .optional()
        .describe(
          "Whether to also delete bare repo cache (~/.opencontrib/repos)",
        ),
      cleanScratchDir: z
        .string()
        .optional()
        .describe("Optional path to local scratch directory to clean"),
    },
    async (args) => {
      try {
        if (args.cleanScratchDir) {
          const resolved = path.resolve(args.cleanScratchDir);
          const { baseDir, dataDir } = resolveOpenContribPaths();
          const allowedRoots = [path.resolve(baseDir), path.resolve(dataDir)];
          const isAllowed = allowedRoots.some(
            (root) => resolved === root || resolved.startsWith(root + path.sep),
          );
          if (!isAllowed) {
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    {
                      status: "error",
                      message: `cleanScratchDir "${resolved}" is outside the allowed directories "${allowedRoots.join(", ")}"`,
                    },
                    null,
                    2,
                  ),
                },
              ],
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
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  message: "Sandbox cleanup completed",
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
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { status: "error", message: err.message },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
