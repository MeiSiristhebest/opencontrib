import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PluginHost,
  SmartPointerStore,
  createDefaultPluginHost,
  type OpenContribPlugin,
  type PluginContext,
  type RepoFingerprint,
} from '../src/index.js';

describe('OpenContrib Microkernel & Smart Pointer Architecture', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-kernel-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('initializes PluginHost and registers/activates plugins dynamically', async () => {
    const host = new PluginHost({ workspacePath: tempDir });
    let activated = false;

    const mockPlugin: OpenContribPlugin = {
      name: 'mock-security-plugin',
      version: '1.0.0',
      activate: (ctx: PluginContext) => {
        activated = true;
        ctx.probes.register({
          id: 'mock-probe',
          name: 'Mock Probe',
          category: 'security_cwe',
          description: 'A test probe',
          match: (fp) => fp.primaryLanguage === 'Go',
          scan: async (targetPath, pointers) => {
            pointers.create({
              id: 'mock-finding-1',
              title: 'Mock Vulnerability',
              category: 'security_cwe',
              severity: 'high',
              file: 'main.go',
              line: 42,
              confidence: 95,
              slice: {
                codeSnippet: 'dangerousCall();',
                ruleExplanation: 'Call is dangerous',
              },
            });
          },
        });
      },
    };

    await host.registerPlugin(mockPlugin);
    expect(activated).toBe(true);
    expect(host.listPlugins().some((p) => p.name === 'mock-security-plugin')).toBe(true);
    expect(host.get('mock-probe')?.name).toBe('Mock Probe');
  });

  it('manages Smart Pointers with 3-level progressive dereferencing', () => {
    const store = new SmartPointerStore();

    const ptr = store.create({
      namespace: 'findings',
      id: 'npe-auth-handler-12',
      title: 'Potential Nil Pointer Dereference in Auth Handler',
      category: 'lifecycle_leak',
      severity: 'high',
      file: 'pkg/auth/handler.go',
      line: 88,
      confidence: 94,
      slice: {
        codeSnippet: 'user := req.Context().Value("user").(*User)\nreturn user.ID',
        ruleExplanation: 'Type assertion without comma-ok check panics when unauthenticated context reaches handler.',
        remediationSuggestion: 'user, ok := req.Context().Value("user").(*User)\nif !ok { return ErrUnauthorized }',
      },
      evidence: {
        astDataFlow: 'req.Context() -> Value() -> unchecked cast -> user.ID deref',
        pocCode: 'func TestAuthPanic(t *testing.T) { ... }',
        executionCommand: 'go test -run TestAuthPanic',
      },
    });

    expect(ptr.uri).toBe('ptr://findings/npe-auth-handler-12');

    // Level 1: Stub (~25 tokens)
    const stubResult = store.resolve('ptr://findings/npe-auth-handler-12', 'stub') as any;
    expect(stubResult.id).toBe('npe-auth-handler-12');
    expect(stubResult.file).toBe('pkg/auth/handler.go');
    expect(stubResult.slice).toBeUndefined();
    expect(stubResult.evidence).toBeUndefined();

    // Level 2: Slice (~150 tokens)
    const sliceResult = store.resolve('ptr://findings/npe-auth-handler-12', 'slice') as any;
    expect(sliceResult.slice).toBeDefined();
    expect(sliceResult.slice.codeSnippet).toContain('user.ID');
    expect(sliceResult.evidence).toBeUndefined();

    // Level 3: Evidence (Deep payload & PoC)
    const evidenceResult = store.resolve('ptr://findings/npe-auth-handler-12?view=evidence') as any;
    expect(evidenceResult.evidence).toBeDefined();
    expect(evidenceResult.evidence.astDataFlow).toContain('unchecked cast');
    expect(evidenceResult.evidence.executionCommand).toBe('go test -run TestAuthPanic');
  });

  it('performs dynamic capability negotiation against repository fingerprints', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });

    const goFingerprint: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'Go',
      languages: [{ language: 'Go', percentage: 100, filesCount: 15 }],
      manifests: ['go.mod'],
      frameworks: [],
      hasTests: true,
      hasWorkflows: false,
      totalFiles: 15,
    };

    const negotiation = host.negotiate(goFingerprint);
    const selectedIds = negotiation.selectedProbes.map((p) => p.id);

    // OCR, ast-grep, git-hotspot, property-fuzz match Go
    expect(selectedIds).toContain('ocr');
    expect(selectedIds).toContain('ast-grep');
    expect(selectedIds).toContain('git-hotspot');
    expect(selectedIds).toContain('property-fuzz');

    // Workflow linter skipped (no workflows in this fingerprint)
    expect(selectedIds).not.toContain('workflow-linter');
  });

  it('executes scan and populates Smart Pointer store', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempDir });

    // Create a mock git workflow in tempDir
    const wfDir = path.join(tempDir, '.github', 'workflows');
    fs.mkdirSync(wfDir, { recursive: true });
    fs.writeFileSync(
      path.join(wfDir, 'ci.yml'),
      'name: CI\non: push\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v2\n',
    );

    const fp: RepoFingerprint = {
      repoPath: tempDir,
      primaryLanguage: 'TypeScript',
      languages: [{ language: 'TypeScript', percentage: 100, filesCount: 2 }],
      manifests: ['.github/workflows'],
      frameworks: [],
      hasTests: false,
      hasWorkflows: true,
      totalFiles: 2,
    };

    const { selectedProbes } = host.negotiate(fp, { only: ['workflow-linter'] });
    const result = await host.executeScan(tempDir, selectedProbes);

    expect(result.executedProbes).toContain('workflow-linter');
    expect(result.pointersCreated.length).toBeGreaterThan(0);
    expect(result.pointersCreated[0].uri).toContain('ptr://findings/ci-deprecated');
  });
});
