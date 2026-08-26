/** `opencontrib workspace <sub>` — Git worktree sandbox management. */

import { Command } from 'commander';
import { WorktreeManager, ContributionRunManager, defaultActiveSessionManager } from '@opencontrib/core';
import { printJSON, printPhaseGuidance } from '../utils/output.js';

const worktreeManager = new WorktreeManager();
const runManager = new ContributionRunManager();

// ─── workspace prepare ────────────────────────────────────────────────────────
const workspacePrepare = new Command('prepare')
  .description('Create an isolated Git worktree for development')
  .requiredOption('--repo <name>', 'Repository full name, e.g. "microsoft/vscode"')
  .requiredOption('--issue <id>', 'Issue number or task identifier')
  .option('--local-path <path>', 'Local path of existing repo to create worktree from')
  .option('--run-id <id>', 'Run ID to auto-save workspace artifact (defaults to active session)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    repo: string;
    issue: string;
    localPath?: string;
    runId?: string;
    pretty?: boolean;
  }) => {
    try {
      const runId = runManager.resolveRunId(opts.runId);
      const context = worktreeManager.createIsolatedWorkspace({
        repoFullName: opts.repo,
        issueOrTaskId: opts.issue,
        localRepoPath: opts.localPath,
        runId,
      });

      defaultActiveSessionManager.setActiveSession({
        runId: runId || `run_${Date.now()}_${opts.repo.replace(/[^a-zA-Z0-9]/g, '_')}`,
        repoFullName: opts.repo,
        workspacePath: context.workspacePath,
        currentPhase: 'WORKSPACE_PREPARED',
      });

      let persistence: { saved: boolean; error?: string } | undefined;
      if (runId) {
        try {
          runManager.saveArtifact(
            runId,
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

      printPhaseGuidance({
        currentPhase: 'WORKSPACE_PREPARED',
        runId,
        status: 'SUCCESS',
        humanCheckpoint: 'Checkpoint 1 (Sandbox Isolated & Ready)',
        nextCommand: `opencontrib evidence --cwd "${context.workspacePath}" --test-cmd "<test_command>"`,
        forbiddenActions: [
          'DO NOT edit source code files before reproducing a failing unit test (RED Phase).',
          'DO NOT run wide root tests (npm test / go test ./...) without scoping to the subpackage.',
        ],
        invariants: [
          `All development must take place inside isolated worktree: ${context.workspacePath}`,
        ],
      });
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

// ─── workspace list ───────────────────────────────────────────────────────────
const workspaceList = new Command('list')
  .description('List all active and cached workspace sandboxes')
  .option('--pretty', 'Pretty-print', false)
  .action((opts: { pretty?: boolean }) => {
    try {
      const workspaces = worktreeManager.listWorkspaces();
      printJSON({
        status: 'success',
        count: workspaces.length,
        workspaces,
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
  .addCommand(workspacePurge)
  .addCommand(workspaceList);