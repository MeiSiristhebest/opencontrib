import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  TaskActionRegistry,
  TaskflowRunner,
  ProbeScanScheduler,
  ContextBundler,
  ClaimProtocol,
  VariantHunter,
  createDefaultPluginHost,
  type FileSystemPort,
  type PointerStub,
} from '../src/index.js';

describe('Architectural Principles Optimization (SRP, OCP, DIP, Semantic Naming)', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-arch-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('OCP: dynamically registers and executes custom TaskActionHandler in TaskActionRegistry', async () => {
    const registry = new TaskActionRegistry();
    let customExecuted = false;

    // Register new custom task action without modifying core runner
    registry.register('custom_fuzz_audit', {
      execute: async (ctx) => {
        customExecuted = true;
        return { output: { customFuzzPassed: true, target: ctx.repoPath } };
      },
    });

    const host = await createDefaultPluginHost({ workspacePath: tempRepo });
    const report = await TaskflowRunner.executeFlow(
      'custom-flow',
      tempRepo,
      [{ id: 'step-fuzz', name: 'Custom Fuzz Action', action: 'custom_fuzz_audit' }],
      host,
      undefined,
      registry,
    );

    expect(customExecuted).toBe(true);
    expect(report.status).toBe('SUCCESS');
    expect(report.stepResults[0].output.customFuzzPassed).toBe(true);
  });

  it('DIP: executes ContextBundler against an abstract in-memory FileSystemPort (zero disk I/O)', () => {
    // In-memory virtual file system adapter
    const virtualFiles = new Map<string, string>();
    virtualFiles.set(
      'src/server.go',
      'package main\n\nimport "net/http"\n\nfunc Run() {\n  http.ListenAndServe(":8080", nil)\n}\n',
    );

    const mockFsPort: FileSystemPort = {
      readFile: (relPath) => virtualFiles.get(relPath) || '',
      readDir: () => ['server.go'],
      exists: (relPath) => virtualFiles.has(relPath),
    };

    const finding: PointerStub = {
      namespace: 'findings',
      id: 'leak-virt',
      title: 'Insecure ListenAndServe',
      category: 'security_cwe',
      severity: 'high',
      file: 'src/server.go',
      line: 6,
      confidence: 95,
    };

    const bundle = ContextBundler.createBundle(mockFsPort, finding, { radiusLines: 3 });

    expect(bundle.findingId).toBe('leak-virt');
    expect(bundle.snippets[0].content).toContain('http.ListenAndServe');
    expect(bundle.matchedRuleTemplates).toContain('RULE_TAINT_SINK_ESCAPE');
  });

  it('SRP & Semantic Naming: validates ClaimProtocol, VariantHunter, and ProbeScanScheduler', () => {
    // 1. ClaimProtocol
    const claim = ClaimProtocol.generateClaimPayload(12, 'Buffer overflow in parser');
    expect(claim.claimComment).toContain('I have investigated this issue and have a reproducible test case and fix ready.');
    expect(ClaimProtocol.isBotAuthor('dependabot[bot]')).toBe(true);

    // 2. VariantHunter class definition
    expect(VariantHunter).toBeDefined();
    expect(ProbeScanScheduler).toBeDefined();
  });
});
