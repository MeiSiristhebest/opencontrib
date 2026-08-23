/**
 * TOOL_REGISTRY — Centralized tool metadata for 12+ analyzers.
 *
 * Each tool defines:
 *  - bin: binary name on PATH
 *  - probeIds: which probes consume this tool
 *  - install: per-platform install commands (win32, darwin, linux)
 *  - installNote: human-readable note if binary comes from a proprietary source
 *  - docsUrl: vendor documentation
 *
 * This registry is the single source of truth for:
 *  - `opencontrib setup` — lists missing tools and installs them
 *  - Doctor — checks tool availability per-platform
 *  - PluginManager — tracks which tools each plugin depends on
 */

import { platform } from 'os';

/** Credential keys stripped from binary-detection subprocesses. */
const TOOL_REGISTRY_CREDENTIAL_KEYS = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'GCP_SERVICE_ACCOUNT_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'SLACK_TOKEN', 'DOCKER_TOKEN', 'DOCKER_PASSWORD',
  'PRIVATE_KEY', 'SSH_AUTH_SOCK',
]);

function buildToolRegistryEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!TOOL_REGISTRY_CREDENTIAL_KEYS.has(key)) env[key] = value;
  }
  return env;
}
const TOOL_REGISTRY_ENV = buildToolRegistryEnv();

export interface ToolInstallStep {
  cmd: string;
  desc: string;
}

export interface ToolRegistryEntry {
  id: string;
  name: string;
  bin: string[];
  probeIds: string[];
  install: {
    win32: ToolInstallStep[];
    darwin: ToolInstallStep[];
    linux: ToolInstallStep[];
  };
  installNote?: string;
  docsUrl?: string;
  packageManager?: 'npm' | 'cargo' | 'pip' | 'uv' | 'brew' | 'standalone';
}

export const TOOL_REGISTRY: ToolRegistryEntry[] = [
  {
    id: 'ast-grep',
    name: 'ast-grep Structural Search',
    bin: ['ast-grep', 'sg'],
    probeIds: ['ast-grep', 'eslint-security'],
    install: {
      win32: [{ cmd: 'npm install -g ast-grep', desc: 'Install ast-grep globally via npm' }],
      darwin: [{ cmd: 'npm install -g ast-grep', desc: 'Install ast-grep globally via npm' }],
      linux: [{ cmd: 'npm install -g ast-grep', desc: 'Install ast-grep globally via npm' }],
    },
    packageManager: 'npm',
    docsUrl: 'https://ast-grep.github.io',
  },
  {
    id: 'semgrep',
    name: 'Semgrep SAST',
    bin: ['semgrep'],
    probeIds: ['semgrep'],
    install: {
      win32: [{ cmd: 'pip install semgrep', desc: 'Install semgrep via pip' }],
      darwin: [{ cmd: 'pip install semgrep', desc: 'Install semgrep via pip' }],
      linux: [{ cmd: 'pip install semgrep', desc: 'Install semgrep via pip' }],
    },
    packageManager: 'pip',
    docsUrl: 'https://semgrep.dev',
  },
  {
    id: 'ruff',
    name: 'Ruff Python Linter',
    bin: ['ruff'],
    probeIds: ['ruff'],
    install: {
      win32: [{ cmd: 'pip install ruff', desc: 'Install ruff via pip' }],
      darwin: [
        { cmd: 'pip install ruff', desc: 'Install ruff via pip' },
        { cmd: 'brew install ruff', desc: 'Install ruff via Homebrew' },
      ],
      linux: [{ cmd: 'pip install ruff', desc: 'Install ruff via pip' }],
    },
    packageManager: 'pip',
    docsUrl: 'https://docs.astral.sh/ruff',
  },
  {
    id: 'knip',
    name: 'Knip Dead Code Detector',
    bin: ['knip'],
    probeIds: ['knip'],
    install: {
      win32: [{ cmd: 'npm install -g knip', desc: 'Install knip globally via npm' }],
      darwin: [{ cmd: 'npm install -g knip', desc: 'Install knip globally via npm' }],
      linux: [{ cmd: 'npm install -g knip', desc: 'Install knip globally via npm' }],
    },
    packageManager: 'npm',
    docsUrl: 'https://knip.dev',
  },
  {
    id: 'cargo-deny',
    name: 'Cargo Deny (Rust Supply Chain)',
    bin: ['cargo-deny', 'cargo'],
    probeIds: ['cargo-deny'],
    install: {
      win32: [{ cmd: 'cargo install cargo-deny', desc: 'Install cargo-deny via cargo' }],
      darwin: [{ cmd: 'cargo install cargo-deny', desc: 'Install cargo-deny via cargo' }],
      linux: [{ cmd: 'cargo install cargo-deny', desc: 'Install cargo-deny via cargo' }],
    },
    packageManager: 'cargo',
    docsUrl: 'https://github.com/EmbarkStudios/cargo-deny',
  },
  {
    id: 'cargo-geiger',
    name: 'Cargo Geiger (Rust Unsafe Auditor)',
    bin: ['cargo-geiger', 'cargo'],
    probeIds: ['cargo-geiger'],
    install: {
      win32: [{ cmd: 'cargo install cargo-geiger', desc: 'Install cargo-geiger via cargo' }],
      darwin: [{ cmd: 'cargo install cargo-geiger', desc: 'Install cargo-geiger via cargo' }],
      linux: [{ cmd: 'cargo install cargo-geiger', desc: 'Install cargo-geiger via cargo' }],
    },
    packageManager: 'cargo',
    docsUrl: 'https://github.com/geiger-org/cargo-geiger',
  },
  {
    id: 'go',
    name: 'Go Toolchain + vet/analyzers',
    bin: ['go'],
    probeIds: ['go-analyzers'],
    install: {
      win32: [{ cmd: 'choco install golang', desc: 'Install Go via Chocolatey' }],
      darwin: [{ cmd: 'brew install go', desc: 'Install Go via Homebrew' }],
      linux: [{ cmd: 'sudo apt-get install golang-go', desc: 'Install Go via apt' }],
    },
    packageManager: 'standalone',
    docsUrl: 'https://go.dev/doc/install',
  },
  {
    id: 'git',
    name: 'Git Version Control',
    bin: ['git'],
    probeIds: ['hotspot'],
    install: {
      win32: [{ cmd: 'choco install git', desc: 'Install Git via Chocolatey' }],
      darwin: [{ cmd: 'xcode-select --install', desc: 'Install Xcode CLT' }],
      linux: [{ cmd: 'sudo apt-get install git', desc: 'Install Git via apt' }],
    },
    packageManager: 'standalone',
    docsUrl: 'https://git-scm.com',
  },
  {
    id: 'uv',
    name: 'UV Python Package Manager',
    bin: ['uv'],
    probeIds: ['ruff'],
    install: {
      win32: [{ cmd: 'pip install uv', desc: 'Install uv via pip' }],
      darwin: [{ cmd: 'pip install uv', desc: 'Install uv via pip' }],
      linux: [{ cmd: 'pip install uv', desc: 'Install uv via pip' }],
    },
    packageManager: 'pip',
    docsUrl: 'https://docs.astral.sh/uv',
  },
  {
    id: 'pip',
    name: 'pip Python Package Manager',
    bin: ['pip', 'pip3'],
    probeIds: ['ruff', 'semgrep', 'uv'],
    install: {
      win32: [{ cmd: 'python -m ensurepip --upgrade', desc: 'Bootstrap pip' }],
      darwin: [{ cmd: 'python3 -m ensurepip --upgrade', desc: 'Bootstrap pip' }],
      linux: [{ cmd: 'sudo apt-get install python3-pip', desc: 'Install pip via apt' }],
    },
    packageManager: 'pip',
    docsUrl: 'https://pip.pypa.io',
  },
  {
    id: 'ocr',
    name: 'Alibaba OpenCodeReview',
    bin: ['ocr'],
    probeIds: ['ocr'],
    install: {
      win32: [
        { cmd: 'npm install -g @alibaba-group/open-code-review', desc: 'Install Alibaba OpenCodeReview via npm' },
      ],
      darwin: [
        { cmd: 'npm install -g @alibaba-group/open-code-review', desc: 'Install Alibaba OpenCodeReview via npm' },
      ],
      linux: [
        { cmd: 'npm install -g @alibaba-group/open-code-review', desc: 'Install Alibaba OpenCodeReview via npm' },
      ],
    },
    installNote: 'Alibaba OpenCodeReview — Apache-2.0, npm package @alibaba-group/open-code-review',
    packageManager: 'npm',
    docsUrl: 'https://github.com/alibaba-group/open-code-review',
  },
  {
    id: 'docker',
    name: 'Docker Engine',
    bin: ['docker'],
    probeIds: [],
    install: {
      win32: [
        { cmd: 'Install Docker Desktop from https://desktop.docker.com/win', desc: 'Install Docker Desktop (Windows)' },
      ],
      darwin: [
        { cmd: 'brew install --cask docker', desc: 'Install Docker Desktop via Homebrew' },
      ],
      linux: [
        { cmd: 'sudo apt-get install docker.io', desc: 'Install Docker via apt' },
      ],
    },
    installNote: 'Docker Desktop for Windows/macOS, or engine + Compose for Linux',
    packageManager: 'standalone',
    docsUrl: 'https://docs.docker.com/engine/install',
  },
];

// ─── Probe ↔ Tool bridge ───────────────────────────────────────────────────────

/**
 * Maps probe IDs to their required tool IDs.
 * Used by `opencontrib plugin install <probeId>` to determine which tools to install.
 */
export const PROBE_TOOLS_MAP: Record<string, string[]> = {};
for (const entry of TOOL_REGISTRY) {
  for (const probeId of entry.probeIds) {
    if (!PROBE_TOOLS_MAP[probeId]) PROBE_TOOLS_MAP[probeId] = [];
    PROBE_TOOLS_MAP[probeId].push(entry.id);
  }
}

// ─── Platform helpers ──────────────────────────────────────────────────────────

export function currentPlatform(): 'win32' | 'darwin' | 'linux' {
  const p = platform();
  if (p === 'win32') return 'win32';
  if (p === 'darwin') return 'darwin';
  return 'linux';
}

export function getInstallSteps(toolId: string): ToolInstallStep[] {
  const entry = TOOL_REGISTRY.find((t) => t.id === toolId);
  if (!entry) return [];
  return entry.install[currentPlatform()] || [];
}

/** Check if a single binary is available on PATH or in OPENCONTRIB_DOCKER_BIN_DIR. */
export function isBinaryOnPath(bin: string): boolean {
  const { existsSync, readdirSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');
  const { join, resolve } = require('node:path');

  // Strip credentials from subprocess env
  const strippedEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!TOOL_REGISTRY_CREDENTIAL_KEYS.has(key)) strippedEnv[key] = value;
  }

  const isWindows = currentPlatform() === 'win32';
  const cmd = isWindows ? 'where.exe' : 'command';
  const args = isWindows ? ['-q', bin] : ['-v', bin];
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000, env: strippedEnv });
  if (result.status === 0) return true;

  // Fallback: check OPENCONTRIB_DOCKER_BIN_DIR for non-standard install paths
  const customDir = process.env.OPENCONTRIB_DOCKER_BIN_DIR;
  if (customDir) {
    const fullPath = resolve(customDir, bin);
    const winPath = resolve(customDir, `${bin}.exe`);
    if (isWindows && existsSync(winPath)) return true;
    if (existsSync(fullPath)) return true;
    // Also scan the directory for any matching name
    try {
      const files = readdirSync(customDir);
      if (files.some((f: string) => f.toLowerCase() === bin.toLowerCase() || f.toLowerCase().startsWith(bin.toLowerCase()))) {
        return true;
      }
    } catch {
      // Directory not readable
    }
  }
  return false;
}

/**
 * Check multiple binaries in a single shell call for batch efficiency.
 * Windows: `where.exe a b c...` (single process, checks all binaries at once)
 * Unix:    `command -v a && command -v b ...` (single process)
 */
export function areBinariesOnPath(bins: string[]): Record<string, boolean> {
  if (bins.length === 0) return {};

  const results: Record<string, boolean> = {};
  const isWindows = currentPlatform() === 'win32';
  const { existsSync } = require('node:fs');
  const { spawnSync } = require('node:child_process');

  if (bins.length === 1) {
    results[bins[0]] = isBinaryOnPath(bins[0]);
    return results;
  }

  // Batch: single process call for all binaries
  if (isWindows) {
    const result = spawnSync('where.exe', bins, { encoding: 'utf-8', timeout: 5000, env: TOOL_REGISTRY_ENV });
    const output = result.stdout || '';
    // where.exe outputs each found binary on its own line
    const foundBinaries = new Set(output.split(/\r?\n/).map((l: string) => {
      const base = l.trim().replace(/.*[\\/]/, '');
      return base;
    }).filter(Boolean));
    for (const bin of bins) {
      const winName = bin.endsWith('.exe') ? bin : bin + '.exe';
      results[bin] = foundBinaries.has(bin) || foundBinaries.has(winName) || existsSync(bin);
    }
  } else {
    // Unix: check each binary individually without shell interpolation
    for (const [i, bin] of bins.entries()) {
      const result = spawnSync('command', ['-v', bin], { encoding: 'utf-8', timeout: 5000, env: TOOL_REGISTRY_ENV });
      results[bin] = result.status === 0;
    }
  }

  // Fill in any false negatives via individual check (handles env var fallback)
  for (const bin of bins) {
    if (!results[bin]) {
      results[bin] = isBinaryOnPath(bin);
    }
  }

  return results;
}
