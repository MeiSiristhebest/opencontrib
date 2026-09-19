import { existsSync } from "fs";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import {
  hashTrustedPolicySnapshot,
  isTrustedPolicySnapshot,
  loadHostPolicy,
  mergeTrustedPolicySnapshots,
  parsePolicyConfig,
  type TrustedPolicySnapshot,
} from "../kernel/config.js";
import { WorktreeManager, type WorkspaceContext } from "./worktree-manager.js";

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
  baseCommitSha: string;
  repoFullName: string;
  baseBranch?: string;
  policySnapshot: TrustedPolicySnapshot;
  policySha256: string;
  createdAt: string;
}

const BASELINE_POLICY_PATHS = [
  ".opencontrib.yaml",
  ".opencontrib.yml",
  ".opencontrib.json",
  ".opencontrib/config.yaml",
  ".opencontrib/config.yml",
  ".opencontrib/config.json",
] as const;

function readBaselineRepoPolicy(
  worktreeManager: WorktreeManager,
  baseRepoPath: string,
  baseCommitSha: string,
) {
  // Lightweight injected managers used by dry-run orchestration do not expose
  // Git inspection. They cannot contribute a repository policy, but they are
  // not evidence of a Git failure; production WorktreeManager always does.
  if (typeof worktreeManager.runGit !== "function") return undefined;

  for (const policyPath of BASELINE_POLICY_PATHS) {
    const listing = worktreeManager.runGit([
      "-C",
      baseRepoPath,
      "ls-tree",
      "-r",
      "--name-only",
      baseCommitSha,
      "--",
      policyPath,
    ]);
    if (!listing.success) {
      throw new Error(
        `WorkspacePolicySnapshotError: cannot inspect baseline policy path "${policyPath}" at base commit ${baseCommitSha}: ${listing.stderr.trim() || "git ls-tree failed"}.`,
      );
    }
    const existsInBase = listing.stdout
      .split(/\r?\n/)
      .some((line) => line.trim() === policyPath);
    if (!existsInBase) continue;

    const result = worktreeManager.runGit([
      "-C",
      baseRepoPath,
      "show",
      `${baseCommitSha}:${policyPath}`,
    ]);
    if (!result.success) {
      throw new Error(
        `WorkspacePolicySnapshotError: cannot read baseline policy path "${policyPath}" at base commit ${baseCommitSha}: ${result.stderr.trim() || "git show failed"}.`,
      );
    }
    return parsePolicyConfig(result.stdout);
  }
  return undefined;
}

function captureTrustedPolicySnapshot(
  worktreeManager: WorktreeManager,
  baseRepoPath: string,
  baseCommitSha: string,
): TrustedPolicySnapshot {
  return mergeTrustedPolicySnapshots(
    loadHostPolicy(),
    readBaselineRepoPolicy(worktreeManager, baseRepoPath, baseCommitSha),
  );
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
      input.repoFullName.trim().toLowerCase() !==
        manifestRepo.trim().toLowerCase()
    ) {
      throw new Error(
        `WorkspaceRepoMismatchError: requested repo "${input.repoFullName}" does not match run manifest repo "${manifestRepo}".`,
      );
    }

    // Enforce strict WORM on workspace artifact: if already set on this run, reject any attempt to recreate
    // SAFETY: canonical workspace artifacts are produced by WorkspaceService;
    // the assertion narrows the persisted JSON shape for the WORM read path.
    const existingWs = run.artifacts.workspace as unknown as
      WorkspaceArtifactData | undefined;
    if (existingWs) {
      if (
        !isTrustedPolicySnapshot(existingWs.policySnapshot) ||
        typeof existingWs.policySha256 !== "string" ||
        hashTrustedPolicySnapshot(existingWs.policySnapshot) !==
          existingWs.policySha256
      ) {
        throw new Error(
          `WorkspacePolicySnapshotError: canonical workspace for run ${input.runId} is missing a valid immutable policy snapshot.`,
        );
      }
      if (
        existingWs.workspacePath &&
        existsSync(existingWs.workspacePath) &&
        existingWs.baseCommitSha &&
        existingWs.baseRepoPath
      ) {
        // Revalidate origin, upstream freshness, and workspace HEAD on every
        // reuse. A canonical artifact must not turn a stale workspace into a
        // trusted one merely because it was persisted earlier.
        const verified = this.worktreeManager.createIsolatedWorkspace({
          repoFullName: manifestRepo,
          issueOrTaskId: input.issueOrTaskId,
          localRepoPath: existingWs.baseRepoPath,
          runId: input.runId,
          workspacePath: existingWs.workspacePath,
        });
        if (
          verified.workspacePath !== existingWs.workspacePath ||
          verified.baseCommitSha !== existingWs.baseCommitSha
        ) {
          throw new Error(
            `WorkspaceBaseFreshnessError: existing workspace for run ${input.runId} no longer matches its canonical upstream base commit.`,
          );
        }
        return {
          context: {
            workspacePath: existingWs.workspacePath,
            branchName: existingWs.branchName,
            isWorktree: existingWs.isWorktree,
            baseRepoPath: existingWs.baseRepoPath,
            baseCommitSha: existingWs.baseCommitSha,
            baseBranch: existingWs.baseBranch,
          },
          artifact: existingWs,
          alreadyPrepared: true,
        };
      }
      throw new Error(
        `WorkspaceImmutableViolationError: Workspace artifact has already been allocated for run ${input.runId}. Recreating or mutating workspace within the same run is forbidden.`,
      );
    }

    // If localRepoPath is supplied, origin verification is mandatory. A
    // missing/unreadable remote must never silently downgrade to a local HEAD.
    if (input.localRepoPath && existsSync(input.localRepoPath)) {
      const originRes = this.worktreeManager.runGit([
        "-C",
        input.localRepoPath,
        "remote",
        "get-url",
        "origin",
      ]);
      if (!originRes.success || !originRes.stdout.trim()) {
        throw new Error(
          `WorkspaceOriginVerificationError: cannot verify origin for localRepoPath "${input.localRepoPath}".`,
        );
      }
      const originUrl = originRes.stdout
        .trim()
        .toLowerCase()
        .replace(/\\/g, "/");
      const prefixes = [
        "https://github.com/",
        "http://github.com/",
        "git@github.com:",
        "ssh://git@github.com/",
      ];
      const prefix = prefixes.find((candidate) =>
        originUrl.startsWith(candidate),
      );
      const originRepo = prefix
        ? originUrl.slice(prefix.length).replace(/\.git$/, "")
        : undefined;
      if (originRepo !== manifestRepo.toLowerCase().trim()) {
        throw new Error(
          `WorkspaceOriginMismatchError: localRepoPath "${input.localRepoPath}" origin remote "${originRes.stdout.trim()}" does not match manifest repository "${manifestRepo}".`,
        );
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
      context.baseBranch ||
      (typeof this.worktreeManager.detectDefaultBranch === "function" &&
      context.baseRepoPath
        ? this.worktreeManager.detectDefaultBranch(context.baseRepoPath)
        : "main");
    if (!context.baseCommitSha) {
      throw new Error(
        `WorkspaceBaseCommitUnavailableError: isolated workspace for run ${input.runId} has no verified upstream base commit.`,
      );
    }

    const policySnapshot = captureTrustedPolicySnapshot(
      this.worktreeManager,
      context.baseRepoPath,
      context.baseCommitSha,
    );
    const artifact: WorkspaceArtifactData = {
      workspacePath: context.workspacePath,
      branchName: context.branchName,
      isWorktree: context.isWorktree,
      baseRepoPath: context.baseRepoPath,
      baseCommitSha: context.baseCommitSha,
      repoFullName: manifestRepo,
      baseBranch,
      policySnapshot,
      policySha256: hashTrustedPolicySnapshot(policySnapshot),
      createdAt: new Date().toISOString(),
    };

    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "workspace",
      artifact as any,
      "WORKSPACE_PREPARED",
    );

    return {
      context,
      artifact,
      alreadyPrepared: false,
    };
  }
}
