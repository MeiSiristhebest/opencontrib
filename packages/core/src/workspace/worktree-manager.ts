import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve, sep } from 'path';
import { sanitizeRunId } from '../run/artifact-bundle.js';

/** Normalize path separators to forward slashes for consistent comparison on all platforms. */
function norm(p: string): string {
  return p.replace(/\\/g, '/');
}

export function safeRmSync(
  targetPath: string,
  opts: { recursive?: boolean; force?: boolean; maxRetries?: number; retryDelay?: number } = {},
  allowedParents?: string[],
): boolean {
  const resolved = norm(resolve(targetPath));
  const homedirPath = norm(resolve(homedir()));
  const tempDir = norm(resolve(tmpdir()));
  const opencontribHome = norm(resolve(homedirPath, '.opencontrib'));

  const SEP = '/';

  // Allowlist: must be within one of these parents
  const defaultAllowed = [
    opencontribHome,
    tempDir,
    ...(allowedParents || []).map((p) => norm(resolve(p))),
  ];
  const isWithinAllowed = defaultAllowed.some((parent) =>
    resolved === parent || resolved.startsWith(parent + SEP),
  );

  if (!isWithinAllowed) {
    console.error(`[SAFE_RMSNRC] BLOCKED: '${targetPath}' is outside allowed parent directories`);
    console.error(`  Allowed: ${defaultAllowed.join(', ')}`);
    console.error(`  Target:  ${resolved}`);
    return false;
  }

  // Never delete root directories themselves (only their children)
  if (resolved === opencontribHome || resolved === homedirPath || resolved === tempDir || resolved === '/') {
    console.error(`[SAFE_RMSNRC] BLOCKED: Refusing to delete root directory '${targetPath}'`);
    return false;
  }

  try {
    rmSync(resolved, opts);
    return true;
  } catch (err: any) {
    console.error(`[SAFE_RMSNRC] FAILED: rmSync('${targetPath}'): ${err.message}`);
    return false;
  }
}

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
    const headResult = this.runGit(['-C', sourceRepoPath, 'symbolic-ref', 'refs/remotes/origin/HEAD']);
    if (headResult.success && headResult.stdout.trim()) {
      const match = headResult.stdout.trim().match(/refs\/remotes\/origin\/(.+)$/);
      if (match) return match[1];
    }

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

    if (existsSync(workspacePath)) {
      return {
        workspacePath,
        branchName,
        isWorktree: true,
        baseRepoPath: localRepoPath || workspacePath,
      };
    }

    let sourceRepoPath = localRepoPath;

    if (!sourceRepoPath || !existsSync(sourceRepoPath)) {
      const cachedRepoPath = join(this.cacheRoot, sanitizedRepoName);
      if (!existsSync(cachedRepoPath)) {
        const cloneUrl = `https://github.com/${repoFullName}.git`;
        this.runGit(['clone', '--bare', '--depth', '1', cloneUrl, cachedRepoPath]);
      }
      sourceRepoPath = cachedRepoPath;
    }

    const defaultBranch = this.detectDefaultBranch(sourceRepoPath);

    try {
      const shaRes = this.runGit(['-C', sourceRepoPath, 'rev-parse', 'HEAD']);
      const baseCommitSha = shaRes.success ? shaRes.stdout.trim() : undefined;

      this.runGit(['-C', sourceRepoPath, 'worktree', 'prune']);
      this.runGit(['-C', sourceRepoPath, 'branch', '-D', branchName]);

      if (existsSync(workspacePath)) {
        try {
          safeRmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {}
      }

      const addResult = this.runGit([
        '-C', sourceRepoPath,
        'worktree', 'add', '--force', '-B', branchName, workspacePath, 'HEAD',
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
      if (existsSync(workspacePath)) {
        try {
          safeRmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {}
      }
      mkdirSync(workspacePath, { recursive: true });
      const cloneUrl = `https://github.com/${repoFullName}.git`;
      const cloneRes = this.runGit(['clone', '--depth', '1', '-b', defaultBranch, cloneUrl, workspacePath]);
      if (cloneRes.success) {
        const shaRes = this.runGit(['-C', workspacePath, 'rev-parse', 'HEAD']);
        const baseCommitSha = shaRes.success ? shaRes.stdout.trim() : undefined;
        this.runGit(['-C', workspacePath, 'checkout', '-B', branchName]);
        return {
          workspacePath,
          branchName,
          isWorktree: false,
          baseRepoPath: workspacePath,
          baseCommitSha,
        };
      } else {
        if (existsSync(workspacePath)) {
          try {
            safeRmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
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
        safeRmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {}
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

    if (existsSync(this.workspaceRoot)) {
      const { readdirSync } = require('fs');
      const items = readdirSync(this.workspaceRoot);
      for (const item of items) {
        const itemPath = join(this.workspaceRoot, item);
        try {
          if (safeRmSync(itemPath, { recursive: true, force: true })) {
            purgedWorkspaces.push(item);
          }
        } catch {}
      }
    }

    let cleanedRepos = false;
    if (cleanRepos && existsSync(this.cacheRoot)) {
      try {
        if (safeRmSync(this.cacheRoot, { recursive: true, force: true })) {
          mkdirSync(this.cacheRoot, { recursive: true });
          cleanedRepos = true;
        }
      } catch {}
    }

    if (cleanScratchDir && existsSync(cleanScratchDir)) {
      if (!this.isSafeScratchDirectory(cleanScratchDir)) {
        throw new Error(
          `Security boundary violation: cleanScratchDir "${cleanScratchDir}" is not a permitted scratch location.`,
        );
      }
      const { readdirSync } = require('fs');
      const scratchItems = readdirSync(cleanScratchDir);
      for (const item of scratchItems) {
        const itemPath = join(cleanScratchDir, item);
        try {
          if (safeRmSync(itemPath, { recursive: true, force: true })) {
            purgedScratchFiles.push(item);
          }
        } catch {}
      }
    }

    return {
      purgedWorkspaces,
      purgedScratchFiles,
      cleanedRepos,
    };
  }

  isSafeScratchDirectory(dirPath: string): boolean {
    const resolved = norm(resolve(dirPath));
    const opencontribHome = norm(resolve(homedir(), '.opencontrib'));
    const { tmpdir } = require('os');
    const tempDir = norm(resolve(tmpdir()));

    if (resolved === '/' || resolved === norm(resolve(homedir()))) {
      return false;
    }

    if (resolved.startsWith(opencontribHome + '/') || resolved === opencontribHome) {
      return true;
    }
    if (resolved.startsWith(tempDir + '/') || resolved === tempDir) {
      return true;
    }

    const parts = resolved.split('/');
    const lastPart = parts[parts.length - 1]?.toLowerCase() || '';
    if (lastPart === 'scratch' || lastPart === '.scratch' || parts.includes('.opencontrib')) {
      return true;
    }

    return false;
  }

  isPathWithinWorkspace(workspacePath: string, targetRelativePath: string): boolean {
    const resolvedRoot = resolve(workspacePath);
    const resolvedTarget = resolve(workspacePath, targetRelativePath);
    return resolvedTarget.startsWith(resolvedRoot + sep) || resolvedTarget === resolvedRoot;
  }

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
    for (const f of files) totalChars += f.content.length;
    if (totalChars > MAX_GENERATED_FILE_CHARS) {
      errors.push(`Generated content size (${totalChars} chars) exceeds safety limit (${MAX_GENERATED_FILE_CHARS})`);
      return { appliedFiles, errors };
    }

    for (const f of files) {
      if (!this.isPathWithinWorkspace(workspacePath, f.path)) {
        errors.push(`Security violation: File path '${f.path}' attempts path traversal outside workspace root`);
        continue;
      }

      const normalizedPath = f.path.replace(/\\/g, '/');
      if (normalizedPath.startsWith('.git/') || normalizedPath === '.git') {
        errors.push(`Security violation: Write to protected directory '${f.path}' is forbidden`);
        continue;
      }

      const fullPath = resolve(workspacePath, f.path);
      try {
        const { dirname } = require('path');
        mkdirSync(dirname(fullPath), { recursive: true });
        writeFileSync(fullPath, f.content, 'utf8');
        appliedFiles.push({ path: f.path, operation: f.operation });
      } catch (err: any) {
        errors.push(`Failed writing '${f.path}': ${err.message}`);
      }
    }

    return { appliedFiles, errors };
  }
}
