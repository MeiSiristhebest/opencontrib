import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { discoverDocker } from './docker-discovery.js';
import { isBinaryOnPath } from '../kernel/tool-registry.js';
import { defaultPluginManager } from '../kernel/plugin-manager.js';

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
    dockerMethod?: string;
    wslAvailable: boolean;
  };
}

function run(cmd: string, args: string[], timeoutMs: number): string {
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'ignore'] });
  return (result.stdout || '').trim();
}

export function runDoctorAudit(): DoctorReport {
  const checks: DoctorCheckResult[] = [];
  const currentOs = platform();
  const isWindows = currentOs === 'win32';
  const pm = defaultPluginManager;

  // 1. Check Git
  let gitVersion: string | undefined;
  let gitCmd = 'git';

  if (isWindows) {
    const candidatePaths = [
      'git', 'git.exe',
      'C:\\Program Files\\Git\\cmd\\git.exe',
      'C:\\Program Files\\Git\\bin\\git.exe',
      'C:\\Program Files (x86)\\Git\\cmd\\git.exe',
      join(homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
    ];
    for (const p of candidatePaths) {
      try {
        const out = run('cmd.exe', ['/c', `"${p}" --version`], 3000);
        if (out) {
          gitCmd = p;
          gitVersion = out;
          break;
        }
      } catch {}
    }
  } else {
    try {
      const out = run('git', ['--version'], 3000);
      if (out) gitVersion = out;
    } catch {}
  }

  checks.push({
    category: 'VCS',
    name: 'Git Binary',
    status: gitVersion ? 'PASSED' : 'FAILED',
    message: gitVersion ? `Git is installed: ${gitVersion}` : 'Git is not installed or not in PATH',
  });

  // 2. Check Git User Identity
  try {
    const userName = run(gitCmd, ['config', 'user.name'], 3000);
    const userEmail = run(gitCmd, ['config', 'user.email'], 3000);
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
    const bunOut = run('bun', ['--version'], 5000);
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

  // 4. Check Containers (Docker) — six-layer discovery
  let dockerAvailable = false;
  let dockerMethod = '';
  try {
    const dockerResult = discoverDocker();
    dockerAvailable = dockerResult.found;
    dockerMethod = dockerResult.method || '';
    checks.push({
      category: 'Sandbox',
      name: 'Docker Engine',
      status: dockerAvailable ? 'PASSED' : 'WARNING',
      message: dockerAvailable
        ? `Docker available via ${dockerMethod}`
        : `Docker not found. Alternatives: ${(dockerResult.alternatives || ['Native Git Worktree sandbox']).join('; ')}`,
    });
  } catch {
    checks.push({
      category: 'Sandbox',
      name: 'Docker Engine',
      status: 'WARNING',
      message: 'Docker discovery failed; running under native Git Worktree sandbox',
    });
  }

  // 5. Check WSL (if Windows)
  let wslAvailable = false;
  if (isWindows) {
    try {
      run('wsl', ['--status'], 4000);
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

  // 6. Check Static Analysis & Multi-Language Toolchains (with PluginManager state)
  const toolchains = [
    { name: 'GitHub CLI (gh)', bin: 'gh', id: 'git' },
    { name: 'ast-grep (sg)', bin: 'ast-grep', id: 'ast-grep' },
    { name: 'Knip Dead Code Analyzer', bin: 'knip', id: 'knip' },
    { name: 'Semgrep SAST Scanner', bin: 'semgrep', id: 'semgrep' },
    { name: 'Ruff Python Linter', bin: 'ruff', id: 'ruff' },
    { name: 'Go Compiler Toolchain', bin: 'go', id: 'go' },
    { name: 'Rust Compiler Toolchain', bin: 'rustc', id: 'cargo-deny' },
    { name: 'Python / UV Toolchain', bin: 'uv', id: 'uv' },
    { name: 'Java JDK / Maven Toolchain', bin: 'javac', id: 'java' },
    { name: 'C/C++ CMake Toolchain', bin: 'cmake', id: 'cmake' },
    { name: '.NET / C# SDK', bin: 'dotnet', id: 'dotnet' },
    { name: 'PHP / Composer Toolchain', bin: 'php', id: 'php' },
    { name: 'Ruby Toolchain', bin: 'ruby', id: 'ruby' },
    { name: 'Alibaba OpenCodeReview (ocr)', bin: 'ocr', id: 'ocr' },
  ];

  for (const tc of toolchains) {
    const state = pm.getState(tc.id);
    const binaryAvailable = isBinaryOnPath(tc.bin);

    if (!state.enabled) {
      checks.push({
        category: 'Tool',
        name: tc.name,
        status: 'WARNING',
        message: `${tc.name} is disabled (reason: ${state.disabledReason || 'user-disabled'})`,
      });
      continue;
    }

    checks.push({
      category: 'Tool',
      name: tc.name,
      status: binaryAvailable ? 'PASSED' : 'WARNING',
      message: binaryAvailable
        ? `${tc.name} is available (enabled)`
        : `${tc.name} not found in PATH (Optional analyzer capability)`,
    });
  }

  // 7. Plugin Manager state summary
  const allStates = pm.getAllStates();
  const disabledPlugins = Object.entries(allStates).filter(([, s]) => !s.enabled);
  if (disabledPlugins.length > 0) {
    const disabledList = disabledPlugins.map(([id, s]) => `${id} (${s.disabledReason || 'user'})`).join(', ');
    checks.push({
      category: 'Plugins',
      name: 'Disabled Plugins',
      status: 'WARNING',
      message: `${disabledPlugins.length} plugin(s) disabled: ${disabledList}`,
    });
  } else {
    checks.push({
      category: 'Plugins',
      name: 'Plugin Manager',
      status: 'PASSED',
      message: `All ${allStates.length} plugins enabled (state: ${pm.getStatePath()})`,
    });
  }

  // 8. Check Local OpenContrib Storage Directories
  const opencontribDir = join(homedir(), '.opencontrib');
  const workspacesDir = join(opencontribDir, 'workspaces');
  checks.push({
    category: 'Storage',
    name: 'OpenContrib Ledger & Sandboxes',
    status: existsSync(opencontribDir) ? 'PASSED' : 'WARNING',
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
      dockerMethod,
      wslAvailable,
    },
  };
}
