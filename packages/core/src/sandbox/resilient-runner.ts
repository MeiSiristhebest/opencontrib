import { spawnSync } from 'child_process';
import * as path from 'path';
import { homedir as osHomedir, platform } from 'os';

export interface ResilientRunOptions {
  cwd: string;
  command: string;
  args?: string[];
  timeoutMs?: number;
  modifiedFiles?: string[];
  allowFullScan?: boolean;
}

export interface ResilientRunResult {
  isSuccess: boolean;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  targetedPackage?: string;
  warnings: string[];
}

export function resolveTargetedTestPackage(modifiedFiles: string[]): string | undefined {
  if (!modifiedFiles || modifiedFiles.length === 0) return undefined;

  const dirs = Array.from(
    new Set(
      modifiedFiles.map((f) => {
        const d = dirname(f).replace(/\\/g, '/');
        return d === '.' ? '.' : `./${d}`;
      })
    )
  );

  return dirs.join(' ');
}

export function sanitizeTestCommand(
  command: string,
  args: string[] = [],
  forceNoGcc = false,
  targetPlatform?: NodeJS.Platform
): { sanitizedCommand: string; sanitizedArgs: string[]; warnings: string[] } {
  const warnings: string[] = [];
  let finalArgs = [...args];
  const os = targetPlatform || (forceNoGcc ? 'win32' : platform());

  // 1. Windows -race CGO trap detection
  if (os === 'win32' && (command.includes('-race') || finalArgs.includes('-race'))) {
    const hasGcc = !forceNoGcc && (() => {
      try {
        const gccCheck = spawnSync('gcc', ['--version'], { stdio: 'ignore' });
        return !gccCheck.error && gccCheck.status === 0;
      } catch {
        return false;
      }
    })();

    if (!hasGcc) {
      warnings.push(
        "Detected '-race' on Windows without GCC/MinGW installed. Automatically stripped '-race' to prevent status 0xc0000139 DLL crash."
      );
      finalArgs = finalArgs.filter((a) => a !== '-race');
    }
  }

  return { sanitizedCommand: command, sanitizedArgs: finalArgs, warnings };
}

export function runResilientCommand(options: ResilientRunOptions): ResilientRunResult {
  const { cwd, command, args = [], timeoutMs = 30000, modifiedFiles = [], allowFullScan = false } = options;
  const warnings: string[] = [];
  let currentArgs = [...args];

  // Validate cwd boundary — prevent execution outside sandbox/workspace
  const resolvedCwd = path.resolve(cwd);
  const opencontribHome = process.env.OPENCONTRIB_HOME || process.env.HOME || osHomedir();
  const sandboxRoot = path.join(opencontribHome, '.opencontrib', 'workspaces');
  const resolvedSandbox = path.resolve(sandboxRoot);
  const resolvedHome = path.resolve(opencontribHome);
  if (!resolvedCwd.startsWith(resolvedSandbox + path.sep) &&
      !resolvedCwd.startsWith(resolvedHome + path.sep) &&
      resolvedCwd !== resolvedHome) {
    return { isSuccess: false, exitCode: 126, stdout: '', stderr: `Blocked: cwd "${cwd}" outside sandbox boundary`, executionTimeMs: 0, warnings: ['CWD boundary violation'] };
  }
  let targetedPackage: string | undefined;

  // Check and rewrite broad full repo tests into targeted package tests
  const fullCmdStr = `${command} ${currentArgs.join(' ')}`;
  if (!allowFullScan) {
    const targeted = resolveTargetedTestPackage(modifiedFiles);
    if (targeted && targeted !== '.') {
      targetedPackage = targeted;
      if (fullCmdStr.includes('go test ./...')) {
        currentArgs = currentArgs.map((a) => (a === './...' ? `${targeted}/...` : a));
        warnings.push(`Targeted test optimization applied: rewritten to '${targeted}/...' instead of scanning entire repository.`);
      } else if (fullCmdStr.includes('pytest .') || fullCmdStr === 'pytest') {
        currentArgs = currentArgs.map((a) => (a === '.' ? targeted : a));
        if (!currentArgs.includes(targeted)) currentArgs.push(targeted);
        warnings.push(`Targeted test optimization applied: focused on '${targeted}' instead of scanning entire repository.`);
      }
    }
  }

  const { sanitizedCommand, sanitizedArgs, warnings: sanitizeWarnings } = sanitizeTestCommand(command, currentArgs);
  warnings.push(...sanitizeWarnings);

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = 1;

  try {
    // SECURITY: Spread process.env to preserve toolchain vars (GOROOT, GOPATH,
    // CARGO_HOME, RUSTUP_HOME, JAVA_HOME, NODE_PATH, PYTHONPATH, etc.) but
    // strip credential-bearing keys to prevent secret leakage to subprocesses.
    const CREDENTIAL_ENV_KEYS = new Set([
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'GITLAB_TOKEN',
      'NPM_TOKEN',
      'NPM_AUTH_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_ACCESS_KEY_ID',
      'AWS_SESSION_TOKEN',
      'AZURE_CLIENT_SECRET',
      'AZURE_TENANT_ID',
      'GCP_SERVICE_ACCOUNT_KEY',
      'GOOGLE_APPLICATION_CREDENTIALS',
      'SLACK_TOKEN',
      'DOCKER_TOKEN',
      'DOCKER_PASSWORD',
      'PRIVATE_KEY',
      'SSH_AUTH_SOCK',
    ]);

    const sanitizedEnv: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!CREDENTIAL_ENV_KEYS.has(key)) {
        sanitizedEnv[key] = value;
      }
    }
    sanitizedEnv.CI = 'true';
    sanitizedEnv.FORCE_COLOR = '0';

    const res = spawnSync(sanitizedCommand, sanitizedArgs, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      env: sanitizedEnv,
      shell: false,
    });

    const MAX_OUTPUT = 256 * 1024;
    stdout = res.stdout || '';
    stderr = res.stderr || '';
    if (stdout.length > MAX_OUTPUT) stdout = stdout.slice(0, MAX_OUTPUT) + '\n[TRUNCATED]';
    if (stderr.length > MAX_OUTPUT) stderr = stderr.slice(0, MAX_OUTPUT) + '\n[TRUNCATED]';
    exitCode = res.status;

    if (res.error) {
      if ((res.error as any).code === 'ETIMEDOUT') {
        warnings.push(`Command timed out after ${timeoutMs / 1000}s and was terminated to prevent hung processes.`);
      } else {
        warnings.push(`Subprocess error: ${res.error.message}`);
      }
    }
  } catch (err: any) {
    stderr = err.message;
    exitCode = 1;
  }

  const executionTimeMs = Date.now() - startTime;
  const isSuccess = exitCode === 0;

  return {
    isSuccess,
    exitCode,
    stdout,
    stderr,
    executionTimeMs,
    targetedPackage: resolveTargetedTestPackage(modifiedFiles),
    warnings,
  };
}
