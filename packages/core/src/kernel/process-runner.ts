/**
 * ProcessRunner — the ONE place in the codebase that spawns child processes.
 *
 * Previously there were 3 near-identical copies of `execWithSpawn` (in
 * `probe/runner.ts`, `kernel/scan-scheduler.ts`, `kernel/plugin-host.ts`) and
 * 2 copies of a binary-availability probe. That violated DIP (duplicate
 * infrastructure code) and made the credential-stripping env policy easy to
 * drift. This module is the single, tested boundary for process execution.
 */

import { spawn, spawnSync } from 'child_process';
import { parseCommandSpec } from '../sandbox/command-spec.js';

export interface ExecOptions {
  cwd?: string;
  timeout?: number;
  /** Cap on combined stdout+stderr. Defaults to 10 MiB (fail-closed). */
  maxBuffer?: number;
  /** Defaults to `process.platform === 'win32'`. */
  shell?: boolean;
  /** Environment for the child. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
}

const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Spawn a command parsed via the sandbox command spec, with timeout,
 * output-size guard, and SIGKILL teardown. Behaviour is parameterised so the
 * three historical call sites keep their exact semantics.
 */
export async function execWithSpawn(
  cmd: string,
  opts: ExecOptions = {},
): Promise<ExecResult> {
  const cwd = opts.cwd || process.cwd();
  const parsed = parseCommandSpec(cmd);
  if (!parsed.executable || parsed.executable.length === 0) {
    return Promise.reject(new Error('Empty command'));
  }

  const shell = opts.shell ?? process.platform === 'win32';
  const maxLen = opts.maxBuffer ?? DEFAULT_MAX_BUFFER;
  const env = opts.env ?? process.env;

  return new Promise<ExecResult>((resolve, reject) => {
    const child = spawn(parsed.executable, parsed.args, {
      cwd,
      shell,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let killed = false;

    const timer = opts.timeout
      ? setTimeout(() => {
          if (killed) return;
          killed = true;
          try {
            child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
          } catch {
            /* best effort */
          }
          reject(new Error(`Command timed out after ${opts.timeout}ms: ${cmd}`));
        }, opts.timeout)
      : undefined;

    const guardOutput = (kind: 'stdout' | 'stderr', chunk: string): boolean => {
      const target = kind === 'stdout' ? (stdout += chunk) && stdout : (stderr += chunk) && stderr;
      if (target.length > maxLen) {
        if (!killed) {
          killed = true;
          try {
            child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
          } catch {
            /* best effort */
          }
        }
        clearTimeout(timer);
        reject(new Error(`Output exceeded ${maxLen} bytes`));
        return false;
      }
      return true;
    };

    child.stdout.on('data', (d) => guardOutput('stdout', d.toString()));
    child.stderr.on('data', (d) => guardOutput('stderr', d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) {
        reject(new Error(stderr || `Command exited with code ${code}: ${cmd}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

/** Port for binary availability detection — injectable for testing. */
export interface BinaryProbe {
  isAvailable(bin: string): boolean;
}

/** Shared module-level cache so repeated `isBinaryAvailable` stays cheap. */
const sharedBinaryCache = new Map<string, boolean>();

/**
 * Default `BinaryProbe` backed by `command -v` / `where.exe`.
 * `env` lets callers pass a credential-stripped environment.
 */
export class SystemBinaryProbe implements BinaryProbe {
  constructor(
    private readonly cache: Map<string, boolean> = sharedBinaryCache,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  isAvailable(bin: string): boolean {
    if (this.cache.has(bin)) return this.cache.get(bin)!;
    try {
      const isWindows = process.platform === 'win32';
      const cmd = isWindows ? 'where.exe' : 'command';
      const args = isWindows ? ['-q', bin] : ['-v', bin];
      const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000, env: this.env });
      this.cache.set(bin, result.status === 0);
      return result.status === 0;
    } catch {
      this.cache.set(bin, false);
      return false;
    }
  }
}

export const defaultBinaryProbe = new SystemBinaryProbe();
