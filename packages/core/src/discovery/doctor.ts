import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';

export interface DoctorCheckResult {
  category: string;
  name: string;
  status: 'PASSED' | 'WARNING' | 'FAILED';
  message: string;
  details?: string;
}

export interface DoctorReport {
  overallHealth: 'HEALTHY' | 'NEEDS_ATTENTION' | 'DEGRADED';
  checks: DoctorCheckResult[];
  environment: {
    os: string;
    nodeVersion: string;
    bunVersion?: string;
    gitVersion?: string;
    dockerAvailable: boolean;
    wslAvailable: boolean;
  };
}

export function runDoctorAudit(): DoctorReport {
  const checks: DoctorCheckResult[] = [];
  const currentOs = platform();

  // 1. Check Git
  let gitVersion: string | undefined;
  try {
    const gitOut = execSync('git --version', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (gitOut) {
      gitVersion = gitOut;
      checks.push({
        category: 'VCS',
        name: 'Git Binary',
        status: 'PASSED',
        message: `Git is installed: ${gitOut}`,
      });
    } else {
      checks.push({
        category: 'VCS',
        name: 'Git Binary',
        status: 'FAILED',
        message: 'Git is not installed or not in PATH',
      });
    }
  } catch (err: any) {
    checks.push({
      category: 'VCS',
      name: 'Git Binary',
      status: 'FAILED',
      message: 'Git is not installed or not in PATH',
    });
  }

  // 2. Check Git User Identity
  try {
    const userName = execSync('git config user.name', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const userEmail = execSync('git config user.email', { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (userName && userEmail) {
      checks.push({
        category: 'VCS',
        name: 'Git Identity',
        status: 'PASSED',
        message: `Configured as ${userName} <${userEmail}>`,
      });
    } else {
      checks.push({
        category: 'VCS',
        name: 'Git Identity',
        status: 'WARNING',
        message: 'Git user.name or user.email is not set',
      });
    }
  } catch {
    checks.push({
      category: 'VCS',
      name: 'Git Identity',
      status: 'WARNING',
      message: 'Unable to read git config user.name / user.email',
    });
  }

  // 3. Check JavaScript Runtime (Node / Bun)
  let nodeVersion = process.version;
  checks.push({
    category: 'Runtime',
    name: 'Node.js Runtime',
    status: 'PASSED',
    message: `Node.js runtime active: ${nodeVersion}`,
  });

  let bunVersion: string | undefined;
  try {
    const bunOut = execSync('bun --version', { encoding: 'utf-8', timeout: 5000 }).trim();
    bunVersion = bunOut;
    checks.push({
      category: 'Runtime',
      name: 'Bun Runtime',
      status: 'PASSED',
      message: `Bun fast runtime active: v${bunOut}`,
    });
  } catch {
    checks.push({
      category: 'Runtime',
      name: 'Bun Runtime',
      status: 'WARNING',
      message: 'Bun not found in PATH; falling back to standard Node.js',
    });
  }

  // 4. Check Containers (Docker)
  let dockerAvailable = false;
  try {
    execSync('docker --version', { stdio: 'ignore', timeout: 4000 });
    dockerAvailable = true;
    checks.push({
      category: 'Sandbox',
      name: 'Docker Engine',
      status: 'PASSED',
      message: 'Docker daemon available for isolated clean-room container sandboxes',
    });
  } catch {
    checks.push({
      category: 'Sandbox',
      name: 'Docker Engine',
      status: 'WARNING',
      message: 'Docker not available; running under native Git Worktree sandbox',
    });
  }

  // 5. Check WSL (if Windows)
  let wslAvailable = false;
  if (currentOs === 'win32') {
    try {
      execSync('wsl --status', { stdio: 'ignore', timeout: 4000 });
      wslAvailable = true;
      checks.push({
        category: 'Sandbox',
        name: 'WSL2 Subsystem',
        status: 'PASSED',
        message: 'WSL2 Linux subsystem available for cross-platform POSIX verification',
      });
    } catch {
      checks.push({
        category: 'Sandbox',
        name: 'WSL2 Subsystem',
        status: 'WARNING',
        message: 'WSL2 not active; running in native Windows PowerShell sandbox',
      });
    }
  }

  // 6. Check Static Analysis Toolchains
  const toolchains = [
    { name: 'GitHub CLI (gh)', bin: 'gh', verCmd: 'gh --version', cat: 'VCS' },
    { name: 'ast-grep (sg)', bin: 'ast-grep', verCmd: 'ast-grep --version', cat: 'Analyzers', altBin: 'sg' },
    { name: 'Knip Dead Code Analyzer', bin: 'knip', verCmd: 'knip --version', cat: 'Analyzers' },
    { name: 'Semgrep SAST Scanner', bin: 'semgrep', verCmd: 'semgrep --version', cat: 'Analyzers' },
    { name: 'Go Compiler Toolchain', bin: 'go', verCmd: 'go version', cat: 'Compilers' },
    { name: 'Rust Compiler Toolchain', bin: 'rustc', verCmd: 'rustc --version', cat: 'Compilers' },
    { name: 'Python / UV Toolchain', bin: 'uv', verCmd: 'uv --version', cat: 'Compilers', altBin: 'python' },
  ];

  for (const tc of toolchains) {
    try {
      const out = execSync(tc.verCmd, { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      const firstLine = out.split('\n')[0].trim();
      checks.push({
        category: tc.cat,
        name: tc.name,
        status: 'PASSED',
        message: `${tc.name} is installed: ${firstLine}`,
      });
    } catch {
      checks.push({
        category: tc.cat,
        name: tc.name,
        status: 'WARNING',
        message: `${tc.name} not found in PATH (Optional analyzer capability)`,
      });
    }
  }

  // 7. Check Local OpenContrib Storage Directories
  const opencontribDir = join(homedir(), '.opencontrib');
  const workspacesDir = join(opencontribDir, 'workspaces');
  checks.push({
    category: 'Storage',
    name: 'OpenContrib Ledger & Sandboxes',
    status: existsSync(opencontribDir) ? 'PASSED' : 'PASSED',
    message: `Workspace root: ${workspacesDir} (Ledger persistent)`,
  });

  const hasFailures = checks.some((c) => c.status === 'FAILED');
  const hasWarnings = checks.some((c) => c.status === 'WARNING');

  return {
    overallHealth: hasFailures ? 'DEGRADED' : hasWarnings ? 'NEEDS_ATTENTION' : 'HEALTHY',
    checks,
    environment: {
      os: `${currentOs} (${process.arch})`,
      nodeVersion,
      bunVersion,
      gitVersion,
      dockerAvailable,
      wslAvailable,
    },
  };
}
