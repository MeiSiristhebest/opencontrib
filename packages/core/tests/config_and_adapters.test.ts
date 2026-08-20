import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  createDefaultPluginHost,
  loadWorkspaceConfig,
  initWorkspaceConfig,
  type RepoFingerprint,
} from '../src/index.js';

describe('Workspace Configuration, Policies & Concrete Capability Adapters', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-cfg-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes and loads .opencontrib.json workspace configuration', () => {
    const configPath = initWorkspaceConfig(tempDir);
    expect(fs.existsSync(configPath)).toBe(true);

    const config = loadWorkspaceConfig(tempDir);
    expect(config.version).toBe('1.0');
    expect(config.enabledCapabilities).toContain('security.static-analysis');
    expect(config.enabledCapabilities).toContain('architecture.dead-code');
    expect(config.policy.network).toBe('denied');
  });

  it('filters registered capabilities based on workspace configuration', async () => {
    // Write custom workspace config disabling dead code and concurrency
    const customConfig = {
      version: '1.0',
      enabledCapabilities: ['security.static-analysis', 'forensics.git-hotspot'],
      policy: { network: 'denied', maxRuntimeSeconds: 120, enableHeavy: false },
    };
    fs.writeFileSync(path.join(tempDir, '.opencontrib.json'), JSON.stringify(customConfig), 'utf8');

    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const activeCaps = host.router.getLevel1Capabilities();

    expect(activeCaps).toContain('security.static-analysis');
    expect(activeCaps).toContain('forensics.git-hotspot');
    // Disabled capabilities should NOT be registered in router
    expect(activeCaps).not.toContain('architecture.dead-code');
    expect(activeCaps).not.toContain('concurrency.leak-detection');
  });

  it('executes Knip Dead Code Adapter on TypeScript workspace', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const tsFingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'TypeScript',
      languages: [{ language: 'TypeScript', percentage: 100, filesCount: 10 }],
      manifests: ['package.json'],
      frameworks: [],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 10,
    };

    const plan = host.router.planRouting(tsFingerprint);
    const selectedIds = plan.selectedCapabilities.map((c) => c.provider.providerId);

    expect(selectedIds).toContain('knip-analyzer');
    expect(selectedIds).toContain('ast-grep');
    expect(selectedIds).toContain('property-fuzz');
  });
});
