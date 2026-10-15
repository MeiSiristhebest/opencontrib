import { describe, expect, it } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  TaskflowRunner,
  createDefaultPluginHost,
  getAllAstGrepRules,
  STANDARD_AST_RELATIONAL_RULES,
  DEFECT_TAXONOMY_CATALOG,
  type PointerStub,
} from '../src/index.js';

describe('Phase 2 Hardening: Taskflow & Probe Convergence', () => {
  it('getAllAstGrepRules combines standard relational rules and defect taxonomy rules without duplicate IDs', () => {
    const allRules = getAllAstGrepRules();
    expect(allRules.length).toBeGreaterThan(STANDARD_AST_RELATIONAL_RULES.length);

    const ids = new Set<string>();
    for (const rule of allRules) {
      expect(ids.has(rule.id)).toBe(false);
      ids.add(rule.id);
    }

    // Verify key defect taxonomy rules are present
    expect(ids.has('ts-ssrf-bracketed-ipv6-bypass')).toBe(true);
    expect(ids.has('rust-unhandled-public-unwrap')).toBe(true);
    expect(ids.has('py-mutable-default-argument')).toBe(true);
  });

  it('createDefaultPluginHost registers canonical probes from ProbeRegistry', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-host-'));
    try {
      const host = await createDefaultPluginHost({ workspacePath: tempDir });
      const probes = host.listAll();

      const probeIds = probes.map((p) => p.id);
      expect(probeIds).toContain('ast-grep');
      expect(probeIds).toContain('ocr');
      expect(probeIds).toContain('osv-scanner');
      expect(probeIds).toContain('codeql');
      expect(probeIds).toContain('pyright');
      expect(probeIds).toContain('miri');
      expect(probeIds).toContain('seclab');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('TaskflowRunner executes real variant_hunt, generate_3d_tests, and verify_sandbox steps', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-test-taskflow-'));
    try {
      const targetFile = path.join(tempDir, 'sample.ts');
      fs.writeFileSync(
        targetFile,
        'export function calc(val: any) { if (val === null) throw new Error("null"); return val * 2; }\n',
        'utf8',
      );

      const host = await createDefaultPluginHost({ workspacePath: tempDir });

      const mockFinding: PointerStub = {
        id: 'test-finding-1',
        title: 'Potential null dereference in calc',
        category: 'numerical_bounds',
        severity: 'high',
        file: 'sample.ts',
        line: 1,
        confidence: 90,
        affectedSymbol: 'calc',
        callSite: 'calc(val)',
        slice: {
          codeSnippet: 'calc(val)',
          ruleExplanation: 'Checks bounds of val',
        },
      };

      const report = await TaskflowRunner.executeFlow(
        'test-flow-real',
        tempDir,
        [
          { id: 's1', name: 'Bundle Context', action: 'context_bundle' },
          { id: 's2', name: 'Hunt Variants', action: 'variant_hunt' },
          { id: 's3', name: 'Generate 3D Tests', action: 'generate_3d_tests' },
          { id: 's4', name: 'Verify Sandbox', action: 'verify_sandbox' },
        ],
        host,
        mockFinding,
      );

      expect(report.status).toBe('SUCCESS');
      expect(report.stepResults.length).toBe(4);

      // Verify variant_hunt output
      const huntStep = report.stepResults.find((s) => s.stepId === 's2');
      expect(huntStep?.status).toBe('SUCCESS');
      expect(huntStep?.output.variantsSearched).toBe(true);

      // Verify generate_3d_tests output
      const testStep = report.stepResults.find((s) => s.stepId === 's3');
      expect(testStep?.status).toBe('SUCCESS');
      expect(testStep?.output.suiteGenerated).toBe(true);
      expect(testStep?.output.testCasesCount).toBe(3);
      expect(testStep?.output.renderedCode).toContain('3-Dimensional Regression Suite');

      // Verify verify_sandbox output
      const verifyStep = report.stepResults.find((s) => s.stepId === 's4');
      expect(verifyStep?.status).toBe('SUCCESS');
      expect(verifyStep?.output.verified).toBe(true);
      expect(verifyStep?.output.confidenceScore).toBe(90);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
