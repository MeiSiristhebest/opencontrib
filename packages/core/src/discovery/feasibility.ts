import { spawnSync } from 'child_process';
import { platform } from 'os';
import type { FeasibilityAssessment, FeasibilityLevel } from '../contracts/schemas.js';

export interface SystemCapabilities {
  os: 'win32' | 'linux' | 'darwin' | 'other';
  hasWsl: boolean;
  hasDocker: boolean;
  hasHyperV: boolean;
  toolchains: {
    node: boolean;
    bun: boolean;
    python: boolean;
    go: boolean;
    rust: boolean;
    java: boolean;
    cpp: boolean;
    dotnet: boolean;
    ruby: boolean;
    php: boolean;
  };
}

function checkCommand(bin: string, args: string[] = ['--version']): boolean {
  const result = spawnSync(bin, args, {
    encoding: 'utf-8',
    timeout: 2000,
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return result.status === 0;
}

function checkPowershellCommand(pwshCmd: string): string {
  const result = spawnSync('powershell', ['-NoProfile', '-Command', pwshCmd], {
    encoding: 'utf-8',
    timeout: 2000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return result.stdout ? result.stdout.trim() : '';
}

export function detectSystemCapabilities(): SystemCapabilities {
  const currentOs = platform() as 'win32' | 'linux' | 'darwin' | 'other';

  let hasWsl = false;
  let hasDocker = false;
  let hasHyperV = false;

  if (currentOs === 'win32') {
    try {
      const result = spawnSync('wsl', ['--status'], {
        encoding: 'utf-8',
        timeout: 2000,
        stdio: ['ignore', 'ignore', 'ignore'],
      });
      hasWsl = result.status === 0;
    } catch {
      hasWsl = false;
    }

    try {
      const output = checkPowershellCommand(
        '(Get-Service vmms -ErrorAction SilentlyContinue).Status',
      );
      hasHyperV = output.toLowerCase() === 'running';
    } catch {
      hasHyperV = false;
    }
  }

  try {
    const result = spawnSync('docker', ['--version'], {
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    hasDocker = result.status === 0;
  } catch {
    hasDocker = false;
  }

  return {
    os: currentOs,
    hasWsl,
    hasDocker,
    hasHyperV,
    toolchains: {
      node: checkCommand('node'),
      bun: checkCommand('bun'),
      python: checkCommand('python') || checkCommand('python3'),
      go: checkCommand('go'),
      rust: checkCommand('cargo') || checkCommand('rustc'),
      java: checkCommand('javac') || checkCommand('java'),
      cpp: checkCommand('cmake') || checkCommand('gcc') || checkCommand('clang'),
      dotnet: checkCommand('dotnet'),
      ruby: checkCommand('ruby'),
      php: checkCommand('php'),
    },
  };
}

function inferScope(text: string): FeasibilityAssessment['scope'] {
  if (text.includes('documentation') || text.includes('readme') || text.includes('typo') || text.includes('docs')) {
    return 'docs_only';
  }
  if (text.includes('leak') || text.includes('oom') || text.includes('memory') || text.includes('performance') || text.includes('benchmark')) {
    return 'performance';
  }
  if (text.includes('crash') || text.includes('panic') || text.includes('typeerror') || text.includes('unhandled')) {
    return 'runtime_bug';
  }
  if (text.includes('refactor') || text.includes('architecture') || text.includes('redesign')) {
    return 'complex_refactor';
  }
  if (text.includes('hardware') || text.includes('gpu') || text.includes('cuda') || text.includes('bluetooth')) {
    return 'hardware_specific';
  }
  return 'small_code_change';
}

function evaluatePlatformRequirements(
  text: string,
  caps: SystemCapabilities,
  detectedRisks: string[],
  missingCaps: string[],
  mitigations: string[],
): number {
  let penalty = 0;

  if (text.includes('macos') || text.includes('darwin') || text.includes('m1') || text.includes('m2') || text.includes('apple silicon')) {
    detectedRisks.push('macos_specific');
    if (caps.os !== 'darwin') {
      missingCaps.push('macos_surface');
      penalty += 30;
    }
  }

  if (text.includes('linux') || text.includes('cgroup') || text.includes('systemd') || text.includes('epoll')) {
    detectedRisks.push('linux_specific');
    if (caps.os !== 'linux') {
      if (caps.hasWsl) {
        mitigations.push('linux_possible_via_wsl');
        penalty += 5;
      } else {
        missingCaps.push('linux_surface');
        penalty += 25;
      }
    }
  }

  if (text.includes('windows') || text.includes('win32') || text.includes('powershell')) {
    detectedRisks.push('windows_specific');
    if (caps.os !== 'win32') {
      missingCaps.push('windows_surface');
      penalty += 20;
    }
  }

  if (text.includes('docker') || text.includes('container') || text.includes('k8s') || text.includes('kubernetes')) {
    detectedRisks.push('docker_integration');
    if (!caps.hasDocker) {
      missingCaps.push('docker_runtime');
      penalty += 20;
    } else {
      mitigations.push('docker_available');
    }
  }

  if (text.includes('playwright') || text.includes('cypress') || text.includes('puppeteer') || text.includes('e2e')) {
    detectedRisks.push('browser_e2e_tests');
    penalty += 5;
  }

  return penalty;
}

function evaluateLanguageToolchains(
  text: string,
  caps: SystemCapabilities,
  detectedRisks: string[],
  missingCaps: string[],
): number {
  let penalty = 0;
  const tcRules: Array<{ regex: RegExp; available: boolean; capName: string }> = [
    { regex: /golang|goroutine|channel |\b\.go\b|go\.mod/, available: caps.toolchains.go, capName: 'go_toolchain' },
    { regex: /rust|cargo |crates\.io|\b\.rs\b/, available: caps.toolchains.rust, capName: 'rust_toolchain' },
    { regex: /python|pip |pypi|pytest|\b\.py\b/, available: caps.toolchains.python, capName: 'python_toolchain' },
    { regex: /java|maven|gradle|spring|\b\.java\b/, available: caps.toolchains.java, capName: 'java_toolchain' },
    { regex: /cpp|c\+\+|gcc|clang|\b\.cpp\b|\b\.cc\b/, available: caps.toolchains.cpp, capName: 'cpp_toolchain' },
    { regex: /dotnet|csharp|nuget|\b\.cs\b/, available: caps.toolchains.dotnet, capName: 'dotnet_toolchain' },
    { regex: /node\.js|npm |typescript|bun |\b\.ts\b/, available: caps.toolchains.node || caps.toolchains.bun, capName: 'node_toolchain' },
  ];

  for (const rule of tcRules) {
    if (rule.regex.test(text) && !rule.available) {
      missingCaps.push(rule.capName);
      if (!detectedRisks.includes('toolchain_missing')) detectedRisks.push('toolchain_missing');
      penalty += 25;
    }
  }

  return penalty;
}

export function assessFeasibility(
  issueTitle: string,
  issueBody: string,
  labels: string[],
  capabilities: SystemCapabilities = detectSystemCapabilities(),
): FeasibilityAssessment {
  const text = `${issueTitle} ${issueBody} ${labels.join(' ')}`.toLowerCase();

  const detectedRisks: string[] = [];
  const missingCapabilities: string[] = [];
  const mitigations: string[] = [];

  const scope = inferScope(text);
  let scorePenalty = 0;

  scorePenalty += evaluatePlatformRequirements(text, capabilities, detectedRisks, missingCapabilities, mitigations);
  scorePenalty += evaluateLanguageToolchains(text, capabilities, detectedRisks, missingCapabilities);

  let level: FeasibilityLevel = 'fully_feasible';
  if (scorePenalty >= 30 || scope === 'hardware_specific') {
    level = 'likely_blocked';
  } else if (scorePenalty >= 15 || scope === 'complex_refactor') {
    level = 'needs_investigation';
  } else if (scorePenalty > 0) {
    level = 'likely_fixable';
  }

  let rationale = `Scope evaluated as ${scope}. `;
  if (missingCapabilities.length > 0) {
    rationale += `Missing capabilities on current machine: ${missingCapabilities.join(', ')}. `;
  }
  if (mitigations.length > 0) {
    rationale += `Mitigations available: ${mitigations.join(', ')}. `;
  }
  if (level === 'fully_feasible') {
    rationale += 'Environment and project requirements fully match local system.';
  }

  return {
    level,
    scorePenalty,
    scope,
    detectedRisks,
    missingCapabilities,
    mitigations,
    rationale,
  };
}

export function calculateOsFeasibility(
  env: { os: string; hasDocker?: boolean; hasWsl?: boolean },
  labels: string[] = [],
  text: string = '',
): { feasibilityScore: number; isFeasible: boolean; penalty: number; reason?: string } {
  const currentOs = (
    env.os === 'windows' || env.os === 'win32'
      ? 'win32'
      : env.os === 'macos' || env.os === 'darwin'
        ? 'darwin'
        : env.os === 'linux'
          ? 'linux'
          : 'other'
  ) as 'win32' | 'linux' | 'darwin' | 'other';

  const caps: SystemCapabilities = {
    os: currentOs,
    hasWsl: env.hasWsl ?? false,
    hasDocker: env.hasDocker ?? false,
    hasHyperV: false,
    toolchains: {
      node: true,
      bun: true,
      python: true,
      go: true,
      rust: true,
      java: true,
      cpp: true,
      dotnet: true,
      ruby: true,
      php: true,
    },
  };

  const assessment = assessFeasibility(text, '', labels, caps);
  const score = Math.max(0, 100 - assessment.scorePenalty);
  return {
    feasibilityScore: score,
    isFeasible: assessment.level !== 'hard_blocked' && assessment.level !== 'likely_blocked',
    penalty: assessment.scorePenalty,
    reason: assessment.rationale,
  };
}
