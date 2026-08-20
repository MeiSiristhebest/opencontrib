import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { CapabilityType } from './capability.js';

export interface OpenContribPolicy {
  network: 'allowed' | 'denied';
  maxRuntimeSeconds: number;
  enableHeavy: boolean;
  allowMutation: boolean;
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
    path.join(os.homedir(), '.opencontrib', 'config.json'),
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
