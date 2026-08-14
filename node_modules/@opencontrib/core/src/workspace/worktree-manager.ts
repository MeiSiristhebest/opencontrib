import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';

export interface WorkspaceContext {
  workspacePath: string;
  branchName: string;
  isWorktree: boolean;
  baseRepoPath: string;
}

export class WorktreeManager {
  private workspaceRoot: string;
  private cacheRoot: string;

  constructor() {
    this.workspaceRoot = join(homedir(), '.opencontrib', 'workspaces');
    this.cacheRoot = join(homedir(), '.opencontrib', 'repos');

    if (!existsSync(this.workspaceRoot)) mkdirSync(this.workspaceRoot, { recursive: true });
    if (!existsSync(this.cacheRoot)) mkdirSync(this.cacheRoot, { recursive: true });
  }

  private runGit(args: string[], cwd?: string): { success: boolean; stdout: string; stderr: string } {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    });
    return {
      success: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  createIsolatedWorkspace(input: {
    repoFullName: string;
    issueOrTaskId: string | number;
    localRepoPath?: string;
  }): WorkspaceContext {
    const { repoFullName, issueOrTaskId, localRepoPath } = input;
    const sanitizedRepoName = repoFullName.replace('/', '__');
    const branchName = `opencontrib/fix-${issueOrTaskId}`;
    const workspacePath = join(this.workspaceRoot, `${sanitizedRepoName}__${issueOrTaskId}`);

    // If workspace directory already exists, return it or clean it
    if (existsSync(workspacePath)) {
      return {
        workspacePath,
        branchName,
        isWorktree: true,
        baseRepoPath: localRepoPath || workspacePath,
      };
    }

    let sourceRepoPath = localRepoPath;

    // If no local repo provided, clone or reuse in cache
    if (!sourceRepoPath || !existsSync(sourceRepoPath)) {
      const cachedRepoPath = join(this.cacheRoot, sanitizedRepoName);
      if (!existsSync(cachedRepoPath)) {
        const cloneUrl = `https://github.com/${repoFullName}.git`;
        this.runGit(['clone', '--bare', cloneUrl, cachedRepoPath]);
      }
      sourceRepoPath = cachedRepoPath;
    }

    // Create Git Worktree
    try {
      // Clean previous branch if it existed
      this.runGit(['-C', sourceRepoPath, 'branch', '-D', branchName]);

      const addResult = this.runGit([
        '-C',
        sourceRepoPath,
        'worktree',
        'add',
        '-B',
        branchName,
        workspacePath,
        'HEAD',
      ]);

      if (!addResult.success) throw new Error(addResult.stderr);

      return {
        workspacePath,
        branchName,
        isWorktree: true,
        baseRepoPath: sourceRepoPath,
      };
    } catch (err) {
      // Fallback: If worktree add fails, clone regular working copy into workspace
      if (existsSync(workspacePath)) rmSync(workspacePath, { recursive: true, force: true });
      const cloneUrl = `https://github.com/${repoFullName}.git`;
      this.runGit(['clone', '--depth', '1', '-b', 'main', cloneUrl, workspacePath]);
      this.runGit(['-C', workspacePath, 'checkout', '-b', branchName]);

      return {
        workspacePath,
        branchName,
        isWorktree: false,
        baseRepoPath: workspacePath,
      };
    }
  }

  cleanupWorkspace(workspacePath: string, baseRepoPath?: string): void {
    if (!existsSync(workspacePath)) return;

    if (baseRepoPath && existsSync(baseRepoPath)) {
      this.runGit(['-C', baseRepoPath, 'worktree', 'remove', '--force', workspacePath]);
    }

    if (existsSync(workspacePath)) {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  }

  purgeAllWorkspaces(options: {
    cleanRepos?: boolean;
    cleanScratchDir?: string;
  } = {}): {
    purgedWorkspaces: string[];
    purgedScratchFiles: string[];
    cleanedRepos: boolean;
  } {
    const { cleanRepos = false, cleanScratchDir } = options;
    const purgedWorkspaces: string[] = [];
    const purgedScratchFiles: string[] = [];

    // 1. Purge all ephemeral worktrees in ~/.opencontrib/workspaces
    if (existsSync(this.workspaceRoot)) {
      const { readdirSync } = require('fs');
      const items = readdirSync(this.workspaceRoot);
      for (const item of items) {
        const itemPath = join(this.workspaceRoot, item);
        try {
          rmSync(itemPath, { recursive: true, force: true });
          purgedWorkspaces.push(item);
        } catch {}
      }
    }

    // 2. Optionally purge cached bare repos in ~/.opencontrib/repos
    let cleanedRepos = false;
    if (cleanRepos && existsSync(this.cacheRoot)) {
      try {
        rmSync(this.cacheRoot, { recursive: true, force: true });
        mkdirSync(this.cacheRoot, { recursive: true });
        cleanedRepos = true;
      } catch {}
    }

    // 3. Clean temporary scratch directory if specified
    if (cleanScratchDir && existsSync(cleanScratchDir)) {
      const { readdirSync } = require('fs');
      const scratchItems = readdirSync(cleanScratchDir);
      for (const item of scratchItems) {
        const itemPath = join(cleanScratchDir, item);
        try {
          rmSync(itemPath, { recursive: true, force: true });
          purgedScratchFiles.push(item);
        } catch {}
      }
    }

    return {
      purgedWorkspaces,
      purgedScratchFiles,
      cleanedRepos,
    };
  }
}

