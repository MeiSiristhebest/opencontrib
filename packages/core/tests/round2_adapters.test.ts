import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createDefaultPluginHost,
  type RepoFingerprint,
} from '../src/index.js';

describe('Round 2 Language-Specialized & Deep SAST Capability Adapters', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-round2-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('routes Semgrep SAST on polyglot security-sensitive repositories', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const fp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'TypeScript',
      languages: [
        { language: 'TypeScript', percentage: 70, filesCount: 20 },
        { language: 'Go', percentage: 30, filesCount: 10 },
      ],
      manifests: ['package.json', 'go.mod'],
      frameworks: ['Express', 'Gin'],
      hasTests: true,
      hasWorkflows: true,
      totalFiles: 30,
    };

    const plan = host.router.planRouting(fp, { intent: 'deep_security' });
    const selectedIds = plan.selectedCapabilities.map((c) => c.provider.providerId);

    expect(selectedIds).toContain('semgrep-sast');
    expect(selectedIds).toContain('ast-grep');
    expect(selectedIds).toContain('go-analyzers');
  });

  it('routes Ruff Analyzer specifically for Python repositories', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const pythonFp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'Python',
      languages: [{ language: 'Python', percentage: 100, filesCount: 15 }],
      manifests: ['pyproject.toml'],
      frameworks: ['FastAPI'],
      hasTests: true,
      hasWorkflows: true,
      totalFiles: 15,
    };

    const plan = host.router.planRouting(pythonFp);
    const selectedIds = plan.selectedCapabilities.map((c) => c.provider.providerId);

    expect(selectedIds).toContain('ruff-python');
    expect(selectedIds).toContain('ast-grep');
    expect(selectedIds).toContain('semgrep-sast');
    // Go/Rust specific should NOT be selected
    expect(selectedIds).not.toContain('cargo-deny');
  });

  it('routes Cargo Deny specifically for Rust repositories with Cargo.toml', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const rustFp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'Rust',
      languages: [{ language: 'Rust', percentage: 100, filesCount: 25 }],
      manifests: ['Cargo.toml'],
      frameworks: ['Tokio', 'Axum'],
      hasTests: true,
      hasWorkflows: true,
      totalFiles: 25,
    };

    const plan = host.router.planRouting(rustFp);
    const selectedIds = plan.selectedCapabilities.map((c) => c.provider.providerId);

    expect(selectedIds).toContain('cargo-deny');
    expect(selectedIds).toContain('ast-grep');
    expect(selectedIds).toContain('semgrep-sast');
    expect(selectedIds).not.toContain('ruff-python');
  });
});
