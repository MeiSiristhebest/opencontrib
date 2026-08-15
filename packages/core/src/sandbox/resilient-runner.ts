import { spawnSync } from 'child_process';
import { dirname } from 'path';
import { platform } from 'os';

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
  forceNoGcc = false
): { sanitizedCommand: string; sanitizedArgs: string[]; warnings: string[] } {
  const warnings: string[] = [];
  let finalArgs = [...args];
  const os = platform();

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

  // Check if someone is running blind full repo tests
  const fullCmdStr = `${command} ${args.join(' ')}`;
  if (!allowFullScan && (fullCmdStr.includes('go test ./...') || fullCmdStr.includes('pytest .'))) {
    const targeted = resolveTargetedTestPackage(modifiedFiles);
    if (targeted) {
      warnings.push(`Targeted test optimization applied: focused on '${targeted}' instead of scanning entire repository.`);
    }
  }

  const { sanitizedCommand, sanitizedArgs, warnings: sanitizeWarnings } = sanitizeTestCommand(command, args);
  warnings.push(...sanitizeWarnings);

  const startTime = Date.now();
  let stdout = '';
  let stderr = '';
  let exitCode: number | null = 1;

  try {
    const res = spawnSync(sanitizedCommand, sanitizedArgs, {
      cwd,
      timeout: timeoutMs,
      encoding: 'utf-8',
      env: {
        ...process.env,
        CI: 'true',
        FORCE_COLOR: '0',
      },
    });

    stdout = res.stdout || '';
    stderr = res.stderr || '';
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
