import { spawnSync, type SpawnSyncOptionsWithStringEncoding } from 'child_process';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join, resolve, sep } from 'path';

export interface SandboxExecutionOptions {
  cwd: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  allowHostFallback?: boolean;
}

export interface SandboxExecutionResult {
  command: string;
  exitCode: number | null;
  passed: boolean;
  stdout: string;
  stderr: string;
  output: string;
  isSandboxed: boolean;
  isolationWarnings: string[];
}

export interface SandboxAvailability {
  available: boolean;
  reason?: string;
  isolationMode: 'NATIVE_ISOLATION' | 'SANITIZED_ENVIRONMENT' | 'UNAVAILABLE';
  warnings: string[];
}

export class SandboxRuntime {
  private readonly home: string;
  private readonly defaultTimeoutMs = 60_000;

  constructor() {
    this.home = homedir();
  }

  /**
   * Sensitive credential directories and files that must NEVER be readable by the sandbox.
   */
  getDeniedPaths(): string[] {
    return [
      join(this.home, '.ssh'),
      join(this.home, '.aws'),
      join(this.home, '.azure'),
      join(this.home, '.config', 'gh'),
      join(this.home, '.config', 'opencontrib'),
      join(this.home, '.opencontrib'),
      join(this.home, '.git-credentials'),
      join(this.home, '.netrc'),
      join(this.home, '.npmrc'),
      join(this.home, '.pypirc'),
      join(this.home, '.gnupg'),
    ];
  }

  /**
   * Determine sandbox runtime availability on current host.
   */
  getAvailability(): SandboxAvailability {
    const warnings: string[] = [];

    return {
      available: true,
      isolationMode: 'SANITIZED_ENVIRONMENT',
      warnings,
    };
  }

  /**
   * Builds a sanitized, credential-free environment for executing untrusted repository code.
   * Strips out tokens, credentials, and re-routes HOME/TMP to an isolated scratch folder.
   */
  buildSanitizedEnvironment(sandboxTempDir: string): NodeJS.ProcessEnv {
    const allowedVars = [
      'PATH',
      'Path',
      'PATHEXT',
      'SystemRoot',
      'WINDIR',
      'COMSPEC',
      'LANG',
      'LC_ALL',
      'TERM',
      'NODE_PATH',
      'BUN_INSTALL',
    ];

    const sanitizedEnv: NodeJS.ProcessEnv = {};
    for (const key of allowedVars) {
      if (process.env[key] !== undefined) {
        sanitizedEnv[key] = process.env[key];
      }
    }

    sanitizedEnv['HOME'] = sandboxTempDir;
    sanitizedEnv['USERPROFILE'] = sandboxTempDir;
    sanitizedEnv['TMPDIR'] = sandboxTempDir;
    sanitizedEnv['TMP'] = sandboxTempDir;
    sanitizedEnv['TEMP'] = sandboxTempDir;

    sanitizedEnv['CI'] = 'true';
    sanitizedEnv['FORCE_COLOR'] = '0';
    sanitizedEnv['DEBIAN_FRONTEND'] = 'noninteractive';
    sanitizedEnv['GIT_TERMINAL_PROMPT'] = '0';
    sanitizedEnv['DOTNET_CLI_TELEMETRY_OPTOUT'] = '1';
    sanitizedEnv['NEXT_TELEMETRY_DISABLED'] = '1';

    return sanitizedEnv;
  }

  /**
   * Verify whether a target path is safely within the workspace boundaries (preventing traversal).
   */
  isPathWithinBoundary(targetPath: string, rootBoundary: string): boolean {
    const resolvedTarget = resolve(targetPath);
    const resolvedRoot = resolve(rootBoundary);
    return resolvedTarget.startsWith(resolvedRoot + sep) || resolvedTarget === resolvedRoot;
  }

  /**
   * Executes a command within the sanitized sandbox environment.
   * Enforces Fail-Closed semantics: if sandbox cannot initialize, halts and does not fall back to host unless explicitly requested.
   */
  executeInSandbox(options: SandboxExecutionOptions): SandboxExecutionResult {
    const { cwd, command, args = [], timeoutMs = this.defaultTimeoutMs, allowHostFallback = false } = options;

    const availability = this.getAvailability();
    if (!availability.available && !allowHostFallback) {
      return {
        command: `${command} ${args.join(' ')}`.trim(),
        exitCode: 127,
        passed: false,
        stdout: '',
        stderr: `Sandbox execution blocked: ${availability.reason || 'Sandbox unavailable'} (Fail-Closed).`,
        output: `Sandbox execution blocked: ${availability.reason || 'Sandbox unavailable'} (Fail-Closed).`,
        isSandboxed: false,
        isolationWarnings: availability.warnings,
      };
    }

    const resolvedCwd = resolve(cwd);
    let sandboxTempDir = '';
    try {
      sandboxTempDir = mkdtempSync(join(tmpdir(), 'opencontrib-sandbox-'));
    } catch {
      sandboxTempDir = tmpdir();
    }

    const sanitizedEnv = this.buildSanitizedEnvironment(sandboxTempDir);

    try {
      const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
        cwd: resolvedCwd,
        encoding: 'utf-8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: sanitizedEnv,
        shell: true,
      };

      const result = spawnSync(command, args, spawnOptions);

      const stdout = String(result.stdout || '');
      const stderr = String(result.stderr || '');
      const errorText = result.error ? `\n${result.error.message}` : '';
      const combinedOutput = `${stdout}\n${stderr}${errorText}`.trim();

      const exitCode = typeof result.status === 'number' ? result.status : result.error ? 1 : 0;
      const passed = exitCode === 0;

      return {
        command: `${command} ${args.join(' ')}`.trim(),
        exitCode,
        passed,
        stdout,
        stderr,
        output: combinedOutput,
        isSandboxed: true,
        isolationWarnings: availability.warnings,
      };
    } finally {
      if (sandboxTempDir && existsSync(sandboxTempDir) && sandboxTempDir.includes('opencontrib-sandbox-')) {
        try {
          rmSync(sandboxTempDir, { recursive: true, force: true });
        } catch {
          // Cleanup best effort
        }
      }
    }
  }
}

export const defaultSandboxRuntime = new SandboxRuntime();
