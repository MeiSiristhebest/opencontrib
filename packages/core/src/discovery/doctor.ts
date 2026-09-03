import { spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir, platform } from 'os';
import { join } from 'path';
import { discoverDocker } from './docker-discovery.js';
import { isBinaryOnPath, areBinariesOnPath } from '../kernel/tool-registry.js';
import { defaultPluginManager } from '../kernel/plugin-manager.js';
import { getOpenContribHome } from '../kernel/home.js';


export interface ContingencyPlanInfo {
  activePlan: string;
  alternatives: string[];
  remediationAction?: string;
}

export interface ContingencySummaryItem {
  feature: string;
  status: 'ACTIVE_FALLBACK' | 'OPTIMAL';
  impactDescription: string;
  activePlan: string;
  alternatives: string[];
  remediationAction?: string;
}

export interface DoctorCheckResult {
  category: string;
  name: string;
  status: 'PASSED' | 'WARNING' | 'FAILED';
  message: string;
  impact?: string;
  contingencyPlan?: ContingencyPlanInfo;
  details?: string;
}

export interface DoctorReport {
  overallHealth: 'HEALTHY' | 'NEEDS_ATTENTION' | 'DEGRADED';
  checks: DoctorCheckResult[];
  contingenciesSummary: ContingencySummaryItem[];
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

let cachedDoctorReport: { report: DoctorReport; expiresAt: number } | null = null;

export function clearDoctorCache(): void {
  cachedDoctorReport = null;
}

export function runDoctorAudit(forceRefresh = false): DoctorReport {
  const now = Date.now();
  if (!forceRefresh && cachedDoctorReport && cachedDoctorReport.expiresAt > now) {
    return cachedDoctorReport.report;
  }

  const checks: DoctorCheckResult[] = [];
  const currentOs = platform();
  const isWindows = currentOs === 'win32';
  const pm = defaultPluginManager;

  // 1. Check Git
  let gitVersion: string | undefined;
  let gitCmd = 'git';

  if (isWindows) {
    if (isBinaryOnPath('git')) {
      gitCmd = 'git';
      try {
        gitVersion = run('git', ['--version'], 1500);
      } catch {}
    } else {
      const sysDrive = process.env['SystemDrive'] || 'C:';
      const programFiles = process.env['ProgramFiles'] || join(sysDrive, 'Program Files');
      const programFilesX86 = process.env['ProgramFiles(x86)'] || join(sysDrive, 'Program Files (x86)');
      const candidatePaths = [
        join(programFiles, 'Git', 'cmd', 'git.exe'),
        join(programFiles, 'Git', 'bin', 'git.exe'),
        join(programFilesX86, 'Git', 'cmd', 'git.exe'),
        join(homedir(), 'AppData', 'Local', 'Programs', 'Git', 'cmd', 'git.exe'),
      ];
      for (const p of candidatePaths) {
        if (existsSync(p)) {
          gitCmd = p;
          try {
            gitVersion = run(p, ['--version'], 1500);
            if (gitVersion) break;
          } catch {}
        }
      }
    }
  } else {
    try {
      const out = run('git', ['--version'], 1500);
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
    if (dockerAvailable) {
      checks.push({
        category: 'Sandbox',
        name: 'Docker Engine',
        status: 'PASSED',
        message: `Docker available via ${dockerMethod}`,
        impact: '已就绪：已启用 Tier-1 容器化全隔离沙箱，全套多语言分析工具在容器内开箱即用。',
      });
    } else {
      checks.push({
        category: 'Sandbox',
        name: 'Docker Engine',
        status: 'WARNING',
        message: 'Docker 守护进程未启动。',
        impact: '无法使用 Tier-1 容器化隔离沙箱；无法自动在预置镜像中免安装运行多语言分析器。',
        contingencyPlan: {
          activePlan: '预案 B：自动降级为【原生 Git Worktree 隔离沙箱】+ 探测宿主机本地 %PATH% 编译器/分析器',
          alternatives: [
            '方案 1（最佳）：启动 Docker Desktop 解锁零配置容器化全工具链',
            '方案 2：在 WSL2 内启动 Docker 守护进程',
            '方案 3（当前）：继续使用原生 Git Worktree 隔离工作区',
          ],
          remediationAction: '启动 Docker Desktop，或运行 `opencontrib workspace` 管理原生沙箱',
        },
      });
    }
  } catch {
    checks.push({
      category: 'Sandbox',
      name: 'Docker Engine',
      status: 'WARNING',
      message: 'Docker discovery failed.',
      impact: '无法使用容器沙箱。',
      contingencyPlan: {
        activePlan: '预案 B：使用原生 Git Worktree 沙箱',
        alternatives: ['启动 Docker Desktop', '使用原生工作区'],
      },
    });
  }

  // 5. Check WSL (if Windows)
  let wslAvailable = false;
  if (isWindows) {
    try {
      const out = run('wsl', ['--status'], 1000);
      wslAvailable = Boolean(out);
      checks.push({
        category: 'Sandbox',
        name: 'WSL2 Subsystem',
        status: wslAvailable ? 'PASSED' : 'WARNING',
        message: wslAvailable
          ? 'WSL2 Linux subsystem available for cross-platform POSIX verification'
          : 'WSL2 not active; running in native Windows PowerShell sandbox',
        impact: wslAvailable
          ? '已就绪：支持在 Windows 上无缝执行 Linux/POSIX 单测与命令验证。'
          : '部分专属于 Linux 的 Makefile 或 Shell 脚本无法在 Windows 原生执行。',
        contingencyPlan: wslAvailable ? undefined : {
          activePlan: '预案 B：在 Windows 原生 PowerShell 环境下运行跨平台兼容测试',
          alternatives: ['在 Windows 启用 WSL2 并安装 Ubuntu', '使用纯跨平台 Node/Bun 测试'],
          remediationAction: 'wsl --install',
        },
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
    { name: 'Rust Compiler Toolchain', bin: 'cargo', id: 'cargo-deny' },
    { name: 'Python / UV Toolchain', bin: 'uv', id: 'uv' },
    { name: 'Java JDK / Maven Toolchain', bin: 'javac', id: 'java' },
    { name: 'C/C++ CMake Toolchain', bin: 'cmake', id: 'cmake' },
    { name: '.NET / C# SDK', bin: 'dotnet', id: 'dotnet' },
    { name: 'PHP / Composer Toolchain', bin: 'php', id: 'php' },
    { name: 'Ruby Toolchain', bin: 'ruby', id: 'ruby' },
    { name: 'Alibaba OpenCodeReview (ocr)', bin: 'ocr', id: 'ocr' },
  ];

  const toolMeta: Record<string, { impact: string; activePlan: string; alternatives: string[]; remedy: string }> = {
    semgrep: {
      impact: '缺少本地全局 semgrep 二进制，无法直接本地离线扫描 CWE 污染流与 OWASP Top 10 安全缺陷。',
      activePlan: '预案 C：自动降级为【uvx semgrep 一次性免安装调度】或内置纯 TS 启发式 AST 规则。',
      alternatives: [
        '方案 1：运行 `pip install semgrep` 或 `uv pip install semgrep` 安装本地全局加速',
        '方案 2：启动 Docker 容器由预置工具链镜像提供',
        '方案 3（当前）：系统在分析时自动调用 `uvx semgrep` 进行一次性免安装即用即走扫描',
      ],
      remedy: 'uv pip install semgrep 或 pip install semgrep',
    },
    knip: {
      impact: '缺少全局独立 knip 二进制。',
      activePlan: '预案 C：自动降级为【npx knip / bun x knip 一次性免安装运行】。',
      alternatives: [
        '方案 1：运行 `npm install -g knip` 安装全局常驻加速',
        '方案 2（当前）：系统在扫描时自动调用 `npx knip` 临时加载运行',
      ],
      remedy: 'npm install -g knip',
    },
    ruff: {
      impact: '缺少本地全局 ruff 二进制，无法直接本地离线执行极速 Python Linter 检查。',
      activePlan: '预案 C：自动降级为【uvx ruff check 一次性免安装运行】。',
      alternatives: [
        '方案 1：运行 `uv pip install ruff` 或 `pip install ruff` 安装全局常驻加速',
        '方案 2（当前）：系统在扫描时自动调用 `uvx ruff` 临时加载运行',
      ],
      remedy: 'uv pip install ruff',
    },
    php: {
      impact: '缺少 PHP 编译器与 Composer，无法本地运行 PHP 项目的单测与语法诊断。',
      activePlan: '预案 A：非 PHP 仓库自动跳过；PHP 仓库使用通用跨语言语法分析。',
      alternatives: ['安装 PHP 与 Composer', '启动 Docker 容器运行 PHP 环境'],
      remedy: 'choco install php composer 或使用 Docker',
    },
    ruby: {
      impact: '缺少 Ruby 解释器，无法本地运行 Ruby 项目的单测。',
      activePlan: '预案 A：非 Ruby 仓库自动跳过；Ruby 仓库使用通用跨语言语法分析。',
      alternatives: ['安装 Ruby', '启动 Docker 容器运行 Ruby 环境'],
      remedy: 'choco install ruby 或使用 Docker',
    },
  };

  const tcBins = toolchains.map((t) => t.bin);
  const tcAvailability = areBinariesOnPath(tcBins);

  for (const tc of toolchains) {
    const state = pm.getState(tc.id);
    const binaryAvailable = tcAvailability[tc.bin] ?? false;

    if (!state.enabled) {
      checks.push({
        category: 'Tool',
        name: tc.name,
        status: 'WARNING',
        message: `${tc.name} is disabled (reason: ${state.disabledReason || 'user-disabled'})`,
        impact: `该插件已被配置显式禁用，对应能力不会触发。`,
        contingencyPlan: {
          activePlan: `预案 A：跳过 ${tc.name} 探针，使用其余已激活工具与内置启发式探针`,
          alternatives: [`运行 opencontrib plugin enable ${tc.id} 重新启用`],
          remediationAction: `opencontrib plugin enable ${tc.id}`,
        },
      });
      continue;
    }

    const meta = toolMeta[tc.id];
    const isDockerSupported = ['semgrep', 'ruff', 'knip', 'php', 'ruby', 'go', 'cargo-deny', 'java', 'cmake', 'dotnet', 'ast-grep', 'ocr'].includes(tc.id);
    const availableViaDocker = !binaryAvailable && dockerAvailable && isDockerSupported;

    if (binaryAvailable) {
      checks.push({
        category: 'Tool',
        name: tc.name,
        status: 'PASSED',
        message: `${tc.name} is available on host PATH (enabled)`,
        impact: `已就绪：本地原生二进制可用，以零启动延迟执行。`,
      });
    } else if (availableViaDocker) {
      checks.push({
        category: 'Tool',
        name: tc.name,
        status: 'PASSED',
        message: `${tc.name} is available (via Docker Container Sandbox Tier 1)`,
        impact: `已就绪：已接入 Docker 容器化沙箱，由预置环境提供该工具链。`,
      });
    } else {
      checks.push({
        category: 'Tool',
        name: tc.name,
        status: 'WARNING',
        message: `${tc.name} not found in PATH and Docker inactive (Optional analyzer capability)`,
        impact: meta?.impact || `缺少 ${tc.name} 本地全局二进制及容器环境。`,
        contingencyPlan: {
          activePlan: meta?.activePlan || `预案 C：尝试使用一次性免安装命令或内置纯 TypeScript 启发式规则扫描`,
          alternatives: meta?.alternatives || [`安装 ${tc.name} 全局二进制`, `启动 Docker Desktop`, `使用系统自动免安装降级`],
          remediationAction: meta?.remedy || `启动 Docker Desktop 或安装 ${tc.name}`,
        },
      });
    }
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
      message: `All plugins enabled (state: ${pm.getStatePath()})`,
    });
  }

  // 8. Check Local OpenContrib Storage Directories
  const opencontribDir = join(getOpenContribHome(), '.opencontrib');
  const workspacesDir = join(opencontribDir, 'workspaces');
  checks.push({
    category: 'Storage',
    name: 'OpenContrib Ledger & Sandboxes',
    status: existsSync(opencontribDir) ? 'PASSED' : 'WARNING',
    message: `Workspace root: ${workspacesDir} (Ledger persistent)`,
  });

  const hasFailures = checks.some((c) => c.status === 'FAILED');
  const hasWarnings = checks.some((c) => c.status === 'WARNING');

  const contingenciesSummary: ContingencySummaryItem[] = [];
  for (const c of checks) {
    if (c.contingencyPlan) {
      contingenciesSummary.push({
        feature: c.name,
        status: 'ACTIVE_FALLBACK',
        impactDescription: c.impact || c.message,
        activePlan: c.contingencyPlan.activePlan,
        alternatives: c.contingencyPlan.alternatives,
        remediationAction: c.contingencyPlan.remediationAction,
      });
    }
  }

  const report: DoctorReport = {
    overallHealth: hasFailures ? 'DEGRADED' : hasWarnings ? 'NEEDS_ATTENTION' : 'HEALTHY',
    checks,
    contingenciesSummary,
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

  cachedDoctorReport = {
    report,
    expiresAt: Date.now() + 15000, // 15-second TTL cache
  };

  return report;
}

