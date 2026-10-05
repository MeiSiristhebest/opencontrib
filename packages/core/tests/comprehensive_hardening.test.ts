import { describe, expect, it } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectHistoricalRunIssues,
  scoutOpportunities,
} from '../src/discovery/scout.js';
import {
  detectRunnableCommandsFromDir,
} from '../src/discovery/context-assembler.js';
import {
  extractLintViolations,
  runPreflightLintCheck,
} from '../src/governance/preflight-linter.js';
import {
  auditGovernance,
  renderMasterPrTemplate,
} from '../src/domain/governance.js';
import { parseCiRawLogs } from '../src/governance/ci-diagnostics.js';
import { getOpenContribDataDir } from '../src/kernel/home.js';
import { defaultSandboxRuntime } from '../src/sandbox/sandbox-runtime.js';
import type { UserProfile } from '../src/contracts/schemas.js';

describe('Comprehensive Industrial Hardening Suite', () => {
  // ─── 1. Scout De-duplication & Stale Opportunity Guard ───
  describe('Pillar 1: Scout De-duplication Guard', () => {
    it('collects historical run issues from local runs artifacts', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-scout-test-'));
      try {
        const run1Dir = join(tempDir, 'run-1');
        const run2Dir = join(tempDir, 'run-2');
        mkdirSync(run1Dir, { recursive: true });
        mkdirSync(run2Dir, { recursive: true });

        writeFileSync(
          join(run1Dir, 'context.json'),
          JSON.stringify({
            problemContext: {
              repoFullName: 'microsoft/FLAML',
              issueNumber: 1614,
            },
          }),
        );
        writeFileSync(
          join(run2Dir, 'manifest.json'),
          JSON.stringify({
            repoFullName: 'alibaba/open-code-review',
            issueNumber: 1583,
          }),
        );

        const historical = collectHistoricalRunIssues(tempDir);
        expect(historical.has('microsoft/flaml#1614')).toBe(true);
        expect(historical.has('alibaba/open-code-review#1583')).toBe(true);
        expect(historical.has('microsoft/flaml#9999')).toBe(false);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('uses canonical persistent storage and the opportunity repository for deduplication', () => {
      const home = mkdtempSync(join(tmpdir(), 'oc-scout-home-'));
      const previousHome = process.env.OPENCONTRIB_HOME;
      try {
        process.env.OPENCONTRIB_HOME = home;
        const runDir = join(getOpenContribDataDir(), 'runs', 'org-run');
        mkdirSync(runDir, { recursive: true });
        writeFileSync(
          join(runDir, 'opportunity.json'),
          JSON.stringify({
            target: 'microsoft',
            topOpportunity: {
              repoFullName: 'microsoft/FLAML',
              issueNumber: 1614,
            },
          }),
        );

        expect(collectHistoricalRunIssues().has('microsoft/flaml#1614')).toBe(
          true,
        );
        expect(collectHistoricalRunIssues().has('microsoft#1614')).toBe(false);
      } finally {
        if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
        else process.env.OPENCONTRIB_HOME = previousHome;
        rmSync(home, { recursive: true, force: true });
      }
    });

    it('filters out previously attempted issues during scout discovery', async () => {
      const fakeClient = {
        searchIssues: async () => ({
          status: 'OK',
          items: [
            {
              number: 101,
              title: 'Fix datetime bug',
              body: 'Issue description',
              state: 'open',
              repository_url: 'https://api.github.com/repos/test-org/test-repo',
              labels: [{ name: 'bug' }],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
            {
              number: 102,
              title: 'Add new feature',
              body: 'Feature description',
              state: 'open',
              repository_url: 'https://api.github.com/repos/test-org/test-repo',
              labels: [{ name: 'enhancement' }],
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
            },
          ],
        }),
        getRepoDetails: async () => ({
          status: 'OK',
          data: { stars: 100, isArchived: false },
        }),
        getRepoDirectoryContentsResult: async () => ({
          status: 'OK',
          data: [],
        }),
        getRepoTextFileResult: async () => ({
          status: 'NOT_FOUND',
        }),
        getIssueComments: async () => ({
          status: 'OK',
          data: [],
        }),
        getIssueLinkedPrsCount: async () => ({
          status: 'OK',
          data: 0,
        }),
      } as any;

      const profile: UserProfile = {
        techStack: ['typescript', 'python'],
        focusAreas: ['bugfix'],
        proficiency: 'intermediate',
        minMatchScore: 50,
      };

      // Exclude issue 101
      const results = await scoutOpportunities(
        profile,
        {
          repo: 'test-org/test-repo',
          excludeIssues: ['test-org/test-repo#101'],
        },
        fakeClient,
      );

      expect(results.some((r) => r.issueNumber === 101)).toBe(false);
      expect(results.some((r) => r.issueNumber === 102)).toBe(true);
    });
  });

  // ─── 2. Pre-Flight Lint & Code Style Gate ───
  describe('Pillar 2: Pre-Flight Static Checks & Lint Enforcer', () => {
    it('detects pre-commit, flake8, and Makefile lint commands accurately', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-lint-detect-'));
      try {
        // Test Python repository with .flake8
        writeFileSync(join(tempDir, 'setup.py'), '# python');
        writeFileSync(join(tempDir, '.flake8'), '[flake8]\nmax-line-length = 120\n');
        const pyCommands = detectRunnableCommandsFromDir(tempDir);
        expect(pyCommands.lintCommand).toBe('flake8');

        // Test pre-commit override
        writeFileSync(join(tempDir, '.pre-commit-config.yaml'), 'repos: []\n');
        rmSync(join(tempDir, '.flake8'));
        const preCommitCommands = detectRunnableCommandsFromDir(tempDir);
        expect(preCommitCommands.lintCommand).toBe('ruff check .');

        writeFileSync(
          join(tempDir, '.pre-commit-config.yaml'),
          'repos:\n  - repo: local\n    hooks:\n      - id: lint\n        name: lint\n        entry: ruff check .\n        language: system\n',
        );
        expect(detectRunnableCommandsFromDir(tempDir).lintCommand).toBe(
          'pre-commit run --all-files',
        );

        const nodeProject = join(tempDir, 'node-project');
        mkdirSync(nodeProject, { recursive: true });
        writeFileSync(
          join(nodeProject, 'package.json'),
          JSON.stringify({ scripts: { test: 'node test.js' } }),
        );
        expect(detectRunnableCommandsFromDir(nodeProject).testCommand).toBeUndefined();
        writeFileSync(
          join(nodeProject, 'package.json'),
          JSON.stringify({ scripts: { test: 'vitest run' } }),
        );
        expect(detectRunnableCommandsFromDir(nodeProject).testCommand).toBe('npm test');
        writeFileSync(join(nodeProject, 'GNUmakefile'), 'lint:\n\techo lint\n');
        expect(detectRunnableCommandsFromDir(nodeProject).lintCommand).toBe(
          'make lint',
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('extracts lint and formatting violations from diverse tool outputs', () => {
      const flake8Output = `
flaml/automl/task/ts_forecast.py:123:1: F401 'pandas as pd' imported but unused
flaml/automl/task/ts_forecast.py:240:80: E501 line too long (88 > 79 characters)
`;
      const violations = extractLintViolations(flake8Output);
      expect(violations.length).toBe(2);
      expect(violations[0]).toContain("F401 'pandas as pd' imported but unused");
      expect(violations[1]).toContain('E501 line too long');

      const blackOutput = `would reformat src/main.py\nOh no! 💥 1 file would be reformatted.`;
      const blackViolations = extractLintViolations(blackOutput);
      expect(blackViolations.length).toBe(1);
      expect(blackViolations[0]).toContain('would reformat src/main.py');

      const eslintOutput = `src/main.ts\n  1:1  warning  Unexpected console statement  no-console\n\u2716 1 problem (0 errors, 1 warning)`;
      const eslintViolations = extractLintViolations(eslintOutput);
      expect(eslintViolations).toHaveLength(1);
      expect(eslintViolations[0]).toContain('1:1  warning');
    });

    it('uses asynchronous sandbox execution for preflight lint commands', async () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-lint-async-'));
      const originalExecuteAsync = defaultSandboxRuntime.executeAsync;
      let usedAsyncExecutor = false;
      defaultSandboxRuntime.executeAsync = async () => {
        usedAsyncExecutor = true;
        return {
          command: 'lint',
          exitCode: 0,
          passed: true,
          stdout: '',
          stderr: '',
          output: '',
          isSandboxed: true,
          isolationWarnings: [],
        };
      };
      try {
        const result = await runPreflightLintCheck({
          workspaceRoot: tempDir,
          lintCommand: 'lint',
        });
        expect(usedAsyncExecutor).toBe(true);
        expect(result.passed).toBe(true);
      } finally {
        defaultSandboxRuntime.executeAsync = originalExecuteAsync;
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('enforces preflight lint failure in governance technical audit gate', () => {
      const passResult = auditGovernance({
        diffText: 'const x = 1;',
        prBodyText: 'Fixes bug cleanly.',
        confidenceBreakdown: {
          rootCause: 95,
          implementation: 95,
          regression: 90,
          defensiveCoverage: 90,
          testCoverage: 90,
          styleMatch: 95,
          securityAudit: 95,
        },
        lineCount: 10,
        preflightLintResult: {
          executed: true,
          passed: true,
          summary: 'Pre-flight lint passed cleanly.',
        },
      });
      expect(passResult.technicalGate?.passed).toBe(true);
      expect(passResult.preflightLintPassed).toBe(true);

      const failResult = auditGovernance({
        diffText: 'const x = 1;',
        prBodyText: 'Fixes bug cleanly.',
        confidenceBreakdown: {
          rootCause: 95,
          implementation: 95,
          regression: 90,
          defensiveCoverage: 90,
          testCoverage: 90,
          styleMatch: 95,
          securityAudit: 95,
        },
        lineCount: 10,
        preflightLintResult: {
          executed: true,
          passed: false,
          summary: 'Pre-flight lint gate FAILED with 1 style violation(s).',
          violations: ["file.py:12:1: F401 'os' imported but unused"],
        },
      });
      expect(failResult.technicalGate?.passed).toBe(false);
      expect(failResult.preflightLintPassed).toBe(false);
      expect(failResult.remediationSuggestions.some((s) => s.includes('Pre-Flight Lint Gate'))).toBe(true);

      const unavailableResult = auditGovernance({
        diffText: 'const x = 1;',
        prBodyText: 'Fixes bug cleanly.',
        confidenceBreakdown: {
          rootCause: 95,
          implementation: 95,
          regression: 90,
          defensiveCoverage: 90,
          testCoverage: 90,
          styleMatch: 95,
          securityAudit: 95,
        },
        lineCount: 10,
      });
      expect(unavailableResult.preflightLintPassed).toBe(false);
      expect(unavailableResult.technicalGate?.passed).toBe(false);
      expect((unavailableResult.preflightLintIssues ?? []).join(' ')).toContain(
        'result is unavailable',
      );
    });
  });

  // ─── 3. CI Diagnostics Hardening ───
  describe('Pillar 3: CI Diagnostics Hardening', () => {
    it('accurately categorizes Fork token/permission errors as INFRASTRUCTURE_OR_PERMISSIONS', () => {
      const log = `
2026-09-29T10:00:00.000Z ##[error]Resource not accessible by integration
2026-09-29T10:00:01.000Z Error: Process completed with exit code 1.
`;
      const report = parseCiRawLogs(log);
      expect(report.failureCategory).toBe('INFRASTRUCTURE_OR_PERMISSIONS');
      expect(report.recommendedAction).toContain('upstream infrastructure privilege limitation on fork PRs');
    });

    it('does not classify non-fatal ESLint warnings as CI failures', () => {
      const report = parseCiRawLogs(`src/main.ts:1:1: warning Unexpected console statement`);
      expect(report.hasFailure).toBe(false);
      expect(report.failureCategory).toBe('NONE');
      expect(report.lintErrors).toHaveLength(0);
    });

    it('accurately categorizes flake8/lint errors as LINT_STYLE_FAILURE', () => {
      const log = `
Running flake8...
flaml/automl/task/ts_forecast.py:45:1: F401 'sys' imported but unused
flaml/automl/task/ts_forecast.py:90:80: E501 line too long
Error: Process completed with exit code 1.
`;
      const report = parseCiRawLogs(log);
      expect(report.failureCategory).toBe('LINT_STYLE_FAILURE');
      expect(report.lintErrors.length).toBeGreaterThan(0);
      expect(report.recommendedAction).toContain('Run the repository\'s configured formatter/linter locally');
    });

    it('accurately categorizes unit test failure as TEST_FAILURE', () => {
      const log = `
=== RUN   TestForecastDatetimeIndex
    forecast_test.go:42: assertion failed: expected 10 items, got 8
--- FAIL: TestForecastDatetimeIndex (0.05s)
`;
      const report = parseCiRawLogs(log);
      expect(report.failureCategory).toBe('TEST_FAILURE');
      expect(report.failedTests.length).toBe(1);
      expect(report.failedTests[0].testName).toBe('TestForecastDatetimeIndex');
    });
  });

  // ─── 4. Native PR Template Sanitization & Auto-Fill ───
  describe('Pillar 4: Native PR Template Sanitization & Auto-Fill', () => {
    it('auto-checks checkbox issue references and cleans placeholder tags', () => {
      const nativeTemplate = `
## Description
<!-- Please describe your changes below -->
[Please describe the problem here]

## Related Issues
- [ ] Fixes #
- [ ] Closes #

## Type of Change
- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] Documentation update
`;

      const rendered = renderMasterPrTemplate({
        issueNumber: 14490,
        submissionRoute: 'PUBLIC_ISSUE',
        problemSummary: 'Fix text chunker early exit bug',
        rootCause: 'all_resolved was prematurely setting exit flag',
        keyChanges: ['Propagate all_resolved correctly through recursive steps'],
        nativeTemplateContent: nativeTemplate,
        isDocumentationOnly: false,
      });

      expect(rendered).toContain('- [x] Fixes #14490');
      expect(rendered).toContain('- [x] Bug fix');
      expect(rendered).not.toContain('<!-- Please describe your changes below -->');
      expect(rendered).not.toContain('[Please describe the problem here]');
      expect(rendered).toContain('Fix text chunker early exit bug');
    });
  });
});
