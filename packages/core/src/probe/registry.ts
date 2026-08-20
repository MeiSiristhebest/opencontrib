import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProbeManifest } from './types.js';

export const BUILTIN_PROBES: ProbeManifest[] = [
  {
    name: 'semgrep',
    version: '1.0.0',
    description: 'Lightweight semantic SAST for SQLi, path traversal, ReDoS, crypto flaws and OWASP Top 10',
    category: 'security_cwe',
    author: 'Semgrep / OpenContrib',
    activation: {
      languages: ['*'],
      requiresBinaries: ['semgrep'],
    },
    execution: {
      cost: 'medium',
      stage: 'scout',
      command: 'semgrep scan --json --quiet {target}',
      timeoutMs: 30000,
      transformer: 'semgrep',
    },
  },
  {
    name: 'ast-grep',
    version: '1.0.0',
    description: 'Ultra-fast Tree-sitter AST structural search for dangerous patterns and API misuse',
    category: 'protocol_drift',
    author: 'ast-grep / OpenContrib',
    activation: {
      languages: ['typescript', 'javascript', 'go', 'rust', 'python', 'c', 'cpp', 'java'],
      requiresBinaries: ['ast-grep', 'sg'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'ast-grep scan --json {target}',
      timeoutMs: 15000,
      transformer: 'ast-grep',
    },
  },
  {
    name: 'ocr',
    version: '1.0.0',
    description: 'Alibaba OpenCodeReview hybrid rule matcher for NPE, thread safety, and concurrency traps',
    category: 'lifecycle_leak',
    author: 'Alibaba / OpenContrib',
    activation: {
      languages: ['java', 'go', 'typescript', 'javascript', 'python', 'c', 'cpp'],
      requiresBinaries: ['ocr'],
    },
    execution: {
      cost: 'medium',
      stage: 'scout',
      command: 'ocr scan --path {target} --json',
      timeoutMs: 30000,
      transformer: 'ocr',
    },
  },
  {
    name: 'osv-scanner',
    version: '1.0.0',
    description: 'Google OSV open-source vulnerability and CVE advisory auditor for package manifests',
    category: 'security_cwe',
    author: 'Google / OpenContrib',
    activation: {
      languages: ['*'],
      manifestFiles: ['package.json', 'go.mod', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'pom.xml'],
      requiresBinaries: ['osv-scanner'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'osv-scanner --json -r {target}',
      timeoutMs: 20000,
      transformer: 'osv-scanner',
    },
  },
  {
    name: 'nilaway',
    version: '1.0.0',
    description: 'Uber Go static analyzer for cross-procedural nil pointer dereference panics',
    category: 'lifecycle_leak',
    author: 'Uber / OpenContrib',
    activation: {
      languages: ['go'],
      manifestFiles: ['go.mod'],
      requiresBinaries: ['nilaway'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'nilaway -json ./...',
      timeoutMs: 25000,
      transformer: 'nilaway',
    },
  },
  {
    name: 'goleak',
    version: '1.0.0',
    description: 'Uber Go goroutine leak detector and unclosed watcher identifier',
    category: 'lifecycle_leak',
    author: 'Uber / OpenContrib',
    activation: {
      languages: ['go'],
      manifestFiles: ['go.mod'],
      requiresBinaries: ['go'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'go vet -vettool=... {target}',
      timeoutMs: 20000,
      transformer: 'go-vet',
    },
  },
  {
    name: 'cargo-geiger',
    version: '1.0.0',
    description: 'Rust unsafe code auditor and FFI pointer boundary tracker',
    category: 'memory_abi',
    author: 'RustSec / OpenContrib',
    activation: {
      languages: ['rust'],
      manifestFiles: ['Cargo.toml'],
      requiresBinaries: ['cargo-geiger', 'cargo'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'cargo geiger --output-format json',
      timeoutMs: 25000,
      transformer: 'cargo-geiger',
    },
  },
  {
    name: 'knip',
    version: '1.0.0',
    description: 'TypeScript/JavaScript dead code, unused exports, and type leak scanner',
    category: 'dead_code',
    author: 'Knip / OpenContrib',
    activation: {
      languages: ['typescript', 'javascript'],
      manifestFiles: ['package.json'],
      requiresBinaries: ['knip', 'npx'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'npx knip --reporter json',
      timeoutMs: 25000,
      transformer: 'knip',
    },
  },
  {
    name: 'ruff',
    version: '1.0.0',
    description: 'Python AST bugbear, async traps, and mutable default parameter scanner',
    category: 'protocol_drift',
    author: 'Astral / OpenContrib',
    activation: {
      languages: ['python'],
      manifestFiles: ['pyproject.toml', 'requirements.txt'],
      requiresBinaries: ['ruff'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'ruff check --select B,ASYNC,RUF --output-format json {target}',
      timeoutMs: 15000,
      transformer: 'ruff',
    },
  },
  {
    name: 'workflow-linter',
    version: '1.0.0',
    description: 'GitHub Actions CI workflow modernization and security probe',
    category: 'ci_workflow',
    author: 'OpenContrib',
    activation: {
      languages: ['*'],
      manifestFiles: ['.github/workflows'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      timeoutMs: 5000,
      transformer: 'builtin:workflow',
    },
  },
];

export class ProbeRegistry {
  private pluginsDir: string;
  private memoryProbes: Map<string, ProbeManifest> = new Map();

  constructor(customPluginsDir?: string) {
    this.pluginsDir = customPluginsDir || path.join(os.homedir(), '.opencontrib', 'plugins');
    // Load built-in probes
    for (const probe of BUILTIN_PROBES) {
      this.memoryProbes.set(probe.name, probe);
    }
    this.loadCustomPlugins();
  }

  public get(name: string): ProbeManifest | undefined {
    return this.memoryProbes.get(name);
  }

  public listAll(): ProbeManifest[] {
    return Array.from(this.memoryProbes.values());
  }

  public register(manifest: ProbeManifest): void {
    this.validateManifest(manifest);
    this.memoryProbes.set(manifest.name, manifest);
  }

  public unregister(name: string): boolean {
    if (BUILTIN_PROBES.some((p) => p.name === name)) {
      return false; // Cannot delete built-in probes
    }
    const existed = this.memoryProbes.delete(name);
    const diskPath = path.join(this.pluginsDir, `${name}.json`);
    if (fs.existsSync(diskPath)) {
      fs.unlinkSync(diskPath);
    }
    return existed;
  }

  public saveToDisk(manifest: ProbeManifest): void {
    this.validateManifest(manifest);
    if (!fs.existsSync(this.pluginsDir)) {
      fs.mkdirSync(this.pluginsDir, { recursive: true });
    }
    const diskPath = path.join(this.pluginsDir, `${manifest.name}.json`);
    fs.writeFileSync(diskPath, JSON.stringify(manifest, null, 2), 'utf8');
    this.memoryProbes.set(manifest.name, manifest);
  }

  private loadCustomPlugins(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      return;
    }
    try {
      const files = fs.readdirSync(this.pluginsDir);
      for (const file of files) {
        if (file.endsWith('.json')) {
          const filePath = path.join(this.pluginsDir, file);
          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const manifest: ProbeManifest = JSON.parse(content);
            this.validateManifest(manifest);
            this.memoryProbes.set(manifest.name, manifest);
          } catch {
            // Ignore invalid plugin files
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  private validateManifest(manifest: ProbeManifest): void {
    if (!manifest.name || typeof manifest.name !== 'string') {
      throw new Error('Probe manifest requires a valid string "name"');
    }
    if (!manifest.activation || !Array.isArray(manifest.activation.languages)) {
      throw new Error(`Probe manifest "${manifest.name}" requires activation.languages array`);
    }
    if (!manifest.execution || !manifest.execution.cost) {
      throw new Error(`Probe manifest "${manifest.name}" requires execution.cost`);
    }
  }
}
