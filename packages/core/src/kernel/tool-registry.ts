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
        { cmd: 'brew install astral-sh/ruff/ruff', desc: 'Install ruff via Homebrew' },
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

/** Check if a single binary is available on PATH. */
export function isBinaryOnPath(bin: string): boolean {
  const { spawnSync } = require('node:child_process');
  const isWindows = currentPlatform() === 'win32';
  const cmd = isWindows ? 'where.exe' : 'command';
  const args = isWindows ? ['-q', bin] : ['-v', bin];
  const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000 });
  return result.status === 0;
}

/**
 * Check multiple binaries in a single shell call for batch efficiency.
 * Windows: `where.exe a b c...` (single process, checks all)
 * Unix:    `command -v a && command -v b ...` (chained)
 */
export function areBinariesOnPath(bins: string[]): Record<string, boolean> {
  if (bins.length === 0) return {};

  const results: Record<string, boolean> = {};
  const isWindows = currentPlatform() === 'win32';

  if (bins.length === 1) {
    results[bins[0]] = isBinaryOnPath(bins[0]);
    return results;
  }

  // For multiple binaries, check each individually for accurate per-binary results
  for (const bin of bins) {
    results[bin] = isBinaryOnPath(bin);
  }
  return results;
}
