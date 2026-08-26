import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  triagePointerFindings,
  DEFAULT_SEVERITY_WEIGHTS,
  DEFAULT_CATEGORY_MULTIPLIERS,
  AutonomousPoCVerifier,
  negotiateProbes,
  extractRepoFingerprint,
  ProbeRegistry,
  createDefaultPluginHost,
  type PointerStub,
} from '../src/index.js';

describe('Deep Probe & Triage Coverage', () => {
  it('triages pointers with custom weights and limits', () => {
    const mockPointers: PointerStub[] = [
      {
        id: 'p1',
        uri: 'ptr://findings/p1',
        title: 'NPE leak',
        category: 'lifecycle_leak',
        severity: 'critical',
        file: 'src/main.ts',
        line: 10,
        confidence: 95,
      },
      {
        id: 'p2',
        uri: 'ptr://findings/p2',
        title: 'Dead code unused',
        category: 'dead_code',
        severity: 'low',
        file: 'src/util.ts',
        line: 20,
        confidence: 85,
      },
      {
        id: 'p3',
        uri: 'ptr://findings/p3',
        title: 'Race condition',
        category: 'performance_backpressure',
        severity: 'high',
        file: 'src/worker.ts',
        line: 5,
        confidence: 90,
      },
      {
        id: 'p4',
        uri: 'ptr://findings/p4',
        title: 'Low confidence item',
        category: 'security_cwe',
        severity: 'medium',
        file: 'src/sec.ts',
        line: 50,
        confidence: 60, // Below default 80
      },
    ];

    const result = triagePointerFindings(mockPointers, { limit: 2, minConfidence: 80 });
    expect(result.totalCount).toBe(4);
    expect(result.triagedCount).toBe(2);
    expect(result.topPointers.length).toBe(2);
    expect(result.topPointers[0].id).toBe('p1'); // Critical + lifecycle_leak
    expect(result.topPointers[0].resolveCommand).toContain('ptr://findings/p1');
    expect(result.summary).toContain('Triaged 4 raw findings');

    // Test includeAll option
    const allResult = triagePointerFindings(mockPointers, { includeAll: true, minConfidence: 50 });
    expect(allResult.topPointers.length).toBe(4);
  });

  it('AutonomousPoCVerifier: handles synthesization, fallback commands, and missing repro scripts', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-poc-cov-'));
    try {
      const findingPy: PointerStub = {
        id: 'poc-py',
        uri: 'ptr://findings/poc-py',
        title: 'Py test',
        category: 'lifecycle_leak',
        severity: 'high',
        file: 'module/test.py',
        line: 12,
        confidence: 90,
      };

      const reportPy = await AutonomousPoCVerifier.verifyFinding(tempDir, findingPy);
      expect(reportPy.findingId).toBe('poc-py');

      const findingGo: PointerStub = {
        id: 'poc-go',
        uri: 'ptr://findings/poc-go',
        title: 'Go test',
        category: 'performance_backpressure',
        severity: 'high',
        file: 'pkg/worker.go',
        line: 30,
        confidence: 95,
        verificationStep: {
          setupCode: 'package pkg\nimport "testing"\nfunc TestRepro(t *testing.T){}\n',
          invocationExpression: 'go test ./pkg/...',
          expectedFailureAssertion: 'FAIL',
        },
      };

      const reportGo = await AutonomousPoCVerifier.verifyFinding(tempDir, findingGo);
      expect(reportGo.findingId).toBe('poc-go');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('Negotiator & Probe Registry: negotiates probes with only, skip, and maxCost filters', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-neg-cov-'));
    try {
      fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"test"}\n');
      fs.writeFileSync(path.join(tempDir, 'main.ts'), 'console.log("hello");\n');

      const fp = await extractRepoFingerprint(tempDir);
      const registry = new ProbeRegistry();

      const plan1 = negotiateProbes(fp, { maxCost: 'fast' }, registry);
      expect(plan1).toBeDefined();

      const plan2 = negotiateProbes(fp, { only: ['knip-dead-code'], skip: ['semgrep-sast'] }, registry);
      expect(plan2).toBeDefined();
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });

  it('Test Parsers: parses Cargo and Node test outputs', async () => {
    const { CargoTestOutputParser } = await import('../src/evidence/parsers/cargo-parser.js');
    const { NodeTestOutputParser } = await import('../src/evidence/parsers/node-parser.js');

    const cargoParser = new CargoTestOutputParser();
    expect(cargoParser.supports('test result: ok. 5 passed; 1 failed;')).toBe(true);
    const cargoCounts = cargoParser.parse('test result: ok. 5 passed; 1 failed;');
    expect(cargoCounts.passed).toBe(5);
    expect(cargoCounts.failed).toBe(1);

    const nodeParser = new NodeTestOutputParser();
    expect(nodeParser.supports('331 pass, 0 fail')).toBe(true);
    const nodeCounts = nodeParser.parse('331 pass, 0 fail');
    expect(nodeCounts.passed).toBe(331);
    expect(nodeCounts.failed).toBe(0);
  });

  it('Forensics & Hotspots: runs git hotspots analysis and fuzz generation', async () => {
    const { analyzeGitHotspots, generatePropertyTest } = await import('../src/index.js');
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-hotspot-cov-'));
    try {
      const hotspots = analyzeGitHotspots(tempDir, { limit: 3 });
      expect(Array.isArray(hotspots.topHotspots)).toBe(true);

      const fuzz = generatePropertyTest('numerical_bounds', 'typescript', 'calculateFee');
      expect(fuzz).toBeDefined();
      expect(fuzz.framework).toBe('fast-check');
    } finally {
      if (fs.existsSync(tempDir)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  });
});

