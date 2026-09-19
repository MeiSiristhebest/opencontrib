import { CliExitError } from "../utils/exit.js";
/** `opencontrib workspace <sub>` — Git worktree sandbox management. */

import { Command } from "commander";
import {
  WorktreeManager,
  WorkspaceService,
  buildContributionRunManager,
  defaultActiveSessionManager,
  getProtocolGuidance,
  type ContributionRunManager,
} from "@opencontrib/core";
import { printJSON, printPhaseGuidance } from "../utils/output.js";

const worktreeManager = new WorktreeManager();
// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

// ─── workspace prepare ────────────────────────────────────────────────────────
const workspacePrepare = new Command("prepare")
  .description("Create an isolated Git worktree for development")
  .requiredOption(
    "--repo <name>",
    'Repository full name, e.g. "microsoft/vscode"',
  )
  .requiredOption(
    "--issue <id>",
    "Issue number or task identifier to isolate fix branch",
  )
  .option(
    "--local-path <path>",
    "Optional local existing clone to worktree from",
  )
  .option(
    "--run-id <id>",
    "Run ID to auto-save workspace artifact (defaults to active session)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      repo: string;
      issue: string;
      localPath?: string;
      runId?: string;
      pretty?: boolean;
    }) => {
      try {
        const runManager = getRunManager();
        let effectiveRunId = runManager.resolveRunId(opts.runId);
        if (!effectiveRunId) {
          // Invert sequence: first ensure a canonical run exists, so runId is deterministic
          const manifest = runManager.createRun({
            repoFullName: opts.repo,
            issueNumber: parseInt(opts.issue, 10) || undefined,
            issueTitle: `Workspace for issue ${opts.issue}`,
          });
          effectiveRunId = manifest.runId;
        }

        const workspaceService = new WorkspaceService(
          runManager,
          worktreeManager,
        );
        const { context, artifact, alreadyPrepared } = workspaceService.prepare(
          {
            runId: effectiveRunId,
            issueOrTaskId: opts.issue,
            localRepoPath: opts.localPath,
            repoFullName: opts.repo,
          },
        );

        defaultActiveSessionManager.setActiveSession({
          runId: effectiveRunId,
          repoFullName: opts.repo,
          workspacePath: context.workspacePath,
          currentPhase: "WORKSPACE_PREPARED",
        });

        printJSON(
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
          opts.pretty,
        );

        const guidance = getProtocolGuidance("WORKSPACE_PREPARED");
        printPhaseGuidance({
          currentPhase: "WORKSPACE_PREPARED",
          runId: effectiveRunId,
          status: "SUCCESS",
          humanCheckpoint: "Checkpoint 1 (Sandbox Isolated & Ready)",
          nextCommand: guidance.cliExample
            .replace("<workspace>", `"${context.workspacePath}"`)
            .replace("<command>", '"<test_command>"')
            .replace("<failure-marker>", '"<assertion>"'),
          forbiddenActions: guidance.forbiddenActions,
          invariants: [
            ...guidance.invariants,
            `All development must take place inside isolated worktree: ${context.workspacePath}`,
          ],
        });
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── workspace purge ──────────────────────────────────────────────────────────
const workspacePurge = new Command("purge")
  .description(
    "Purge all ephemeral worktrees, scratch scripts, and cached bare repos",
  )
  .option(
    "--clean-repos",
    "Also delete bare repo cache (~/.opencontrib/repos)",
    false,
  )
  .option("--pretty", "Pretty-print", false)
  .action(async (opts: { cleanRepos?: boolean; pretty?: boolean }) => {
    try {
      const report = worktreeManager.purgeAllWorkspaces({
        cleanRepos: opts.cleanRepos ?? false,
      });
      printJSON(
        {
          status: "success",
          message: "Sandbox cleanup completed",
          report,
        },
        opts.pretty,
      );
    } catch (err: any) {
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

// ─── workspace list ───────────────────────────────────────────────────────────
const workspaceList = new Command("list")
  .description("List all active and cached workspace sandboxes")
  .option("--pretty", "Pretty-print", false)
  .action((opts: { pretty?: boolean }) => {
    try {
      const workspaces = worktreeManager.listWorkspaces();
      printJSON(
        {
          status: "success",
          count: workspaces.length,
          workspaces,
        },
        opts.pretty,
      );
    } catch (err: any) {
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const workspaceCommand = new Command("workspace")
  .description("Manage isolated Git worktree sandboxes")
  .addCommand(workspacePrepare)
  .addCommand(workspacePurge)
  .addCommand(workspaceList);
