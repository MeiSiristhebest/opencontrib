import { Octokit } from "@octokit/rest";
import { GitHubClient } from "../discovery/github-client.js";

export interface GitTreeEntry {
  path: string;
  content: string;
  mode?: "100644" | "100755" | "120000";
  type?: "blob" | "commit" | "tree";
  operation?: "CREATE" | "MODIFY" | "DELETE";
}

export interface PrSubmissionOptions {
  upstreamOwner: string;
  upstreamRepo: string;
  baseBranch?: string;
  title: string;
  body: string;
  branchName: string;
  /** Exact upstream base commit approved by the canonical SubmissionIntent. */
  expectedBaseCommitSha: string;
  files: Array<GitTreeEntry | { path: string; content: string }>;
  commitMessage: string;
  isDraft?: boolean;
  dcoSignOff?: boolean;
}

export interface PrSubmissionResult {
  prNumber: number;
  prUrl: string;
  branchUrl: string;
  isDraft: boolean;
  commitSha: string;
  status: "SUCCESS" | "DRY_RUN";
}

function isSafeGitPath(path: string): boolean {
  if (!path || path.includes("\0") || path.includes("\\")) return false;
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path
    .split("/")
    .every((part) => part.length > 0 && part !== "." && part !== "..");
}

/**
 * Trusted provider writer.  This module is intentionally not exported from
 * the public `@opencontrib/core` GitHub barrel; only the trusted submission
 * composition root should construct it.
 */
export class ContributionPrService {
  private client: GitHubClient;
  private octokit: Octokit;

  constructor(client?: GitHubClient) {
    this.client = client || new GitHubClient();
    this.octokit = (this.client as any).octokit;
  }

  async ensureFork(owner: string, repo: string): Promise<string> {
    try {
      const userResp = await this.octokit.rest.users.getAuthenticated();
      const currentUser = userResp.data.login;
      let repoData: any;
      try {
        const repoResp = await this.octokit.rest.repos.get({
          owner: currentUser,
          repo,
        });
        repoData = repoResp.data;
      } catch (err: any) {
        // Only a provider-confirmed 404 means the fork is absent. Treat auth,
        // rate-limit, and network failures as errors; never create/overwrite
        // a repository based on an ambiguous response.
        if (err?.status !== 404) throw err;
        await this.octokit.rest.repos.createFork({ owner, repo });
        await new Promise((resolve) => setTimeout(resolve, 3000));
        const created = await this.octokit.rest.repos.get({
          owner: currentUser,
          repo,
        });
        repoData = created.data;
      }

      const expectedParent = `${owner}/${repo}`.toLowerCase();
      if (
        repoData?.fork !== true ||
        repoData?.parent?.full_name?.toLowerCase() !== expectedParent
      ) {
        throw new Error(
          `Fork lineage collision: "${currentUser}/${repo}" is not a fork of "${owner}/${repo}". Refusing to write to an unrelated repository.`,
        );
      }
      return currentUser;
    } catch (err: any) {
      if (err?.status === 401 || err?.status === 403) {
        throw new Error(
          `GitHub auth failed (${err.status}) when forking ${owner}/${repo}: ${err.message}`,
        );
      }
      throw new Error(
        `Fork operation failed for ${owner}/${repo}: ${err?.message || String(err)}`,
      );
    }
  }

  async submitPullRequest(
    options: PrSubmissionOptions,
  ): Promise<PrSubmissionResult> {
    const {
      upstreamOwner,
      upstreamRepo,
      title,
      body,
      branchName,
      files,
      commitMessage,
      isDraft = true,
      dcoSignOff = true,
    } = options;

    if (!/^opencontrib\/[A-Za-z0-9][A-Za-z0-9._-]{1,100}$/.test(branchName)) {
      throw new Error(
        `Security error: branch "${branchName}" is not a run-owned opencontrib branch.`,
      );
    }
    const seenPaths = new Set<string>();
    for (const file of files) {
      if (!isSafeGitPath(file.path)) {
        throw new Error(`Security error: unsafe Git path "${file.path}".`);
      }
      if (seenPaths.has(file.path)) {
        throw new Error(`Security error: duplicate Git path "${file.path}".`);
      }
      seenPaths.add(file.path);
    }
    if (files.length === 0) {
      throw new Error(
        "Security error: refusing to create an empty contribution commit.",
      );
    }

    // Resolve the branch name for provider operations, but never derive the
    // commit parent from the provider's moving HEAD. The approved SHA is the
    // only acceptable parent for this contribution commit.
    const repoDetails = await this.client.getRepoDetails(
      upstreamOwner,
      upstreamRepo,
    );
    const baseBranch =
      options.baseBranch || repoDetails.data?.defaultBranch || "main";
    const expectedBaseCommitSha = options.expectedBaseCommitSha;
    if (!/^[0-9a-f]{7,64}$/i.test(expectedBaseCommitSha)) {
      throw new Error(
        "ExpectedBaseCommitRequiredError: provider submission requires the approved upstream base commit SHA.",
      );
    }
    const baseRef = await this.octokit.rest.git.getRef({
      owner: upstreamOwner,
      repo: upstreamRepo,
      ref: `heads/${baseBranch}`,
    });
    const providerBaseSha = String(baseRef.data?.object?.sha || "");
    if (providerBaseSha !== expectedBaseCommitSha) {
      throw new Error(
        `BaseBranchAdvancedError: upstream base branch ${baseBranch} is ${providerBaseSha}, expected approved commit ${expectedBaseCommitSha}.`,
      );
    }
    const baseCommitSha = expectedBaseCommitSha;
    const baseCommit = await this.octokit.rest.git.getCommit({
      owner: upstreamOwner,
      repo: upstreamRepo,
      commit_sha: expectedBaseCommitSha,
    });

    const forkOwner = await this.ensureFork(upstreamOwner, upstreamRepo);
    const baseTreeSha = baseCommit.data.tree.sha;

    // Create the exact tree, preserving executable/symlink modes and DELETE
    // operations. A DELETE is represented by a null blob SHA.
    const treeItems: any[] = [];
    for (const file of files) {
      const entry = file as GitTreeEntry;
      if (entry.operation === "DELETE") {
        treeItems.push({
          path: entry.path,
          mode: entry.mode || "100644",
          type: entry.type || "blob",
          sha: null,
        });
      } else {
        const blob = await this.octokit.rest.git.createBlob({
          owner: forkOwner,
          repo: upstreamRepo,
          content: Buffer.from(entry.content).toString("base64"),
          encoding: "base64",
        });
        treeItems.push({
          path: entry.path,
          mode: entry.mode || "100644",
          type: entry.type || "blob",
          sha: blob.data.sha,
        });
      }
    }
    const newTree = await this.octokit.rest.git.createTree({
      owner: forkOwner,
      repo: upstreamRepo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    let finalCommitMessage = commitMessage;
    if (dcoSignOff && !finalCommitMessage.includes("Signed-off-by:")) {
      const user = await this.octokit.rest.users.getAuthenticated();
      const email =
        user.data.email || `${user.data.login}@users.noreply.github.com`;
      finalCommitMessage += `\n\nSigned-off-by: ${user.data.name || user.data.login} <${email}>`;
    }

    const newCommit = await this.octokit.rest.git.createCommit({
      owner: forkOwner,
      repo: upstreamRepo,
      message: finalCommitMessage,
      tree: newTree.data.sha,
      parents: [baseCommitSha],
    });

    // Branch creation/update is deliberately non-forced. A retry may reuse a
    // branch only when it is still at base or already points at the exact tree
    // produced by this intent; divergent history is a hard conflict.
    let branchHeadSha = newCommit.data.sha;
    try {
      await this.octokit.rest.git.createRef({
        owner: forkOwner,
        repo: upstreamRepo,
        ref: `refs/heads/${branchName}`,
        sha: newCommit.data.sha,
      });
    } catch (err: any) {
      if (err?.status !== 409) {
        throw new Error(
          `Failed to create branch "${branchName}": ${err?.message || String(err)}`,
        );
      }
      const existingRef = await this.octokit.rest.git.getRef({
        owner: forkOwner,
        repo: upstreamRepo,
        ref: `heads/${branchName}`,
      });
      const existingSha = existingRef.data.object.sha;
      if (existingSha !== baseCommitSha && existingSha !== newCommit.data.sha) {
        const existingCommit = await this.octokit.rest.git.getCommit({
          owner: forkOwner,
          repo: upstreamRepo,
          commit_sha: existingSha,
        });
        if (
          existingCommit.data.tree.sha !== newTree.data.sha ||
          existingCommit.data.parents?.[0]?.sha !== baseCommitSha
        ) {
          throw new Error(
            `BranchConflictError: run-owned branch "${branchName}" diverged; refusing to force-reset it.`,
          );
        }
        branchHeadSha = existingSha;
      }
      if (existingSha === baseCommitSha) {
        await this.octokit.rest.git.updateRef({
          owner: forkOwner,
          repo: upstreamRepo,
          ref: `heads/${branchName}`,
          sha: newCommit.data.sha,
        });
      } else if (existingSha === newCommit.data.sha) {
        branchHeadSha = existingSha;
      } else {
        // Existing commit has the exact tree/parent but a different timestamp;
        // it is already the idempotent result and needs no ref update.
        branchHeadSha = existingSha;
      }
    }

    let prResp: any;
    try {
      const existingPrs = await this.octokit.rest.pulls.list({
        owner: upstreamOwner,
        repo: upstreamRepo,
        head: `${forkOwner}:${branchName}`,
        state: "open",
      });
      if (existingPrs.data && existingPrs.data.length > 0) {
        const existing = existingPrs.data[0];
        if (
          existing.base?.ref !== baseBranch ||
          existing.title !== title ||
          existing.body !== body
        ) {
          throw new Error(
            "IdempotencyConflictError: an open PR already exists for this run-owned branch with different title, body, or base branch.",
          );
        }
        prResp = { data: existing };
        branchHeadSha = existing.head?.sha || branchHeadSha;
      } else {
        prResp = await this.octokit.rest.pulls.create({
          owner: upstreamOwner,
          repo: upstreamRepo,
          title,
          body,
          head: `${forkOwner}:${branchName}`,
          base: baseBranch,
          draft: isDraft,
        });
      }
    } catch (err: any) {
      throw new Error(
        `Failed to create or reconcile pull request: ${err.message}`,
      );
    }

    return {
      prNumber: prResp.data.number,
      prUrl: prResp.data.html_url,
      branchUrl: `https://github.com/${forkOwner}/${upstreamRepo}/tree/${branchName}`,
      isDraft,
      commitSha: branchHeadSha,
      status: "SUCCESS",
    };
  }
}
