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
  let scorePenalty = 0;
  let scope: FeasibilityAssessment['scope'] = 'small_code_change';

  if (text.includes('documentation') || text.includes('readme') || text.includes('typo') || text.includes('docs')) {
    scope = 'docs_only';
  } else if (text.includes('leak') || text.includes('oom') || text.includes('memory') || text.includes('performance') || text.includes('benchmark')) {
    scope = 'performance';
  } else if (text.includes('crash') || text.includes('panic') || text.includes('typeerror') || text.includes('unhandled')) {
    scope = 'runtime_bug';
  } else if (text.includes('refactor') || text.includes('architecture') || text.includes('redesign')) {
    scope = 'complex_refactor';
  } else if (text.includes('hardware') || text.includes('gpu') || text.includes('cuda') || text.includes('bluetooth')) {
    scope = 'hardware_specific';
  }

  const requiresMac = text.includes('macos') || text.includes('darwin') || text.includes('m1') || text.includes('m2') || text.includes('apple silicon');
  const requiresLinux = text.includes('linux') || text.includes('cgroup') || text.includes('systemd') || text.includes('epoll');
  const requiresWindows = text.includes('windows') || text.includes('win32') || text.includes('powershell');
  const requiresDocker = text.includes('docker') || text.includes('container') || text.includes('k8s') || text.includes('kubernetes');
  const requiresBrowserE2E = text.includes('playwright') || text.includes('cypress') || text.includes('puppeteer') || text.includes('e2e');

  if (requiresMac) {
    detectedRisks.push('macos_specific');
    if (capabilities.os !== 'darwin') {
      missingCapabilities.push('macos_surface');
      scorePenalty += 30;
    }
  }

  if (requiresLinux) {
    detectedRisks.push('linux_specific');
    if (capabilities.os !== 'linux') {
      if (capabilities.hasWsl) {
        mitigations.push('linux_possible_via_wsl');
        scorePenalty += 5;
      } else {
        missingCapabilities.push('linux_surface');
        scorePenalty += 25;
      }
    }
  }

  if (requiresWindows) {
    detectedRisks.push('windows_specific');
    if (capabilities.os !== 'win32') {
      missingCapabilities.push('windows_surface');
      scorePenalty += 20;
    }
  }

  if (requiresDocker) {
    detectedRisks.push('docker_integration');
    if (!capabilities.hasDocker) {
      missingCapabilities.push('docker_runtime');
      scorePenalty += 20;
    } else {
      mitigations.push('docker_available');
    }
  }

  if (requiresBrowserE2E) {
    detectedRisks.push('browser_e2e_tests');
    scorePenalty += 5;
  }

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
