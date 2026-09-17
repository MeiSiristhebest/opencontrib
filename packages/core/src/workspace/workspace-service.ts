import { existsSync } from 'fs';
import type { ContributionRunManager } from '../run/run-manager.js';
import { saveCanonicalArtifact } from '../run/canonical-writer.js';
import { WorktreeManager, type WorkspaceContext } from './worktree-manager.js';

export interface PrepareWorkspaceInput {
  runId: string;
  issueOrTaskId: string | number;
  localRepoPath?: string;
  repoFullName?: string;
}

export interface WorkspaceArtifactData {
  workspacePath: string;
  branchName: string;
  isWorktree: boolean;
  baseRepoPath: string;
  baseCommitSha?: string;
  repoFullName: string;
  baseBranch?: string;
  createdAt: string;
}

export class WorkspaceService {
  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly worktreeManager: WorktreeManager = new WorktreeManager(),
  ) {}

  /**
   * Authoritatively prepares an isolated workspace for a run.
   * 1. Validates that the run exists.
   * 2. Uses the run's manifest repoFullName (rejecting mismatching inputs).
   * 3. Enforces write-once: returns existing canonical workspace if already prepared.
   * 4. Allocates isolated worktree with run-owned branch name: runBranchName(runId).
   * 5. Detects baseBranch from repository.
   * 6. Saves canonical 'workspace' artifact and advances phase to WORKSPACE_PREPARED.
   */
  prepare(input: PrepareWorkspaceInput): {
    context: WorkspaceContext;
    artifact: WorkspaceArtifactData;
    alreadyPrepared: boolean;
  } {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }

    const manifestRepo = run.manifest.repoFullName;
    if (
      input.repoFullName &&
      input.repoFullName.trim().toLowerCase() !== manifestRepo.trim().toLowerCase()
    ) {
      throw new Error(
        `WorkspaceRepoMismatchError: requested repo "${input.repoFullName}" does not match run manifest repo "${manifestRepo}".`,
      );
    }

    // Enforce strict WORM on workspace artifact: if already set on this run, reject any attempt to recreate
    const existingWs = run.artifacts.workspace as unknown as WorkspaceArtifactData | undefined;
    if (existingWs) {
      if (existingWs.workspacePath && existsSync(existingWs.workspacePath)) {
        return {
          context: {
            workspacePath: existingWs.workspacePath,
            branchName: existingWs.branchName,
            isWorktree: existingWs.isWorktree,
            baseRepoPath: existingWs.baseRepoPath,
            baseCommitSha: existingWs.baseCommitSha,
          },
          artifact: existingWs,
          alreadyPrepared: true,
        };
      }
      throw new Error(
        `WorkspaceImmutableViolationError: Workspace artifact has already been allocated for run ${input.runId}. Recreating or mutating workspace within the same run is forbidden.`,
      );
    }

    // If localRepoPath is supplied, verify its origin remote matches the manifest repository
    if (input.localRepoPath && existsSync(input.localRepoPath)) {
      const originRes = this.worktreeManager.runGit(['-C', input.localRepoPath, 'remote', 'get-url', 'origin']);
      if (originRes.success && originRes.stdout.trim()) {
        const originUrl = originRes.stdout.trim().toLowerCase().replace(/\\/g, '/');
        const expected = manifestRepo.toLowerCase();
        // Match either https://github.com/owner/repo(.git) or git@github.com:owner/repo(.git)
        if (!originUrl.includes(expected)) {
          throw new Error(
            `WorkspaceOriginMismatchError: localRepoPath "${input.localRepoPath}" origin remote "${originRes.stdout.trim()}" does not match manifest repository "${manifestRepo}".`,
          );
        }
      }
    }

    // Create isolated worktree strictly using runId to enforce run-owned branch naming
    const context = this.worktreeManager.createIsolatedWorkspace({
      repoFullName: manifestRepo,
      issueOrTaskId: input.issueOrTaskId,
      localRepoPath: input.localRepoPath,
      runId: input.runId,
    });

    const baseBranch =
      (typeof this.worktreeManager.detectDefaultBranch === "function" && context.baseRepoPath)
        ? this.worktreeManager.detectDefaultBranch(context.baseRepoPath)
        : "main";

    const artifact: WorkspaceArtifactData = {
      workspacePath: context.workspacePath,
      branchName: context.branchName,
      isWorktree: context.isWorktree,
      baseRepoPath: context.baseRepoPath,
      baseCommitSha: context.baseCommitSha,
      repoFullName: manifestRepo,
      baseBranch,
      createdAt: new Date().toISOString(),
    };

    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      'workspace',
      artifact as any,
      'WORKSPACE_PREPARED',
    );

    return {
      context,
      artifact,
      alreadyPrepared: false,
    };
  }
}
