import { describe, expect, it } from 'bun:test';
import {
  analyzePatchImpactAndConsistency,
  parseCiRawLogs,
  resolveTargetedTestPackage,
  sanitizeTestCommand,
  validatePhaseGate,
  type ContributionRunSummary,
} from '../src/index.js';

describe('Phase-Gated State Machine & Lifecycle Lock', () => {
  it('strictly blocks advancing to GOVERNANCE_AUDITED without evidence artifact', () => {
    const summary: ContributionRunSummary = {
      manifest: {
        schemaVersion: '1.0.0',
        runId: 'run_test_001',
        repoFullName: 'alibaba/open-code-review',
        currentPhase: 'WORKSPACE_PREPARED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      artifacts: {
        workspace: { worktreePath: '/tmp/worktree' },
      },
      availableArtifactFiles: ['workspace.json'],
    };

    const res = validatePhaseGate(summary, 'GOVERNANCE_AUDITED');
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
    expect(res.error?.message).toContain('Missing artifact: evidence');
    expect(res.error?.missingPrerequisites).toContain('Missing artifact: evidence');
    expect(res.error?.suggestedAction).toContain('contrib_audit_governance');
  });

  it('allows advancing to GOVERNANCE_AUDITED when workspace, patch, and evidence are present', () => {
    const summary: ContributionRunSummary = {
      manifest: {
        schemaVersion: '1.0.0',
        runId: 'run_test_002',
        repoFullName: 'alibaba/open-code-review',
        currentPhase: 'EVIDENCE_COLLECTED',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      artifacts: {
        workspace: { worktreePath: '/tmp/worktree' },
        evidence: { passedTestsCount: 5, stressLoopPassed: true },
        governance: { score: 95 },
      },
      availableArtifactFiles: ['workspace.json', 'evidence.json', 'governance.json'],
    };

    const res = validatePhaseGate(summary, 'GOVERNANCE_AUDITED');
    expect(res.ok).toBe(true);
    expect(res.error).toBeUndefined();
  });
});

describe('360° Impact & Defensive Consistency Analyzer', () => {
  it('detects filepath.ToSlash Linux no-op trap as a CRITICAL cross-platform hazard', () => {
    const patch = `
diff --git a/internal/tool/code_search.go b/internal/tool/code_search.go
--- a/internal/tool/code_search.go
+++ b/internal/tool/code_search.go
@@ -100,2 +100,2 @@
-func check(s string) {
+func check(s string) {
+    normalized := filepath.ToSlash(s)
`;
    const res = analyzePatchImpactAndConsistency({
      modifiedFiles: ['internal/tool/code_search.go'],
      patchContent: patch,
    });

    expect(res.isCompliant).toBe(false);
    expect(res.riskLevel).toBe('HIGH');
    expect(res.crossPlatformHazards.some((h) => h.includes('filepath.ToSlash'))).toBe(true);
  });

  it('detects CRLF newline split hazard when splitting on \\n without stripping \\r', () => {
    const patch = `
+lines := strings.Split(rawDiff, "\\n")
+for _, l := range lines {
+    process(l)
+}
`;
    const res = analyzePatchImpactAndConsistency({
      modifiedFiles: ['internal/diff/parser.go'],
      patchContent: patch,
    });

    expect(res.crossPlatformHazards.some((h) => h.includes('CRLF'))).toBe(true);
  });

  it('suggests checking sister module hunk.go and types.go when parser.go is modified', () => {
    const res = analyzePatchImpactAndConsistency({
      modifiedFiles: ['internal/diff/parser.go'],
      patchContent: '+// clean fix\n',
      repoContextFiles: [
        'internal/diff/parser.go',
        'internal/diff/hunk.go',
        'internal/diff/types.go',
        'internal/tool/code_search.go',
      ],
    });

    expect(res.suggestedSisterFiles).toContain('internal/diff/hunk.go');
    expect(res.suggestedSisterFiles).toContain('internal/diff/types.go');
    expect(res.consistencyWarnings.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GitHub Actions CI Raw Log Diagnostics', () => {
  it('extracts exact failed test, source file, line number, and root cause from multi-thousand line CI output', () => {
    const sampleCiLog = `
=== RUN   TestHandleRepos_Success
--- PASS: TestHandleRepos_Success (0.00s)
=== RUN   TestCodeSearch_RejectsBackslashPathTraversal
    code_search_test.go:613: expected traversal error, got: No matches found
--- FAIL: TestCodeSearch_RejectsBackslashPathTraversal (0.00s)
=== RUN   TestBuildAllowedHosts
--- PASS: TestBuildAllowedHosts (0.00s)
PASS
coverage: 92.9% of statements
FAIL
Error: Process completed with exit code 1.
`;

    const report = parseCiRawLogs(sampleCiLog);
    expect(report.hasFailure).toBe(true);
    expect(report.totalFailedTests).toBe(1);
    expect(report.failedTests[0].testName).toBe('TestCodeSearch_RejectsBackslashPathTraversal');
    expect(report.failedTests[0].sourceFile).toBe('code_search_test.go');
    expect(report.failedTests[0].sourceLine).toBe(613);
    expect(report.failedTests[0].failureMessage).toContain('expected traversal error');
    expect(report.rootCauseSummary).toContain('TestCodeSearch_RejectsBackslashPathTraversal');
  });

  it('strips ANSI color codes seamlessly before parsing', () => {
    const ansiLog = `\x1B[31m--- FAIL: TestAnsiFailure (0.01s)\x1B[0m\n\x1B[33m    ansi_test.go:42: failed assertion\x1B[0m`;
    const report = parseCiRawLogs(ansiLog);
    expect(report.hasFailure).toBe(true);
    expect(report.failedTests[0].testName).toBe('TestAnsiFailure');
    expect(report.failedTests[0].sourceFile).toBe('ansi_test.go');
    expect(report.failedTests[0].sourceLine).toBe(42);
  });
});

describe('Resilient Sandbox Runner & Targeted Package Resolver', () => {
  it('resolves smallest directory target from modified files', () => {
    const target = resolveTargetedTestPackage(['internal/diff/parser.go', 'internal/diff/hunk.go']);
    expect(target).toBe('./internal/diff');
  });

  it('sanitizes Windows -race command when GCC is absent', () => {
    const sanitized = sanitizeTestCommand('go test', ['-race', './internal/diff/...'], true);
    expect(sanitized.sanitizedArgs).not.toContain('-race');
  });
});
