import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  ContextBundler,
  ThreeDimensionalTestGenerator,
  VariantHuntingEngine,
  TaskflowEngine,
  createDefaultPluginHost,
  type PointerStub,
} from '../src/index.js';
import { isTaskflowAvailable } from './helpers/integration-guard.js';

const taskflowAvailable = isTaskflowAvailable();

describe('Deep Advanced Frameworks (Alibaba OCR, Qodo PR-Agent, Piolium P12, GitHub SecLab Taskflow)', () => {
  let tempRepo: string;

  beforeEach(() => {
    tempRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-adv-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempRepo)) {
      fs.rmSync(tempRepo, { recursive: true, force: true });
    }
  });

  it('ContextBundler: extracts minimal deterministic cross-file context bundles (Alibaba OCR)', () => {
    const srcDir = path.join(tempRepo, 'src');
    fs.mkdirSync(srcDir, { recursive: true });

    const targetFile = path.join(srcDir, 'handler.ts');
    const typeFile = path.join(srcDir, 'types.ts');

    fs.writeFileSync(typeFile, 'export interface UserConfig {\n  timeout: number;\n  retries: number;\n}\n', 'utf8');
    fs.writeFileSync(
      targetFile,
      'import { UserConfig } from "./types";\n\nexport function handleReq(cfg: UserConfig) {\n  const res = http.get("url");\n  return res;\n}\n',
      'utf8',
    );

    const finding: PointerStub = {
      namespace: 'findings',
      id: 'leak-1',
      title: 'Resource leak in handleReq',
      category: 'lifecycle_leak',
      severity: 'high',
      file: 'src/handler.ts',
      line: 4,
      affectedSymbol: 'UserConfig',
      confidence: 90,
    };

    const bundle = ContextBundler.createBundle(tempRepo, finding, { radiusLines: 5 });

    expect(bundle.findingId).toBe('leak-1');
    expect(bundle.snippets.length).toBeGreaterThanOrEqual(1);
    expect(bundle.matchedRuleTemplates).toContain('RULE_NPE_DEFER_CLOSE_ORDER');
    expect(bundle.totalTokensEstimate).toBeLessThan(1000); // Strict token bounded
  });

  it('ThreeDimensionalTestGenerator: generates Happy/Edge/Failure parameterized test suites (Qodo PR-Agent)', () => {
    const finding: PointerStub = {
      namespace: 'findings',
      id: 'arith-1',
      title: 'Division by zero hazard',
      category: 'numerical_bounds',
      severity: 'high',
      file: 'math/calc.go',
      line: 12,
      affectedSymbol: 'DivideHandler',
      confidence: 95,
    };

    const goSuite = ThreeDimensionalTestGenerator.generateSuite(finding, 'go');
    expect(goSuite.testCases.length).toBe(3);
    expect(goSuite.testCases.map((c) => c.dimension)).toEqual(['happy_path', 'edge_case', 'failure_injection']);
    expect(goSuite.renderedCode).toContain('TestDivideHandler_ThreeDimensionalTable');
    expect(goSuite.renderedCode).toContain('EdgeCase_NilContext');

    const tsSuite = ThreeDimensionalTestGenerator.generateSuite(finding, 'typescript');
    expect(tsSuite.renderedCode).toContain('3-Dimensional Regression Suite');
    expect(tsSuite.renderedCode).toContain('handles edge cases');
  });

  it('VariantHuntingEngine: scans whole repository for structural bug variants (Piolium P12)', async () => {
    const srcDir = path.join(tempRepo, 'api');
    fs.mkdirSync(srcDir, { recursive: true });

    // Target file with bug
    fs.writeFileSync(path.join(srcDir, 'v1.go'), 'package api\n\nfunc HandleV1() {\n  http.NewRequest("GET", "url", nil)\n}\n', 'utf8');
    // Variant file with same pattern
    fs.writeFileSync(path.join(srcDir, 'v2.go'), 'package api\n\nfunc HandleV2() {\n  http.NewRequest("POST", "url", nil)\n}\n', 'utf8');

    const host = await createDefaultPluginHost({ workspacePath: tempRepo });
    const finding: PointerStub = {
      namespace: 'findings',
      id: 'noctx-v1',
      title: 'Missing Context in HandleV1',
      category: 'lifecycle_leak',
      severity: 'medium',
      file: 'api/v1.go',
      line: 4,
      affectedSymbol: 'http.NewRequest',
      callSite: 'http.NewRequest("GET", "url", nil)',
      confidence: 95,
    };

    const variants = await VariantHuntingEngine.huntVariants(tempRepo, finding, host);
    expect(variants.length).toBeGreaterThanOrEqual(1);
    expect(variants[0].variantFile).toContain('v2.go');
  });

  it.skipIf(!taskflowAvailable)('TaskflowEngine: executes declarative multi-step audit pipeline (GitHub SecLab)', async () => {
    const host = await createDefaultPluginHost({ workspacePath: tempRepo });

    const report = await TaskflowEngine.executeFlow(
      'flow-audit-and-verify',
      tempRepo,
      [
        { id: 'step-1-probe', name: 'Run Probes', action: 'probe_scan' },
        { id: 'step-2-bundle', name: 'Bundle Context', action: 'context_bundle' },
        { id: 'step-3-hunt', name: 'Hunt Variants', action: 'variant_hunt' },
        { id: 'step-4-tests', name: 'Generate 3D Tests', action: 'generate_3d_tests' },
      ],
      host,
    );

    expect(report.status).toBe('SUCCESS');
    expect(report.stepResults.length).toBe(4);
    expect(report.stepResults.every((s) => s.status === 'SUCCESS')).toBe(true);
  }, 30000);
});

