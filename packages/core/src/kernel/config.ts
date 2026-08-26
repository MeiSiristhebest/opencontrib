import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CapabilityType } from './capability.js';

function getOpenContribHome(): string {
  return process.env.OPENCONTRIB_HOME || os.homedir();
}

export interface OpenContribPolicy {
  network: 'allowed' | 'denied';
  maxRuntimeSeconds: number;
  enableHeavy: boolean;
  allowMutation: boolean;
}

/**
 * Global and tool-specific default timeouts (in milliseconds).
 * Can be overridden via process.env.OPENCONTRIB_SCAN_TIMEOUT_MS or workspace policy.
 */
export const DEFAULT_TOOL_TIMEOUTS = {
  AST_GREP: 20_000,
  SEMGREP: 60_000,
  KNIP: 60_000,
  RUFF: 20_000,
  CARGO_DENY: 30_000,
  ESLINT_SECURITY: 30_000,
  VARIANT_HUNT: 20_000,
  BINARY_CHECK: 3_000,
  GIT_DISCOVERY: 5_000,
} as const;

export function getToolTimeout(tool: keyof typeof DEFAULT_TOOL_TIMEOUTS, defaultFallback = 30_000): number {
  if (process.env.OPENCONTRIB_SCAN_TIMEOUT_MS) {
    const parsed = parseInt(process.env.OPENCONTRIB_SCAN_TIMEOUT_MS, 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_TOOL_TIMEOUTS[tool] ?? defaultFallback;
}

export interface OpenContribConfig {
  version: string;
  enabledCapabilities: CapabilityType[];
  policy: OpenContribPolicy;
  toolchains: Record<string, string>;
  customRules?: string[];
}

export const DEFAULT_CONFIG: OpenContribConfig = {
  version: '1.0',
  enabledCapabilities: [
    'security.static-analysis',
    'bug.reproduction',
    'forensics.git-hotspot',
    'testing.property-fuzz',
    'ci.workflow-lint',
    'concurrency.leak-detection',
    'architecture.dead-code',
  ],
  policy: {
    network: 'denied',
    maxRuntimeSeconds: 300,
    enableHeavy: false,
    allowMutation: true,
  },
  toolchains: {
    astGrepBin: 'ast-grep',
    semgrepBin: 'semgrep',
    knipBin: 'knip',
    goleakBin: 'go',
  },
};

/**
 * Loads project-level or user-level OpenContrib configuration.
 * Resolution priority:
 * 1. <workspace>/.opencontrib.yaml or .opencontrib.json
 * 2. <workspace>/.opencontrib/config.json
 * 3. ~/.opencontrib/config.json
 * 4. DEFAULT_CONFIG
 */
export function loadWorkspaceConfig(workspacePath: string = process.cwd()): OpenContribConfig {
  const candidates = [
    path.join(workspacePath, '.opencontrib.json'),
    path.join(workspacePath, '.opencontrib', 'config.json'),
    path.join(getOpenContribHome(), '.opencontrib', 'config.json'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      try {
        const raw = fs.readFileSync(candidate, 'utf8');
        const parsed = JSON.parse(raw);
        return {
          version: parsed.version || DEFAULT_CONFIG.version,
          enabledCapabilities: parsed.enabledCapabilities || DEFAULT_CONFIG.enabledCapabilities,
          policy: {
            ...DEFAULT_CONFIG.policy,
            ...(parsed.policy || {}),
          },
          toolchains: {
            ...DEFAULT_CONFIG.toolchains,
            ...(parsed.toolchains || {}),
          },
          customRules: parsed.customRules || [],
        };
      } catch {
        // Fallback to next candidate on parse failure
      }
    }
  }

  return { ...DEFAULT_CONFIG };
}

/**
 * Writes an initial configuration template to the workspace root.
 */
export function initWorkspaceConfig(workspacePath: string = process.cwd()): string {
  const targetPath = path.join(workspacePath, '.opencontrib.json');
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
  }
  return targetPath;
}
