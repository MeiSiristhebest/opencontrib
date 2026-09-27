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

const SCOPE_INFERENCE_RULES: Array<{
  scope: FeasibilityAssessment['scope'];
  pattern: RegExp;
}> = [
  { scope: 'docs_only', pattern: /\b(?:documentation|readme|typo|spelling|docs?)\b/i },
  { scope: 'performance', pattern: /\b(?:memory leak|goroutine leak|oom|high memory|cpu spike|performance regression|benchmark|latency)\b/i },
  { scope: 'runtime_bug', pattern: /\b(?:crash|panic|sigsegv|nullpointer|typeerror|unhandled exception|segmentation fault)\b/i },
  { scope: 'complex_refactor', pattern: /\b(?:architecture redesign|major refactor|rewrite|breaking change|migration)\b/i },
  { scope: 'hardware_specific', pattern: /\b(?:gpu|cuda|rocm|bluetooth|hardware|fpga|tpu)\b/i },
];

function inferScope(text: string): FeasibilityAssessment['scope'] {
  for (const rule of SCOPE_INFERENCE_RULES) {
    if (rule.pattern.test(text)) {
      return rule.scope;
    }
  }
  return 'small_code_change';
}

interface PlatformRule {
  pattern: RegExp;
  riskName: string;
  missingCap: string;
  penalty: number;
  checkApplicable: (caps: SystemCapabilities) => boolean;
  mitigation?: (caps: SystemCapabilities) => { name: string; reducedPenalty: number } | null;
}

const PLATFORM_REQUIREMENT_RULES: PlatformRule[] = [
  {
    pattern: /\b(?:macos|darwin|apple silicon|\bm[1-4]\b(?:\s+pro|\s+max|\s+ultra)?)\b/i,
    riskName: 'macos_specific',
    missingCap: 'macos_surface',
    penalty: 30,
    checkApplicable: (caps) => caps.os !== 'darwin',
  },
  {
    pattern: /\b(?:linux|cgroup|systemd|epoll)\b/i,
    riskName: 'linux_specific',
    missingCap: 'linux_surface',
    penalty: 25,
    checkApplicable: (caps) => caps.os !== 'linux',
    mitigation: (caps) => (caps.hasWsl ? { name: 'linux_possible_via_wsl', reducedPenalty: 5 } : null),
  },
  {
    pattern: /\b(?:windows|win32|powershell)\b/i,
    riskName: 'windows_specific',
    missingCap: 'windows_surface',
    penalty: 20,
    checkApplicable: (caps) => caps.os !== 'win32',
  },
  {
    pattern: /\b(?:docker|containerd|k8s|kubernetes|docker-compose)\b/i,
    riskName: 'docker_integration',
    missingCap: 'docker_runtime',
    penalty: 20,
    checkApplicable: (caps) => !caps.hasDocker,
  },
  {
    pattern: /\b(?:playwright|cypress|puppeteer|browser tests?)\b/i,
    riskName: 'browser_e2e_tests',
    missingCap: '',
    penalty: 5,
    checkApplicable: () => true,
  },
];

function evaluatePlatformRequirements(
  text: string,
  caps: SystemCapabilities,
  detectedRisks: string[],
  missingCaps: string[],
  mitigations: string[],
): number {
  let penalty = 0;

  for (const rule of PLATFORM_REQUIREMENT_RULES) {
    if (rule.pattern.test(text)) {
      detectedRisks.push(rule.riskName);

      if (rule.mitigation) {
        const mit = rule.mitigation(caps);
        if (mit) {
          mitigations.push(mit.name);
          penalty += mit.reducedPenalty;
          continue;
        }
      }

      if (rule.checkApplicable(caps)) {
        if (rule.missingCap) missingCaps.push(rule.missingCap);
        penalty += rule.penalty;
      }
    }
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
