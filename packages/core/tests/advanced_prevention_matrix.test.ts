import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  lintAntiHardcode,
  type AntiHardcodeAuditResult,
} from '../src/governance/anti-hardcode.js';
import {
  generateCombinatorialMatrix,
  type CombinatorialMatrixReport,
} from '../src/testing/combinatorial-matrix.js';
import {
  classifyCommitConvention,
  analyzeRepoEngineeringFingerprint,
} from '../src/discovery/repo-fingerprint.js';
import { auditGovernance } from '../src/domain/governance.js';

describe('Advanced Prevention & Anti-Hardcode Engine Suite', () => {
  // ─── 1. Anti-Hardcode & Generalization Gate Tests ───
  describe('Pillar A: Anti-Hardcode & Generalization Gate', () => {
    it('detects and blocks target repository literal discrimination in production logic', () => {
      const badPatch = `
diff --git a/src/service.ts b/src/service.ts
index 1234567..89abcdef 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -10,6 +10,8 @@ export function runWorkflow(repo: string) {
+  if (repo === 'alibaba/open-code-review') {
+    return runSpecialHack();
+  }
   return runStandard();
 }
`;
      const result = lintAntiHardcode(badPatch, {
        targetRepo: 'alibaba/open-code-review',
      });
      expect(result.isClean).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
      expect(result.violations[0].rule).toBe('REPO_LITERAL_DISCRIMINATION');
      expect(result.violations[0].reason).toContain('hardcodes target repository name');
    });

    it('detects and blocks issue ID hardcoding in production logic', () => {
      const badPatch = `
diff --git a/flaml/automl/task/ts_forecast.py b/flaml/automl/task/ts_forecast.py
--- a/flaml/automl/task/ts_forecast.py
+++ b/flaml/automl/task/ts_forecast.py
@@ -50,6 +50,8 @@ def prepare_data(self, X, y, issueNumber=None):
+    if issueNumber == 1614:
+        y = y.reindex(X.index)
     return X, y
`;
      const result = lintAntiHardcode(badPatch, {
        issueNumber: 1614,
      });
      expect(result.isClean).toBe(false);
      expect(result.violations.some((v) => v.rule === 'ISSUE_NUMBER_HARDCODING')).toBe(true);
    });

    it('detects machine-local absolute path traps in production code', () => {
      const badPatch = `
diff --git a/src/launcher.ts b/src/launcher.ts
--- a/src/launcher.ts
+++ b/src/launcher.ts
@@ -20,6 +20,7 @@ export function getBinPath() {
+  const bin = "C:\\\\Users\\\\Mei\\\\Downloads\\\\opencodereview.exe";
   return bin;
 }
`;
      const result = lintAntiHardcode(badPatch);
      expect(result.isClean).toBe(false);
      expect(result.violations.some((v) => v.rule === 'ABSOLUTE_ENVIRONMENT_PATH')).toBe(true);
    });

    it('allows repository names and sample paths inside test files without false positives', () => {
      const cleanTestPatch = `
diff --git a/test/test_repo_service.py b/test/test_repo_service.py
--- a/test/test_repo_service.py
+++ b/test/test_repo_service.py
@@ -10,6 +10,8 @@ def test_fetch():
+    target = "alibaba/open-code-review"
+    assert target.startswith("alibaba")
`;
      const result = lintAntiHardcode(cleanTestPatch, {
        targetRepo: 'alibaba/open-code-review',
      });
      expect(result.isClean).toBe(true);
      expect(result.violations.length).toBe(0);
    });

    it('enforces anti-hardcode gate in auditGovernance and blocks technical gate', () => {
      const badPatch = `
diff --git a/src/core.ts b/src/core.ts
--- a/src/core.ts
+++ b/src/core.ts
@@ -5,6 +5,7 @@
+if (repo === 'microsoft/FLAML') { return null; }
`;
      const audit = auditGovernance({
        diffText: badPatch,
        prBodyText: 'Fixes bug.',
        targetRepo: 'microsoft/FLAML',
        confidenceBreakdown: {
          rootCause: 95,
          implementation: 95,
          regression: 90,
          defensiveCoverage: 90,
          testCoverage: 90,
          styleMatch: 95,
          securityAudit: 95,
        },
        lineCount: 5,
        preflightLintResult: {
          executed: true,
          passed: true,
          summary: 'Clean',
        },
      });

      expect(audit.antiHardcodePassed).toBe(false);
      expect(audit.technicalGate?.passed).toBe(false);
      expect(audit.remediationSuggestions.some((s) => s.includes('Anti-Hardcode Gate'))).toBe(true);
    });
  });

  // ─── 2. Combinatorial Mutation & Property-based Matrix Tests ───
  describe('Pillar B: Combinatorial Mutation & Property-based Matrix', () => {
    it('generates FLAML-specific multi-index combinatorial matrix for tabular time series', () => {
      const matrix = generateCombinatorialMatrix({
        issueTitle: 'Treat DatetimeIndex as ts_forecast time column and fix reindex alignment',
        issueBody: 'When X has RangeIndex and y has DatetimeIndex, reindex fails',
      });

      expect(matrix.domain).toBe('tabular_time_series');
      expect(matrix.dimensions.length).toBeGreaterThanOrEqual(2);
      expect(matrix.scenarios.some((s) => s.scenarioId === 'FLAML_TRAP_RangeX_DateTimeY')).toBe(true);
      expect(matrix.recommendedAssertions.some((a) => a.includes('isna()'))).toBe(true);
    });

    it('generates Semantic Kernel token-scale and delimiter matrix for text chunking', () => {
      const matrix = generateCombinatorialMatrix({
        issueTitle: 'Text chunker early exit when all_resolved is True',
        issueBody: 'split_lines exits prematurely on long paragraphs without whitespace',
      });

      expect(matrix.domain).toBe('text_chunking');
      expect(matrix.scenarios.some((s) => s.scenarioId === 'SK_EARLY_EXIT_UNRESOLVED_TRAP')).toBe(true);
      expect(matrix.dimensions.some((d) => d.name === 'TextScaleVsLimit')).toBe(true);
    });

    it('generates concurrency & handle collision matrix for async/mutex issues', () => {
      const matrix = generateCombinatorialMatrix({
        issueTitle: 'Windows EBUSY resource busy unlink opencodereview.exe during test cleanup',
        issueBody: 'Mutex locked handle race condition on child process kill',
      });

      expect(matrix.domain).toBe('concurrency_stream');
      expect(matrix.scenarios.some((s) => s.scenarioId === 'WINDOWS_EBUSY_HANDLE_RACE')).toBe(true);
    });
  });

  // ─── 3. Upstream Community Fingerprint Analyzer Tests ───
  describe('Pillar C: Upstream Community Fingerprint Analyzer', () => {
    it('classifies Conventional Commits accurately', () => {
      const commits = [
        'feat(core): add async stream support\n\nSigned-off-by: Dev <dev@example.com>',
        'fix(discovery): resolve timeout on git client',
        'refactor(governance): decouple matrix generator',
      ];
      const { convention, requiresSignedOffBy } = classifyCommitConvention(commits);
      expect(convention).toBe('conventional');
      expect(requiresSignedOffBy).toBe(true);
    });

    it('classifies bracketed component commits accurately (e.g. Semantic Kernel style)', () => {
      const commits = [
        '[Python] Fix text chunker early termination',
        '[Core]: update prompt rendering',
        '[DotNet] Add kernel syntax test',
      ];
      const { convention } = classifyCommitConvention(commits);
      expect(convention).toBe('bracketed_component');
    });

    it('extracts test conventions, strictness, and persona advice from repository filesystem', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-test-'));
      try {
        writeFileSync(join(tempDir, 'test_forecast.py'), '# python test');
        writeFileSync(join(tempDir, '.pre-commit-config.yaml'), 'repos: []');

        const fingerprint = analyzeRepoEngineeringFingerprint({
          repoPath: tempDir,
          repoFullName: 'microsoft/FLAML',
          recentCommitMessages: [
            'Fix ts_forecast index alignment with RangeIndex',
            'Update documentation on AutoML',
          ],
        });

        expect(fingerprint.commitStyle.primaryConvention).toBe('capitalized_imperative');
        expect(fingerprint.strictnessGateways.hasPreCommit).toBe(true);
        expect(fingerprint.testConventions.filePattern).toBe('test_*.py');
        expect(fingerprint.contributorPersonaAdvice).toContain('Pre-commit hooks are configured');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });
});
