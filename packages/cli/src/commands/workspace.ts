/** `opencontrib workspace <sub>` — Git worktree sandbox management. */

import { Command } from 'commander';
import { WorktreeManager, ContributionRunManager } from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

const worktreeManager = new WorktreeManager();
const runManager = new ContributionRunManager();

// ─── workspace prepare ────────────────────────────────────────────────────────
const workspacePrepare = new Command('prepare')
  .description('Create an isolated Git worktree for development')
  .requiredOption('--repo <name>', 'Repository full name, e.g. "microsoft/vscode"')
  .requiredOption('--issue <id>', 'Issue number or task identifier')
  .option('--local-path <path>', 'Local path of existing repo to create worktree from')
  .option('--run-id <id>', 'Run ID to auto-save workspace artifact')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    repo: string;
    issue: string;
    localPath?: string;
    runId?: string;
    pretty?: boolean;
  }) => {
    try {
      const context = worktreeManager.createIsolatedWorkspace({
        repoFullName: opts.repo,
        issueOrTaskId: opts.issue,
        localRepoPath: opts.localPath,
        runId: opts.runId,
      });

      let persistence: { saved: boolean; error?: string } | undefined;
      if (opts.runId) {
        try {
          runManager.saveArtifact(
            opts.runId,
            'workspace',
            {
              workspacePath: context.workspacePath,
              branchName: context.branchName,
              isWorktree: context.isWorktree,
              baseRepoPath: context.baseRepoPath,
              baseCommitSha: context.baseCommitSha,
              repoFullName: opts.repo,
            },
            'WORKSPACE_PREPARED',
          );
          persistence = { saved: true };
        } catch (err: any) {
          persistence = { saved: false, error: err.message };
        }
      }

      printJSON({
        status: persistence?.error ? 'PARTIAL_SUCCESS' : 'success',
        workspacePath: context.workspacePath,
        branchName: context.branchName,
        isWorktree: context.isWorktree,
        baseCommitSha: context.baseCommitSha,
        persistence,
      }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── workspace purge ──────────────────────────────────────────────────────────
const workspacePurge = new Command('purge')
  .description('Purge all ephemeral worktrees, scratch scripts, and cached bare repos')
  .option('--clean-repos', 'Also delete bare repo cache (~/.opencontrib/repos)', false)
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { cleanRepos?: boolean; pretty?: boolean }) => {
    try {
      const report = worktreeManager.purgeAllWorkspaces({
        cleanRepos: opts.cleanRepos ?? false,
      });
      printJSON({
        status: 'success',
        message: 'Sandbox cleanup completed',
        report,
      }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const workspaceCommand = new Command('workspace')
  .description('Manage isolated Git worktree sandboxes')
  .addCommand(workspacePrepare)
  .addCommand(workspacePurge);