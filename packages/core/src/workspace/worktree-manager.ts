import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve, sep, relative } from 'path';
import { sanitizeRunId } from '../run/artifact-bundle.js';


export const MAX_DISCOVERED_FILES = 250;
export const MAX_GENERATED_FILES = 6;
export const MAX_GENERATED_FILE_CHARS = 60_000;
export const MAX_SNIPPET_CHARS = 8_000;

export interface WorkspaceContext {
  workspacePath: string;
  branchName: string;
  isWorktree: boolean;
  baseRepoPath: string;
  baseCommitSha?: string;
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

  private runGit(args: string[], cwd?: string, timeoutMs = 25000): { success: boolean; stdout: string; stderr: string } {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_ASKPASS: 'echo',
      },
    });
    return {
      success: result.status === 0,
      stdout: result.stdout || '',
      stderr: result.stderr || '',
    };
  }

  detectDefaultBranch(sourceRepoPath: string): string {
    // 1. Try to read symbolic-ref of origin/HEAD
    const headResult = this.runGit(['-C', sourceRepoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (headResult.success && headResult.stdout.trim()) {
      const match = headResult.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1];
    }

    // 2. Check if main or master branch exists
    const branchResult = this.runGit(['-C', sourceRepoPath, 'branch', '-a']);
    if (branchResult.success) {
      if (branchResult.stdout.includes('main')) return 'main';
      if (branchResult.stdout.includes('master')) return 'master';
    }

    return 'main';
  }

  createIsolatedWorkspace(input: {
    repoFullName: string;
    issueOrTaskId: string | number;
    localRepoPath?: string;
    runId?: string;
  }): WorkspaceContext {
    const { repoFullName, issueOrTaskId, localRepoPath, runId } = input;
    const sanitizedRepoName = repoFullName.replace('/', '__');
    const cleanRunId = runId ? sanitizeRunId(runId) : '';
    const runSuffix = cleanRunId ? `-${cleanRunId.slice(-6)}` : '';
    const branchName = `opencontrib/fix-${issueOrTaskId}${runSuffix}`;
    const workspacePath = join(this.workspaceRoot, `${sanitizedRepoName}__${issueOrTaskId}${runSuffix}`);



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
        this.runGit(['clone', '--bare', '--depth', '1', cloneUrl, cachedRepoPath]);
      }
      sourceRepoPath = cachedRepoPath;
    }

    const defaultBranch = this.detectDefaultBranch(sourceRepoPath);

    // Create Git Worktree
    try {
      // Capture base commit SHA before creating worktree/branch
      const shaRes = this.runGit(['-C', sourceRepoPath, 'rev-parse', 'HEAD']);
      const baseCommitSha = shaRes.success ? shaRes.stdout.trim() : undefined;

      // Prune dead worktrees and clean previous branch if it existed
      this.runGit(['-C', sourceRepoPath, 'worktree', 'prune']);
      this.runGit(['-C', sourceRepoPath, 'branch', '-D', branchName]);

      // Remove existing workspacePath if leftover from previous run
      if (existsSync(workspacePath)) {
        try {
          rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {}
      }

      const addResult = this.runGit([
        '-C',
        sourceRepoPath,
        'worktree',
        'add',
        '--force',
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
        baseCommitSha,
      };
    } catch (err: any) {
      // Fallback: If worktree add fails, attempt direct single-branch clone into workspace
      if (existsSync(workspacePath)) {
        try {
          rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {}
      }
      mkdirSync(workspacePath, { recursive: true });
      const cloneUrl = `https://github.com/${repoFullName}.git`;
      const cloneRes = this.runGit(['clone', '--depth', '1', '-b', defaultBranch, cloneUrl, workspacePath]);
      if (cloneRes.success) {
        const shaRes = this.runGit(['-C', workspacePath, 'rev-parse', 'HEAD']);
        const baseCommitSha = shaRes.success ? shaRes.stdout.trim() : undefined;
        this.runGit(['-C', workspacePath, 'checkout', '-b', branchName]);
        return {
          workspacePath,
          branchName,
          isWorktree: false,
          baseRepoPath: workspacePath,
          baseCommitSha,
        };
      } else {
        // Clone failed: strictly fail-closed, refuse to masquerade as an empty repository
        if (existsSync(workspacePath)) {
          try {
            rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
          } catch {}
        }
        throw new Error(
          `Failed to create isolated workspace for ${repoFullName}: clone failed (${cloneRes.stderr || 'Network/Auth failure'}). Refusing to initialize empty repository.`,
        );
      }
    }

  }


  cleanupWorkspace(workspacePath: string, baseRepoPath?: string): void {
    if (!existsSync(workspacePath)) return;

    if (baseRepoPath && existsSync(baseRepoPath)) {
      try {
        this.runGit(['-C', baseRepoPath, 'worktree', 'remove', '--force', workspacePath]);
      } catch {}
    }

    if (existsSync(workspacePath)) {
      try {
        rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // Safe fallback for Windows file lock
      }
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

    // 3. Clean temporary scratch directory if specified (with strict boundary safety check)
    if (cleanScratchDir && existsSync(cleanScratchDir)) {
      if (!this.isSafeScratchDirectory(cleanScratchDir)) {
        throw new Error(
          `Security boundary violation: cleanScratchDir "${cleanScratchDir}" is not a permitted scratch location. Path must reside within ~/.opencontrib/, system temp, or be named "scratch".`,
        );
      }
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

  /**
   * Validates whether a directory is safe to purge as a scratch space.
   * Disallows system roots, home directory, and uncontained paths.
   */
  isSafeScratchDirectory(dirPath: string): boolean {
    const resolved = resolve(dirPath);
    const opencontribHome = resolve(homedir(), '.opencontrib');
    const { tmpdir } = require('os');
    const tempDir = resolve(tmpdir());

    // Explicitly disallow filesystem roots and user home directory
    if (resolved === '/' || /^[a-zA-Z]:\\?$/.test(resolved) || resolved === resolve(homedir())) {
      return false;
    }

    // Must be inside ~/.opencontrib, temp directory, or an explicitly named scratch folder
    if (resolved.startsWith(opencontribHome + sep) || resolved === opencontribHome) {
      return true;
    }

    if (resolved.startsWith(tempDir + sep) || resolved === tempDir) {
      return true;
    }

    const parts = resolved.split(sep);
    const lastPart = parts[parts.length - 1]?.toLowerCase() || '';
    if (lastPart === 'scratch' || lastPart === '.scratch' || parts.includes('.opencontrib')) {
      return true;
    }

    return false;
  }

  /**
   * Validates whether a relative or absolute path is strictly within the workspace boundary.
   * Prevents path traversal vulnerabilities.
   */
  isPathWithinWorkspace(workspacePath: string, targetRelativePath: string): boolean {
    const resolvedRoot = resolve(workspacePath);
    const resolvedTarget = resolve(workspacePath, targetRelativePath);
    return resolvedTarget.startsWith(resolvedRoot + sep) || resolvedTarget === resolvedRoot;
  }

  /**
   * Safely applies generated files to workspace, strictly enforcing file counts, size limits,
   * and path traversal boundaries.
   */
  applySurgicalFilesSafely(
    workspacePath: string,
    files: Array<{ path: string; operation: string; content: string }>,
  ): {
    appliedFiles: Array<{ path: string; operation: string }>;
    errors: string[];
  } {
    const appliedFiles: Array<{ path: string; operation: string }> = [];
    const errors: string[] = [];

    if (files.length > MAX_GENERATED_FILES) {
      errors.push(`Generated files count (${files.length}) exceeds safety limit (${MAX_GENERATED_FILES})`);
      return { appliedFiles, errors };
    }

    let totalChars = 0;
    for (const f of files) {
      totalChars += f.content.length;
    }
    if (totalChars > MAX_GENERATED_FILE_CHARS) {
      errors.push(`Generated content size (${totalChars} chars) exceeds safety limit (${MAX_GENERATED_FILE_CHARS})`);
      return { appliedFiles, errors };
    }

    for (const f of files) {
      if (!this.isPathWithinWorkspace(workspacePath, f.path)) {
        errors.push(`Security violation: File path '${f.path}' attempts path traversal outside workspace root`);
        continue;
      }

      // Deny writing into .git directory
      const normalizedPath = f.path.replace(/\\/g, '/');
      if (normalizedPath.startsWith('.git/') || normalizedPath === '.git') {
        errors.push(`Security violation: Write to protected directory '${f.path}' is forbidden`);
        continue;
      }

      const fullPath = resolve(workspacePath, f.path);
      try {
        const { dirname } = require('path');
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, f.content, 'utf-8');
        appliedFiles.push({ path: f.path, operation: f.operation });
      } catch (err: any) {
        errors.push(`Failed writing '${f.path}': ${err.message}`);
      }
    }

    return { appliedFiles, errors };
  }
}

