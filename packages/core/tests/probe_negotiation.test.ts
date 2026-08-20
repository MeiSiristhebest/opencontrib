import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  extractRepoFingerprint,
  negotiateProbes,
  runProbes,
  ProbeRegistry,
  type ProbeManifest,
  type RepoFingerprint,
} from '../src/probe/index.js';

describe('Progressive Probe & Plugin Negotiation Engine', () => {
  let tempDir: string;
  let pluginsDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-probe-test-'));
    pluginsDir = path.join(tempDir, 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('correctly extracts repository fingerprint for a Go project', async () => {
    fs.writeFileSync(path.join(tempDir, 'go.mod'), 'module github.com/test/repo\n\ngo 1.22\n');
    fs.writeFileSync(path.join(tempDir, 'main.go'), 'package main\nfunc main() {}\n');
    fs.writeFileSync(path.join(tempDir, 'server.go'), 'package main\n');

    const fp = await extractRepoFingerprint(tempDir);
    expect(fp.primaryLanguage).toBe('Go');
    expect(fp.manifests).toContain('go.mod');
    expect(fp.languages.some((l) => l.language === 'Go')).toBe(true);
  });

  it('correctly extracts repository fingerprint for a TypeScript/React project', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: 'test-app',
        dependencies: { react: '^18.0.0' },
        devDependencies: { vitest: '^1.0.0' },
      }),
    );
    fs.writeFileSync(path.join(tempDir, 'App.tsx'), 'export const App = () => null;');
    fs.writeFileSync(path.join(tempDir, 'index.ts'), 'console.log("hello");');

    const fp = await extractRepoFingerprint(tempDir);
    expect(fp.primaryLanguage).toBe('TypeScript');
    expect(fp.manifests).toContain('package.json');
    expect(fp.frameworks).toContain('React');
    expect(fp.hasTests).toBe(true);
  });

  it('negotiates only matching language probes and filters out irrelevant ones', () => {
    const registry = new ProbeRegistry(pluginsDir);

    const goFingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'Go',
      languages: [{ language: 'Go', percentage: 100, filesCount: 10 }],
      manifests: ['go.mod'],
      frameworks: [],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 10,
    };

    const plan = negotiateProbes(goFingerprint, { checkBinaries: false }, registry);

    const selectedNames = plan.selectedProbes.map((p) => p.name);
    // Go probes and universal probes should be selected
    expect(selectedNames).toContain('nilaway');
    expect(selectedNames).toContain('goleak');
    expect(selectedNames).toContain('semgrep');

    // Rust and TS specific probes must be skipped
    expect(selectedNames).not.toContain('cargo-geiger');
    expect(selectedNames).not.toContain('knip');

    const skippedReasons = plan.skippedProbes.map((s) => ({ name: s.name, reason: s.reason }));
    expect(skippedReasons.some((s) => s.name === 'cargo-geiger' && s.reason === 'language_mismatch')).toBe(true);
  });

  it('honors --only and --skip options during negotiation', () => {
    const registry = new ProbeRegistry(pluginsDir);

    const tsFingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'TypeScript',
      languages: [{ language: 'TypeScript', percentage: 100, filesCount: 10 }],
      manifests: ['package.json'],
      frameworks: ['React'],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 10,
    };

    // Test --only
    const onlyPlan = negotiateProbes(tsFingerprint, { only: ['knip'], checkBinaries: false }, registry);
    expect(onlyPlan.selectedProbes.map((p) => p.name)).toEqual(['knip']);

    // Test --skip
    const skipPlan = negotiateProbes(tsFingerprint, { skip: ['knip'], checkBinaries: false }, registry);
    expect(skipPlan.selectedProbes.map((p) => p.name)).not.toContain('knip');
  });

  it('manages custom plugins in ProbeRegistry dynamically', () => {
    const registry = new ProbeRegistry(pluginsDir);
    const initialCount = registry.listAll().length;

    const customPlugin: ProbeManifest = {
      name: 'custom-solidity-audit',
      version: '1.0.0',
      description: 'Custom slither static audit probe for smart contracts',
      category: 'security_cwe',
      activation: {
        languages: ['solidity'],
        manifestFiles: ['foundry.toml'],
        requiresBinaries: ['slither'],
      },
      execution: {
        cost: 'medium',
        stage: 'scout',
        command: 'slither . --json',
      },
    };

    registry.saveToDisk(customPlugin);
    expect(registry.listAll().length).toBe(initialCount + 1);
    expect(registry.get('custom-solidity-audit')?.name).toBe('custom-solidity-audit');

    // Reload from disk into a new registry instance
    const freshRegistry = new ProbeRegistry(pluginsDir);
    expect(freshRegistry.get('custom-solidity-audit')?.description).toBe(
      'Custom slither static audit probe for smart contracts',
    );

    // Unregister
    const removed = freshRegistry.unregister('custom-solidity-audit');
    expect(removed).toBe(true);
    expect(freshRegistry.get('custom-solidity-audit')).toBeUndefined();
  });

  it('runs built-in workflow linter and produces normalized findings', async () => {
    const wfDir = path.join(tempDir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, 'ci.yml'),
      'name: CI\non: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v2\n      - uses: actions/setup-node@v2\n',
    );

    const fp = await extractRepoFingerprint(tempDir);
    const plan = negotiateProbes(fp, { only: ['workflow-linter'], checkBinaries: false });
    const result = await runProbes(plan);

    expect(result.findingsCount).toBe(2);
    expect(result.findings.some((f) => f.id.includes('checkout'))).toBe(true);
    expect(result.findings.some((f) => f.id.includes('setup-node'))).toBe(true);
    expect(result.summaryByCategory['ci_workflow']).toBe(2);
  });
});
