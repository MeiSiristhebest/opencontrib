import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createDefaultPluginHost,
  type RepoFingerprint,
} from '../src/index.js';

describe('Full Capability Matrix Completion (noctx, cargo-geiger, eslint-security)', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-matrix-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('routes cargo-geiger on Rust repositories with unsafe code detection capability', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const rustFp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'Rust',
      languages: [{ language: 'Rust', percentage: 100, filesCount: 20 }],
      manifests: ['Cargo.toml'],
      frameworks: [],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 20,
    };

    const plan = host.router.planRouting(rustFp);
    const selectedIds = plan.selectedCapabilities.map((c) => c.provider.providerId);

    expect(selectedIds).toContain('cargo-geiger');
    expect(selectedIds).toContain('cargo-deny');
    expect(selectedIds).toContain('ast-grep');
  });

  it('routes eslint-security on TypeScript & JavaScript Node.js repositories', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const tsFp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'TypeScript',
      languages: [{ language: 'TypeScript', percentage: 100, filesCount: 15 }],
      manifests: ['package.json'],
      frameworks: ['Express'],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 15,
    };

    const plan = host.router.planRouting(tsFp);
    const selectedIds = plan.selectedCapabilities.map((c) => c.provider.providerId);

    expect(selectedIds).toContain('eslint-security');
    expect(selectedIds).toContain('knip-analyzer');
    expect(selectedIds).toContain('ast-grep');
    expect(selectedIds).toContain('semgrep-sast');
  });

  it('verifies complete provider suite is loaded and active in DefaultPluginHost', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const providers = host.router.getAllProviders();
    const providerIds = providers.map((p) => p.providerId);

    expect(providerIds).toContain('ast-grep');
    expect(providerIds).toContain('semgrep-sast');
    expect(providerIds).toContain('ruff-python');
    expect(providerIds).toContain('go-analyzers');
    expect(providerIds).toContain('cargo-deny');
    expect(providerIds).toContain('cargo-geiger');
    expect(providerIds).toContain('eslint-security');
    expect(providerIds).toContain('knip-analyzer');
    expect(providerIds).toContain('git-hotspot');
    expect(providerIds).toContain('piolium');
    expect(providerIds).toContain('property-fuzz');
    expect(providerIds).toContain('workflow-linter');
  });
});
