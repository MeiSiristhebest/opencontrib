import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  analyzeGitHotspots,
  isEligibleSourceCodeFile,
  generatePropertyTest,
  constructPoCForFinding,
  verifyFindingAdversarially,
  getASTGrepRulesForLanguage,
  ProbeRegistry,
  type NormalizedFinding,
} from '../src/probe/index.js';

describe('Advanced Probes, Forensics & Adversarial Adapters', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencontrib-adv-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('generates property-based fuzz test harnesses for various languages', () => {
    const tsSpec = generatePropertyTest('numerical_bounds', 'typescript', 'calculateTimeout');
    expect(tsSpec.framework).toBe('fast-check');
    expect(tsSpec.codeSnippet).toContain('calculateTimeout');
    expect(tsSpec.codeSnippet).toContain('fc.constant(NaN)');

    const pySpec = generatePropertyTest('numerical_bounds', 'python', 'normalize_score');
    expect(pySpec.framework).toBe('hypothesis');
    expect(pySpec.codeSnippet).toContain('allow_nan=True');

    const goSpec = generatePropertyTest('numerical_bounds', 'go', 'ComputeRatio');
    expect(goSpec.framework).toBe('go-quick');
    expect(goSpec.codeSnippet).toContain('quick.Check');
  });

  it('constructs autonomous PoC artifacts (P13) for findings', () => {
    const mockFinding: NormalizedFinding = {
      id: 'vuln-go-nil-42',
      probeName: 'nilaway',
      category: 'lifecycle_leak',
      title: 'Potential nil dereference in server handler',
      description: 'Nil pointer dereference',
      file: 'pkg/server/handler.go',
      line: 42,
      severity: 'high',
      prPotentialScore: 95,
    };

    const poc = constructPoCForFinding(mockFinding);
    expect(poc.pocFileName).toContain('test.go');
    expect(poc.executionCommand).toContain('go test');
  });

  it('verifies findings adversarially (P10) and flags test file false positives', () => {
    const testFinding: NormalizedFinding = {
      id: 'finding-mock-1',
      probeName: 'semgrep',
      category: 'security_cwe',
      title: 'Hardcoded secret in mock test',
      description: 'Secret detected',
      file: 'tests/mocks/auth_mock.ts',
      line: 10,
      severity: 'high',
      prPotentialScore: 85,
    };

    const verification = verifyFindingAdversarially(testFinding);
    expect(verification.isFalsePositive).toBe(true);
    expect(verification.verdict).toBe('PROBABLE_FALSE_POSITIVE');
  });

  it('retrieves ast-grep structural patterns for Go and TypeScript', () => {
    const goRules = getASTGrepRulesForLanguage('go');
    expect(goRules.some((r) => r.id === 'go-resp-body-close')).toBe(true);

    const tsRules = getASTGrepRulesForLanguage('typescript');
    expect(tsRules.some((r) => r.id === 'ts-unhandled-promise-catch')).toBe(true);
  });

  it('contains all 23 builtin probes across 6 dimensions in ProbeRegistry', () => {
    const registry = new ProbeRegistry();
    const all = registry.listAll();
    expect(all.length).toBeGreaterThanOrEqual(20);

    const names = all.map((p) => p.name);
    // Dimension 1
    expect(names).toContain('ocr');
    expect(names).toContain('piolium');
    expect(names).toContain('seclab');
    expect(names).toContain('pr-agent');

    // Dimension 2
    expect(names).toContain('semgrep');
    expect(names).toContain('ast-grep');
    expect(names).toContain('codeql');

    // Dimension 3
    expect(names).toContain('nilaway');
    expect(names).toContain('goleak');
    expect(names).toContain('bodyclose');
    expect(names).toContain('noctx');
    expect(names).toContain('cargo-geiger');
    expect(names).toContain('miri');
    expect(names).toContain('cargo-deny');
    expect(names).toContain('knip');
    expect(names).toContain('eslint-security');
    expect(names).toContain('ruff');
    expect(names).toContain('pyright');

    // Dimension 4, 5, 6
    expect(names).toContain('property-fuzz');
    expect(names).toContain('git-hotspot');
    expect(names).toContain('osv-scanner');
    expect(names).toContain('workflow-linter');
  });

  it('filters out non-code assets, binaries, docs, and gif/png media files in forensics', () => {
    // Media files and asset paths MUST be rejected
    expect(isEligibleSourceCodeFile('.resource/images/examples/agui-report.gif')).toBe(false);
    expect(isEligibleSourceCodeFile('docs/assets/banner.png')).toBe(false);
    expect(isEligibleSourceCodeFile('examples/web/app.jsx')).toBe(false);
    expect(isEligibleSourceCodeFile('testdata/mock.json')).toBe(false);
    expect(isEligibleSourceCodeFile('vendor/github.com/pkg/errors/errors.go')).toBe(false);
    expect(isEligibleSourceCodeFile('README.md')).toBe(false);
    expect(isEligibleSourceCodeFile('package-lock.json')).toBe(false);

    // Genuine application source files MUST be accepted
    expect(isEligibleSourceCodeFile('graph/checkpoint/redis/saver.go')).toBe(true);
    expect(isEligibleSourceCodeFile('packages/core/src/probe/forensics.ts')).toBe(true);
    expect(isEligibleSourceCodeFile('src/kernel/state_machine.rs')).toBe(true);
    expect(isEligibleSourceCodeFile('server/handlers/auth.py')).toBe(true);
  });
});
