import { execFileSync, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { safeRmSync } from '../workspace/worktree-manager.js';

export interface WorktreeSandboxOptions {
  repoPath: string;
  branchName?: string;
  baseCommit?: string;
}

export interface WorktreeExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Clean-Room Git Worktree Sandbox Manager
 * Spawns an isolated git worktree in OS temporary storage to safely mutate, test, and verify fixes without polluting workspace.
 */
export class WorktreeSandbox {
  public readonly sandboxPath: string;
  public readonly branchName: string;
  public readonly repoPath: string;
  private isDestroyed = false;

  constructor(options: WorktreeSandboxOptions) {
    this.repoPath = path.resolve(options.repoPath);
    const id = Math.random().toString(36).substring(2, 9);
    this.branchName = options.branchName || `opencontrib/verify-${id}`;
    this.sandboxPath = path.join(os.tmpdir(), `opencontrib-wt-${id}`);

    const base = options.baseCommit || 'HEAD';

    try {
      execFileSync('git', ['worktree', 'add', '-b', this.branchName, this.sandboxPath, base], {
        cwd: this.repoPath,
        stdio: 'pipe',
        encoding: 'utf8',
      });
    } catch {
      // Fallback: if not a full git repo or detached, create standalone directory copy
      if (!fs.existsSync(this.sandboxPath)) {
        fs.mkdirSync(this.sandboxPath, { recursive: true });
        this.copyDirRecursive(this.repoPath, this.sandboxPath);
      }
    }
  }

  /**
   * Executes a command inside the clean-room sandbox
   */
  public exec(cmd: string, timeoutMs = 60000): WorktreeExecResult {
    if (this.isDestroyed) {
      throw new Error(`Cannot execute in destroyed sandbox: ${this.sandboxPath}`);
    }

    const res = spawnSync(cmd, {
      cwd: this.sandboxPath,
      shell: true,
      encoding: 'utf8',
      timeout: timeoutMs,
    });

    return {
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      exitCode: res.status ?? (res.error ? 1 : 0),
    };
  }

  /**
   * Writes a file inside the clean-room sandbox
   */
  public writeFile(relPath: string, content: string): void {
    const fullPath = path.join(this.sandboxPath, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  /**
   * Reads a file inside the clean-room sandbox
   */
  public readFile(relPath: string): string {
    const fullPath = path.join(this.sandboxPath, relPath);
    return fs.readFileSync(fullPath, 'utf8');
  }

  /**
   * Applies an atomic patch or code replacement inside the clean-room sandbox
   */
  public applyPatch(relFile: string, targetContent: string, replacementContent: string): boolean {
    const fullPath = path.join(this.sandboxPath, relFile);
    if (!fs.existsSync(fullPath)) return false;

    const original = fs.readFileSync(fullPath, 'utf8');
    if (!original.includes(targetContent)) return false;

    const patched = original.replace(targetContent, replacementContent);
    fs.writeFileSync(fullPath, patched, 'utf8');
    return true;
  }

  /**
   * Commits the sandbox state to the isolated branch
   */
  public commit(message: string): boolean {
    try {
      execFileSync('git', ['add', '-A'], { cwd: this.sandboxPath, stdio: 'pipe' });
      execFileSync('git', ['commit', '-m', message], {
        cwd: this.sandboxPath,
        stdio: 'pipe',
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Cleans up the ephemeral worktree and deletes the sandbox branch
   */
  public cleanup(): void {
    if (this.isDestroyed) return;
    this.isDestroyed = true;

    try {
      if (fs.existsSync(this.sandboxPath)) {
        execFileSync('git', ['worktree', 'remove', '--force', this.sandboxPath], {
          cwd: this.repoPath,
          stdio: 'ignore',
        });
      }
    } catch {
      // If git worktree cleanup fails, remove directory manually via safe guard
      try {
        if (fs.existsSync(this.sandboxPath)) {
          safeRmSync(this.sandboxPath, { recursive: true, force: true });
        }
      } catch {
        // Handled
      }
    }

    try {
      execFileSync('git', ['branch', '-D', this.branchName], {
        cwd: this.repoPath,
        stdio: 'ignore',
      });
    } catch {
      // Handled
    }
  }

  private copyDirRecursive(src: string, dest: string): void {
    if (!fs.existsSync(src)) return;
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(destPath, { recursive: true });
        this.copyDirRecursive(srcPath, destPath);
      } else {
        fs.copyFileSync(srcPath, destPath);
      }
    }
  }
}
