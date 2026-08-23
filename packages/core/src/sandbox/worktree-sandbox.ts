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

function parseExecCommand(cmd: string): { cmd: string; args: string[] } {
  const trimmed = cmd.trim();
  if (!trimmed) {
    throw new Error('Empty command string');
  }

  const parts: string[] = [];
  let current = '';
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (const ch of trimmed) {
    if (escaped) {
      current += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\' && !inSingleQuote) {
      escaped = true;
      continue;
    }
    if (ch === '\'' && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (/\s/.test(ch) && !inSingleQuote && !inDoubleQuote) {
      if (current) {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) parts.push(current);
  if (parts.length === 0) {
    throw new Error('No command parsed');
  }
  return { cmd: parts[0], args: parts.slice(1) };
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
      if (!fs.existsSync(this.sandboxPath)) {
        fs.mkdirSync(this.sandboxPath, { recursive: true });
        this.copyDirRecursive(this.repoPath, this.sandboxPath);
      }
    }
  }

  private isWithinSandbox(relPath: string): boolean {
    const fullPath = path.resolve(this.sandboxPath, relPath);
    const sandboxResolved = path.resolve(this.sandboxPath);
    return fullPath === sandboxResolved || fullPath.startsWith(sandboxResolved + path.sep);
  }

  public exec(cmd: string, timeoutMs = 60000): WorktreeExecResult {
    if (this.isDestroyed) {
      throw new Error(`Cannot execute in destroyed sandbox: ${this.sandboxPath}`);
    }

    const { cmd: program, args } = parseExecCommand(cmd);

    const res = spawnSync(program, args, {
      cwd: this.sandboxPath,
      encoding: 'utf8',
      timeout: timeoutMs,
      shell: false,
    });

    return {
      stdout: res.stdout || '',
      stderr: res.stderr || '',
      exitCode: res.status ?? (res.error ? 1 : 0),
    };
  }

  public writeFile(relPath: string, content: string): void {
    if (!this.isWithinSandbox(relPath)) {
      throw new Error(`Path traversal blocked: '${relPath}' escapes sandbox boundary`);
    }
    const fullPath = path.join(this.sandboxPath, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, 'utf8');
  }

  public readFile(relPath: string): string {
    if (!this.isWithinSandbox(relPath)) {
      throw new Error(`Path traversal blocked: '${relPath}' escapes sandbox boundary`);
    }
    const fullPath = path.join(this.sandboxPath, relPath);
    return fs.readFileSync(fullPath, 'utf8');
  }

  public applyPatch(relFile: string, targetContent: string, replacementContent: string): boolean {
    if (!this.isWithinSandbox(relFile)) {
      throw new Error(`Path traversal blocked: '${relFile}' escapes sandbox boundary`);
    }
    const fullPath = path.join(this.sandboxPath, relFile);
    if (!fs.existsSync(fullPath)) return false;

    const original = fs.readFileSync(fullPath, 'utf8');
    if (!original.includes(targetContent)) return false;

    const patched = original.replace(targetContent, replacementContent);
    fs.writeFileSync(fullPath, patched, 'utf8');
    return true;
  }

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
      if (entry.isSymbolicLink()) continue; // Block symlinks: can escape sandbox boundary
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
