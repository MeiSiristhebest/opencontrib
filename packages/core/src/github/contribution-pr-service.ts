import { Octokit } from '@octokit/rest';
import { GitHubClient } from '../discovery/github-client.js';

export interface GitTreeEntry {
  path: string;
  content: string;
  mode?: '100644' | '100755' | '120000';
  type?: 'blob' | 'commit' | 'tree';
}

export interface PrSubmissionOptions {
  upstreamOwner: string;
  upstreamRepo: string;
  title: string;
  body: string;
  branchName: string;
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
  status: 'SUCCESS' | 'DRY_RUN';
}

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

      // Check if fork already exists
      try {
        await this.octokit.rest.repos.get({ owner: currentUser, repo });
        return currentUser;
      } catch {
        // Create fork
        await this.octokit.rest.repos.createFork({ owner, repo });
        // Wait 3s for GitHub to initialize fork
        await new Promise((r) => setTimeout(r, 3000));
        return currentUser;
      }
    } catch {
      return owner;
    }
  }

  async submitPullRequest(options: PrSubmissionOptions): Promise<PrSubmissionResult> {
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

    const forkOwner = await this.ensureFork(upstreamOwner, upstreamRepo);

    // 1. Get base default branch and Base Commit & Tree SHA
    const repoDetails = await this.client.getRepoDetails(upstreamOwner, upstreamRepo);
    const baseBranch = repoDetails.defaultBranch;

    const baseRef = await this.octokit.rest.git.getRef({
      owner: upstreamOwner,
      repo: upstreamRepo,
      ref: `heads/${baseBranch}`,
    });
    const baseCommitSha = baseRef.data.object.sha;

    // Correctly query the base commit to obtain the genuine base_tree SHA (not commit SHA)
    const baseCommit = await this.octokit.rest.git.getCommit({
      owner: upstreamOwner,
      repo: upstreamRepo,
      commit_sha: baseCommitSha,
    });
    const baseTreeSha = baseCommit.data.tree.sha;

    // 2. Create or update working branch on fork
    try {
      await this.octokit.rest.git.createRef({
        owner: forkOwner,
        repo: upstreamRepo,
        ref: `refs/heads/${branchName}`,
        sha: baseCommitSha,
      });
    } catch {
      // Branch may already exist; update ref
      await this.octokit.rest.git.updateRef({
        owner: forkOwner,
        repo: upstreamRepo,
        ref: `heads/${branchName}`,
        sha: baseCommitSha,
        force: true,
      });
    }

    // 3. Create tree and commit
    const treeItems: any[] = [];
    for (const f of files) {
      const blob = await this.octokit.rest.git.createBlob({
        owner: forkOwner,
        repo: upstreamRepo,
        content: Buffer.from(f.content).toString('base64'),
        encoding: 'base64',
      });
      treeItems.push({
        path: f.path,
        mode: (f as GitTreeEntry).mode || '100644',
        type: (f as GitTreeEntry).type || 'blob',
        sha: blob.data.sha,
      });
    }

    const newTree = await this.octokit.rest.git.createTree({
      owner: forkOwner,
      repo: upstreamRepo,
      base_tree: baseTreeSha,
      tree: treeItems,
    });

    let finalCommitMessage = commitMessage;
    if (dcoSignOff && !finalCommitMessage.includes('Signed-off-by:')) {
      const user = await this.octokit.rest.users.getAuthenticated();
      finalCommitMessage += `\n\nSigned-off-by: ${user.data.name || user.data.login} <${user.data.email || 'noreply@github.com'}>`;
    }

    const newCommit = await this.octokit.rest.git.createCommit({
      owner: forkOwner,
      repo: upstreamRepo,
      message: finalCommitMessage,
      tree: newTree.data.sha,
      parents: [baseCommitSha],
    });

    await this.octokit.rest.git.updateRef({
      owner: forkOwner,
      repo: upstreamRepo,
      ref: `heads/${branchName}`,
      sha: newCommit.data.sha,
      force: true,
    });

    // 4. Create Pull Request
    const prResp = await this.octokit.rest.pulls.create({
      owner: upstreamOwner,
      repo: upstreamRepo,
      title,
      body,
      head: `${forkOwner}:${branchName}`,
      base: baseBranch,
      draft: isDraft,
    });

    return {
      prNumber: prResp.data.number,
      prUrl: prResp.data.html_url,
      branchUrl: `https://github.com/${forkOwner}/${upstreamRepo}/tree/${branchName}`,
      isDraft,
      status: 'SUCCESS',
    };
  }
}
