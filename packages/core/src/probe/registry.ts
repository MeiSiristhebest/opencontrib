import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { ProbeManifest } from './types.js';

export const BUILTIN_PROBES: ProbeManifest[] = [
  // ── Dimension 1: AI-Native / Agentic Security & Review Frameworks ──
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
    name: 'piolium',
    version: '1.0.0',
    description: 'Vigolium Piolium 17-phase adversarial security audit and automated PoC constructor',
    category: 'security_cwe',
    author: 'Vigolium / OpenContrib',
    activation: {
      languages: ['*'],
      requiresBinaries: ['pi', 'piolium'],
    },
    execution: {
      cost: 'deep',
      stage: 'audit',
      command: 'pi -p "/piolium-lite {target} --fresh"',
      timeoutMs: 60000,
      transformer: 'piolium',
    },
  },
  {
    name: 'seclab',
    version: '1.0.0',
    description: 'GitHub Security Lab Taskflow multi-agent vulnerability and supply chain workflow',
    category: 'security_cwe',
    author: 'GitHub Security Lab / OpenContrib',
    activation: {
      languages: ['*'],
      manifestFiles: ['package.json', 'go.mod', 'pyproject.toml'],
      requiresBinaries: ['seclab-taskflow-agent'],
    },
    execution: {
      cost: 'deep',
      stage: 'audit',
      timeoutMs: 60000,
      transformer: 'seclab',
    },
  },
  {
    name: 'pr-agent',
    version: '1.0.0',
    description: 'Qodo PR-Agent automated regression test generator and code review assistant',
    category: 'dead_code',
    author: 'Qodo / OpenContrib',
    activation: {
      languages: ['python', 'typescript', 'javascript', 'go', 'rust', 'java'],
      requiresBinaries: ['pr-agent'],
    },
    execution: {
      cost: 'medium',
      stage: 'evidence',
      timeoutMs: 30000,
      transformer: 'pr-agent',
    },
  },

  // ── Dimension 2: High-Precision AST & Semantic Taint Analysis Engines ──
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
      command: 'semgrep scan --config auto --config p/security-audit --config p/owasp-top-ten --json --quiet {target}',
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
    name: 'codeql',
    version: '1.0.0',
    description: 'GitHub CodeQL inter-procedural relational database queries for multi-hop 0-day exploits',
    category: 'security_cwe',
    author: 'GitHub / OpenContrib',
    activation: {
      languages: ['go', 'rust', 'python', 'javascript', 'typescript', 'java', 'cpp', 'c'],
      requiresBinaries: ['codeql'],
    },
    execution: {
      cost: 'deep',
      stage: 'audit',
      timeoutMs: 90000,
      transformer: 'codeql',
    },
  },

  // ── Dimension 3: Language-Specific Deep-Water Defect Probes ──
  // Go Probes
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
      command: 'go vet -vettool=goleak {target}',
      timeoutMs: 20000,
      transformer: 'goleak',
    },
  },
  {
    name: 'bodyclose',
    version: '1.0.0',
    description: 'Go HTTP response body unclosed handle leak checker',
    category: 'lifecycle_leak',
    author: 'timakin / OpenContrib',
    activation: {
      languages: ['go'],
      manifestFiles: ['go.mod'],
      requiresBinaries: ['bodyclose'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'bodyclose ./...',
      timeoutMs: 15000,
      transformer: 'bodyclose',
    },
  },
  {
    name: 'noctx',
    version: '1.0.0',
    description: 'Go missing context.Context propagation detector in HTTP and RPC requests',
    category: 'lifecycle_leak',
    author: 'kkaijae / OpenContrib',
    activation: {
      languages: ['go'],
      manifestFiles: ['go.mod'],
      requiresBinaries: ['noctx'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'noctx ./...',
      timeoutMs: 15000,
      transformer: 'noctx',
    },
  },

  // Rust Probes
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
    name: 'miri',
    version: '1.0.0',
    description: 'Rust official Undefined Behavior (UB) and memory alignment interpreter',
    category: 'memory_abi',
    author: 'Rust Official / OpenContrib',
    activation: {
      languages: ['rust'],
      manifestFiles: ['Cargo.toml'],
      requiresBinaries: ['cargo'],
    },
    execution: {
      cost: 'medium',
      stage: 'evidence',
      command: 'cargo miri test',
      timeoutMs: 45000,
      transformer: 'miri',
    },
  },
  {
    name: 'cargo-deny',
    version: '1.0.0',
    description: 'Rust dependency crate security advisory and license compliance checker',
    category: 'security_cwe',
    author: 'Embark / OpenContrib',
    activation: {
      languages: ['rust'],
      manifestFiles: ['Cargo.toml'],
      requiresBinaries: ['cargo-deny'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'cargo deny check advisories --format json',
      timeoutMs: 20000,
      transformer: 'cargo-deny',
    },
  },

  // Python Probes
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
    name: 'pyright',
    version: '1.0.0',
    description: 'Microsoft Pyright strict type contract verification and interface drift auditor',
    category: 'protocol_drift',
    author: 'Microsoft / OpenContrib',
    activation: {
      languages: ['python'],
      manifestFiles: ['pyproject.toml', 'setup.py'],
      requiresBinaries: ['pyright'],
    },
    execution: {
      cost: 'medium',
      stage: 'scout',
      command: 'pyright --outputjson {target}',
      timeoutMs: 25000,
      transformer: 'pyright',
    },
  },

  // TypeScript / JavaScript Probes
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
    name: 'eslint-security',
    version: '1.0.0',
    description: 'Node.js security ruleset for child process injection, path traversal, and ReDoS',
    category: 'security_cwe',
    author: 'Node Security / OpenContrib',
    activation: {
      languages: ['typescript', 'javascript'],
      manifestFiles: ['package.json'],
      requiresBinaries: ['npx', 'eslint'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      command: 'npx eslint --format json {target}',
      timeoutMs: 25000,
      transformer: 'eslint-security',
    },
  },

  // ── Dimension 4: Property-Based & Differential Fuzzing ──
  {
    name: 'property-fuzz',
    version: '1.0.0',
    description: 'Built-in property-based fuzz generator for extreme floats (NaN/Inf), CRLF, and boundary attacks',
    category: 'numerical_bounds',
    author: 'OpenContrib',
    activation: {
      languages: ['*'],
    },
    execution: {
      cost: 'fast',
      stage: 'evidence',
      timeoutMs: 5000,
      transformer: 'builtin:fuzz',
    },
  },

  // ── Dimension 5: Git Hotspot & Churn Forensics (Code as a Crime Scene) ──
  {
    name: 'git-hotspot',
    version: '1.0.0',
    description: 'Code as a Crime Scene Git churn and cyclomatic complexity hotspot analyzer',
    category: 'lifecycle_leak',
    author: 'OpenContrib',
    activation: {
      languages: ['*'],
    },
    execution: {
      cost: 'fast',
      stage: 'scout',
      timeoutMs: 5000,
      transformer: 'builtin:hotspot',
    },
  },

  // ── Dimension 6: Supply Chain & Workflow Modernization ──
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
      return false;
    }
    const existed = this.memoryProbes.delete(name);
    const sanitizedName = this.sanitizePluginName(name);
    if (!sanitizedName) {
      return existed;
    }
    const diskPath = path.join(this.pluginsDir, `${sanitizedName}.json`);
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
    const sanitizedName = this.sanitizePluginName(manifest.name);
    if (!sanitizedName) {
      throw new Error(`Invalid probe name: ${manifest.name}`);
    }
    const diskPath = path.join(this.pluginsDir, `${sanitizedName}.json`);
    fs.writeFileSync(diskPath, JSON.stringify(manifest, null, 2), 'utf8');
    this.memoryProbes.set(manifest.name, manifest);
  }

  private sanitizePluginName(name: string): string | null {
    const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_');
    if (!sanitized || sanitized === '_' || sanitized.length > 64) {
      return null;
    }
    return sanitized;
  }

  private loadCustomPlugins(): void {
    if (!fs.existsSync(this.pluginsDir)) {
      return;
    }
    try {
      const files = fs.readdirSync(this.pluginsDir);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        const filePath = path.join(this.pluginsDir, file);
        try {
          const stat = fs.lstatSync(filePath);
          if (stat.isSymbolicLink()) continue;
          const content = fs.readFileSync(filePath, 'utf8');
          const manifest: ProbeManifest = JSON.parse(content);
          this.validateManifest(manifest);
          this.memoryProbes.set(manifest.name, manifest);
        } catch {
          // Ignore invalid plugin files
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
