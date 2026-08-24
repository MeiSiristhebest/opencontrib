import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  CapabilityRouter,
  EvidenceGraph,
  SmartPointerStore,
  createDefaultPluginHost,
  type RepoFingerprint,
} from '../src/index.js';

describe('Capability Router, Scoring Engine & Evidence Graph', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-cap-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('exposes Level 0 Domains and Level 1 Capabilities progressively', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });
    const level0 = host.router.getLevel0Domains();
    const level1 = host.router.getLevel1Capabilities();

    expect(level0).toContain('security');
    expect(level0).toContain('concurrency');
    expect(level0).toContain('forensics');
    expect(level0).toContain('testing');

    expect(level1).toContain('security.static-analysis');
    expect(level1).toContain('concurrency.leak-detection');
    expect(level1).toContain('bug.reproduction');
  });

  it('scores and routes capabilities dynamically based on repo fingerprint', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });

    const goFingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'Go',
      languages: [{ language: 'Go', percentage: 100, filesCount: 30 }],
      manifests: ['go.mod'],
      frameworks: ['grpc'],
      hasTests: true,
      hasWorkflows: true,
      totalFiles: 30,
    };

    const plan = host.router.planRouting(goFingerprint, { intent: 'general' });

    // Must select fast core providers
    const selectedProviderIds = plan.selectedCapabilities.map((c) => c.provider.providerId);
    expect(selectedProviderIds).toContain('ast-grep');
    expect(selectedProviderIds).toContain('ocr-npe');
    expect(selectedProviderIds).toContain('git-hotspot');
    expect(selectedProviderIds).toContain('piolium');

    // CodeQL is heavy, so it should be in deferredHeavyCapabilities
    const deferredIds = plan.deferredHeavyCapabilities.map((c) => c.provider.providerId);
    expect(deferredIds).toContain('codeql-deep');

    // When enableHeavy is true, CodeQL is promoted to selected
    const heavyPlan = host.router.planRouting(goFingerprint, { intent: 'deep_security', enableHeavy: true });
    const heavySelectedIds = heavyPlan.selectedCapabilities.map((c) => c.provider.providerId);
    expect(heavySelectedIds).toContain('codeql-deep');
  });

  it('links and retrieves complete relational Evidence Chains in EvidenceGraph', () => {
    const store = new SmartPointerStore();
    const graph = new EvidenceGraph(store);

    const hotspotPtr = store.create({
      namespace: 'hotspots',
      id: 'hotspot-auth-go',
      title: 'High Churn in auth.go',
      category: 'lifecycle_leak',
      severity: 'high',
      file: 'pkg/auth/auth.go',
      line: 1,
    });

    const findingPtr = store.create({
      namespace: 'findings',
      id: 'sec-nil-auth-go',
      title: 'NPE in auth.go ValidateUser',
      category: 'lifecycle_leak',
      severity: 'high',
      file: 'pkg/auth/auth.go',
      line: 42,
      affectedSymbol: 'ValidateUser',
    });

    const pocPtr = store.create({
      namespace: 'poc',
      id: 'poc-nil-auth-go',
      title: 'Reproducer for ValidateUser panic',
      category: 'lifecycle_leak',
      severity: 'high',
      file: 'pkg/auth/auth_repro_test.go',
      line: 1,
    });

    // Link relationships
    graph.link(findingPtr.uri, hotspotPtr.uri, 'points_to_hotspot');
    graph.link(findingPtr.uri, pocPtr.uri, 'reproduced_by_poc');

    const chain = graph.getEvidenceChain(findingPtr.uri);
    expect('error' in chain).toBe(false);
    if (!('error' in chain)) {
      expect(chain.findingUri).toBe('ptr://findings/sec-nil-auth-go');
      expect(chain.hotspotUri).toBe('ptr://hotspots/hotspot-auth-go');
      expect(chain.pocUri).toBe('ptr://poc/poc-nil-auth-go');
      expect(chain.pointers.length).toBe(3);
    }
  });
});
