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
import { ContextAssembler, detectRunnableCommandsFromDir } from '../src/discovery/context-assembler.js';
import { auditGovernance } from '../src/domain/governance.js';
import { GovernanceAuditResultSchema } from '../src/contracts/schemas.js';
import { RepoMemoryLedger } from '../src/memory/repo-memory.js';
import { InMemoryRunRepository } from '../src/testkit/index.js';

describe('Advanced Prevention & Anti-Hardcode Engine Suite', () => {
  it.each([
    ['bun@1.3.0', 'vitest --config vitest.config.ts', 'bun run test'],
    ['npm@10.0.0', 'jest --config jest.config.js', 'npm test'],
    ['npm@10.0.0', 'NODE_ENV=test bun test', 'npm test'],
  ])('recognizes Node test scripts with separate option values', (packageManager, script, expected) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-node-test-script-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager,
        scripts: { test: script },
      }));

      expect(detectRunnableCommandsFromDir(tempDir).testCommand).toBe(expected);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ['npm@10.0.0', 'mocha "test/**/*.js"', 'npm exec --no -- mocha'],
    ['npm@10.0.0', 'node --test test/*.js', 'node --test'],
    ['yarn@4.0.0', 'mocha "test/**/*.js"', 'yarn exec mocha'],
  ])('separates the repository test command from its scoped runner: %s', (packageManager, script, redTestCommand) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-node-unscoped-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager,
        scripts: { test: script },
      }));

      const commands = detectRunnableCommandsFromDir(tempDir);
      expect(commands.testCommand).toBe(packageManager.startsWith('yarn') ? 'yarn test' : 'npm test');
      expect(commands.redTestCommand).toBe(redTestCommand);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('preserves supported timeout flags for scoped Bun RED commands', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-bun-test-timeout-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager: 'bun@1.3.14',
        scripts: { test: 'bun test --timeout 30000' },
      }));

      const commands = detectRunnableCommandsFromDir(tempDir);
      expect(commands.testCommand).toBe('bun run test');
      expect(commands.redTestCommand).toBe('bun test --timeout 30000');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('rejects shell glob values passed to test runner flags', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-node-test-unsafe-flag-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager: 'bun@1.3.14',
        scripts: { test: 'bun test --timeout *' },
      }));

      const commands = detectRunnableCommandsFromDir(tempDir);
      expect(commands.testCommand).toBeUndefined();
      expect(commands.redTestCommand).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not emit Yarn Berry scoped commands for classic Yarn', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-yarn-classic-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager: 'yarn@1.22.22',
        scripts: { test: 'mocha "test/**/*.js"' },
      }));

      const commands = detectRunnableCommandsFromDir(tempDir);
      expect(commands.testCommand).toBe('yarn test');
      expect(commands.redTestCommand).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('uses the classic Yarn test script to scope RED when the script has no test operands', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-yarn-classic-scoped-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager: 'yarn@1.22.22',
        scripts: { test: 'mocha --timeout 5000' },
      }));

      const commands = detectRunnableCommandsFromDir(tempDir);
      expect(commands.testCommand).toBe('yarn test');
      expect(commands.redTestCommand).toBe('yarn test');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    'VITEST_POOL_ID=1 vitest tests/**/*.spec.ts',
    'MOCHA_REPORTER=dot mocha "test/**/*.js"',
  ])('does not drop an environment prefix when scoping %s', script => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-node-env-prefix-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager: 'npm@10.0.0',
        scripts: { test: script },
      }));

      const commands = detectRunnableCommandsFromDir(tempDir);
      expect(commands.testCommand).toBe('npm test');
      expect(commands.redTestCommand).toBeNull();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not scope runner scripts with unsupported selection flags', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-node-unsupported-selection-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        packageManager: 'npm@10.0.0',
        scripts: { test: 'jest --testPathPattern=test/**/*.js' },
      }));

      expect(detectRunnableCommandsFromDir(tempDir).testCommand).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('does not treat an unsupported Node test script as a Cargo test command', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-node-cargo-test-'));
    try {
      writeFileSync(join(tempDir, 'package.json'), JSON.stringify({
        scripts: { test: 'node test.js' },
      }));
      writeFileSync(join(tempDir, 'Cargo.toml'), '[package]\nname = "fixture"\nversion = "0.1.0"\n');

      const commands = detectRunnableCommandsFromDir(tempDir);

      expect(commands.testCommand).toBeUndefined();
      expect(commands.packageManager).toBe('npm');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["composer.json", '{"scripts":{"test":"composer test"}}', "composer"],
    ["Gemfile", "source 'https://rubygems.org'\n", "bundle"],
    ["CMakeLists.txt", "project(fixture)\n", "cmake"],
    ["meson.build", "project('fixture')\n", "meson"],
    ["Makefile", "test:\n\t@echo test\n", "make"],
  ] as const)("does not advertise an unscoped %s test command", (manifest, contents, packageManager) => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-unscoped-test-command-'));
    try {
      writeFileSync(join(tempDir, manifest), contents);

      const commands = detectRunnableCommandsFromDir(tempDir);

      expect(commands.packageManager).toBe(packageManager);
      expect(commands.testCommand).toBeUndefined();
      const context = new ContextAssembler().assemble({
        repoFullName: "example/fixture",
        issueNumber: 1,
        issueTitle: "Fixture test command",
        issueBody: "",
        workspacePath: tempDir,
        packageManifest: `${manifest}\n${contents}`,
      });
      expect(context.repoContext.testCommandHint).toBeUndefined();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("advertises an explicitly scoped PHP test runner when PHPUnit is installed", () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'oc-phpunit-command-'));
    try {
      writeFileSync(join(tempDir, 'composer.json'), '{"require-dev":{"phpunit/phpunit":"^10"}}');
      const phpunit = join(tempDir, 'vendor', 'bin', 'phpunit');
      mkdirSync(join(tempDir, 'vendor', 'bin'), { recursive: true });
      writeFileSync(phpunit, '');

      expect(detectRunnableCommandsFromDir(tempDir).testCommand).toMatch(
        /vendor[\\/]bin[\\/]phpunit/i,
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  // ─── 1. Anti-Hardcode & Generalization Gate Tests ───
  describe('Pillar A: Anti-Hardcode & Generalization Gate', () => {
    it('treats an empty diff as clean', () => {
      const result = lintAntiHardcode('');

      expect(result.isClean).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.summary).toBe('No diff content provided.');
    });

    it('allows ordinary production changes but still scans exported code under testing', () => {
      const ordinaryProductionPatch = `
diff --git a/src/parser.ts b/src/parser.ts
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1,0 +1,1 @@
+return parseInput(input);
`;
      expect(lintAntiHardcode(ordinaryProductionPatch).isClean).toBe(true);

      const exportedTestingModulePatch = `
diff --git a/packages/core/src/testing/matrix.ts b/packages/core/src/testing/matrix.ts
--- a/packages/core/src/testing/matrix.ts
+++ b/packages/core/src/testing/matrix.ts
@@ -1,0 +1,1 @@
+if (repo === 'owner/repo') return null;
`;
      const result = lintAntiHardcode(exportedTestingModulePatch);
      expect(result.isClean).toBe(false);
      expect(result.violations[0].rule).toBe('REPO_LITERAL_DISCRIMINATION');
    });

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

    it('allows URL routes without treating them as machine-local paths', () => {
      const routePatch = `
diff --git a/src/routes.ts b/src/routes.ts
--- a/src/routes.ts
+++ b/src/routes.ts
@@ -0,0 +1 @@
+const routePath = "/api/users";
`;
      const result = lintAntiHardcode(routePatch);

      expect(result.isClean).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it('detects environment paths in ordinary string literals and calls', () => {
      const uncPath = '\\\\build-server\\tools\\runner.exe';
      const patch = `
diff --git a/src/launcher.ts b/src/launcher.ts
--- a/src/launcher.ts
+++ b/src/launcher.ts
@@ -0,0 +1,2 @@
+const setting = "/var/lib/agent/config.json";
+exec(${JSON.stringify(uncPath)});
`;
      const result = lintAntiHardcode(patch);

      expect(result.isClean).toBe(false);
      expect(
        result.violations.filter(
          (violation) => violation.rule === 'ABSOLUTE_ENVIRONMENT_PATH',
        ),
      ).toHaveLength(2);
    });

    it('scans executable template interpolations but ignores template text', () => {
      const templateExpression = "${({ repo: repo === 'owner/repo' }).repo}";
      const escapedExpression = "\\${repo === 'owner/repo'}";
      const issueExpression = '${issue?.number === 1614}';
      const patch = [
        'diff --git a/src/repository.ts b/src/repository.ts',
        '--- a/src/repository.ts',
        '+++ b/src/repository.ts',
        '@@ -0,0 +1,4 @@',
        '+const note = `owner/repo`;',
        '+const escaped = `' + escapedExpression + '`;',
        '+const result = `' + templateExpression + '`;',
        '+const issue = `' + issueExpression + '`;',
      ].join('\n');
      const result = lintAntiHardcode(patch, {
        targetRepo: 'owner/repo',
        issueNumber: 1614,
      });

      expect(result.isClean).toBe(false);
      expect(result.violations.map((violation) => violation.rule)).toEqual([
        'REPO_LITERAL_DISCRIMINATION',
        'ISSUE_NUMBER_HARDCODING',
      ]);
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

    it('detects generic repository literals and test-only short-circuits', () => {
      const patch = `
diff --git a/src/repo.ts b/src/repo.ts
--- a/src/repo.ts
+++ b/src/repo.ts
@@ -1,0 +1,1 @@
+if (repoFullName === "owner/repo") return null;
diff --git a/src/parser.ts b/src/parser.ts
--- a/src/parser.ts
+++ b/src/parser.ts
@@ -1,0 +1,1 @@
+if (input === 'test-sample') return;
`;

      const result = lintAntiHardcode(patch);

      expect(result.isClean).toBe(false);
      expect(result.violations.map((violation) => violation.rule)).toEqual([
        'REPO_LITERAL_DISCRIMINATION',
        'TEST_SAMPLE_SHORT_CIRCUIT',
      ]);
      expect(result.summary).toContain('detected 2 hardcoded shortcut(s)');
    });

    it('recognizes object issue references, multiline sample guards, and Unix home paths', () => {
      const patch = `
diff --git a/src/issue.ts b/src/issue.ts
--- a/src/issue.ts
+++ b/src/issue.ts
@@ -1,0 +1,4 @@
+if (issue?.number === 1614) {
+  return workaround();
+}
+if (input === 'test-sample') {
+  return cannedResult;
+}
diff --git a/src/launcher.ts b/src/launcher.ts
--- a/src/launcher.ts
+++ b/src/launcher.ts
@@ -1,0 +1,1 @@
+const toolPath = '/Users/alice/bin/tool';
diff --git a/src/another-launcher.ts b/src/another-launcher.ts
--- a/src/another-launcher.ts
+++ b/src/another-launcher.ts
@@ -1,0 +1,1 @@
+const toolPath = '/home/alice/bin/tool';
`;
      const result = lintAntiHardcode(patch, { issueNumber: 1614 });
      expect(result.isClean).toBe(false);
      expect(result.violations.map((violation) => violation.rule)).toEqual([
        'ISSUE_NUMBER_HARDCODING',
        'TEST_SAMPLE_SHORT_CIRCUIT',
        'ABSOLUTE_ENVIRONMENT_PATH',
        'ABSOLUTE_ENVIRONMENT_PATH',
      ]);
      expect(result.violations[0].line).toContain('issue?.number === 1614');
      expect(result.violations[0].reason).not.toMatch(/[\u4e00-\u9fff]/);
    });

    it('ignores comments, string contents, config files, and quoted test paths', () => {
      const patch = `
diff --git a/src/documentation.ts b/src/documentation.ts
--- a/src/documentation.ts
+++ b/src/documentation.ts
@@ -1,0 +1,4 @@
+/*
+if (repo === 'owner/repo') return null;
+*/
+const example = \`if (issueNumber === 1614) return cannedResult;\`;
diff --git "a/src/ordinary file.ts" "b/src/ordinary file.ts"
--- "a/src/ordinary file.ts"
+++ "b/src/ordinary file.ts"
@@ -1,0 +1,1 @@
+return parseInput(input);
diff --git "a/test/my fixture.ts" "b/test/my fixture.ts"
--- "a/test/my fixture.ts"
+++ "b/test/my fixture.ts"
@@ -1,0 +1,1 @@
+if (repo === 'owner/repo') return null;
diff --git a/package.json b/package.json
--- a/package.json
+++ b/package.json
@@ -1,0 +1,1 @@
+{"repository":"owner/repo"}
`;
      const result = lintAntiHardcode(patch, { issueNumber: 1614 });
      expect(result.isClean).toBe(true);
      expect(result.violations).toEqual([]);
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
      expect(audit.flaggedHardcodeIssues?.[0]).toContain("if (repo === 'microsoft/FLAML')");
      expect(audit.remediationSuggestions.some((s) => s.includes("if (repo === 'microsoft/FLAML')"))).toBe(true);
    });

    it('applies backward-compatible defaults for older governance artifacts', () => {
      expect(GovernanceAuditResultSchema.shape.antiHardcodePassed.parse(undefined)).toBe(true);
      expect(GovernanceAuditResultSchema.shape.flaggedHardcodeIssues.parse(undefined)).toEqual([]);
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

    it('uses non-Python guidance for tabular issues in other repositories', () => {
      for (const language of ['Go', 'Rust', 'TypeScript']) {
        const matrix = generateCombinatorialMatrix({
          primaryLanguage: language,
          issueTitle: 'Fix DataFrame reindex alignment for timestamp rows',
        });
        const guidance = [
          ...matrix.scenarios.map((scenario) => scenario.testTemplateSnippet),
          ...matrix.recommendedAssertions,
        ].join('\n');

        expect(matrix.domain).toBe('tabular_time_series');
        expect(guidance).not.toMatch(
          /pd\.|np\.|assert(?:\s+all|\()/i,
        );
        expect(guidance).not.toMatch(
          /RangeIndex|DatetimeIndex|PeriodIndex|DataFrame|Series/i,
        );
        expect(guidance).toContain('timestamp');
      }

      const pythonMatrix = generateCombinatorialMatrix({
        primaryLanguage: 'Python',
        issueTitle: 'Fix DataFrame reindex alignment for timestamp rows',
      });
      const pythonGuidance = [
        ...pythonMatrix.dimensions.flatMap((dimension) =>
          dimension.variants.map((variant) => variant.sampleCodeSnippet || ''),
        ),
        ...pythonMatrix.scenarios.map((scenario) => scenario.testTemplateSnippet),
      ].join('\n');

      expect(pythonMatrix.domain).toBe('tabular_time_series');
      expect(pythonGuidance).toMatch(/pd\.|np\./);
    });

    it('prefers chunking scenarios when an issue also mentions async execution', () => {
      const matrix = generateCombinatorialMatrix({
        issueTitle: 'Async text chunker loses tokens at the max_tokens boundary',
      });

      expect(matrix.domain).toBe('text_chunking');
      expect(matrix.scenarios.some((scenario) =>
        scenario.scenarioId.includes('UNRESOLVED'),
      )).toBe(true);
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

    it('generates empty and singleton boundary scenarios for general data structures', () => {
      const matrix = generateCombinatorialMatrix({
        issueTitle: 'Validate parser input',
        modifiedFiles: ['src/parser.ts'],
      });

      expect(matrix.domain).toBe('general_data_structure');
      expect(matrix.dimensions.map((dimension) => dimension.name)).toEqual([
        'BoundaryScales',
        'Nullability',
      ]);
      expect(matrix.scenarios.map((scenario) => scenario.scenarioId)).toEqual([
        'EMPTY_COLLECTION_SAFETY',
        'SINGLETON_ELEMENT_INTEGRITY',
        'EXTREME_SCALE',
      ]);
      expect(matrix.recommendedAssertions).toContain('expect(result).toBeDefined()');
    });

    it('routes domain synonyms without matching ordinary words as concurrency', () => {
      expect(generateCombinatorialMatrix({ issueTitle: 'NLP tokenization' }).domain).toBe(
        'text_chunking',
      );
      expect(
        generateCombinatorialMatrix({
          issueTitle: 'Process log batches concurrently using a worker pool',
        }).domain,
      ).toBe('concurrency_stream');
      expect(generateCombinatorialMatrix({ issueTitle: 'Streaming parser updates' }).domain).toBe(
        'concurrency_stream',
      );
      for (const issueTitle of [
        'Block invalid parser inputs',
        'Blocking parser requests',
        'Check the clock before parsing',
      ]) {
        expect(generateCombinatorialMatrix({ issueTitle }).domain).toBe('general_data_structure');
      }
      expect(generateCombinatorialMatrix({ issueTitle: 'Acquire a lock before parsing' }).domain).toBe(
        'concurrency_stream',
      );
      expect(generateCombinatorialMatrix({ issueTitle: 'Add stack trace to parser errors' }).domain).toBe(
        'general_data_structure',
      );
    });

    it('uses the repository language for matrix snippets and token-bound assertions', () => {
      const goConcurrency = generateCombinatorialMatrix({
        primaryLanguage: 'Go',
        issueTitle: 'Handle a worker pool stream with concurrent process cleanup',
      });
      expect(goConcurrency.domain).toBe('concurrency_stream');
      expect(goConcurrency.scenarios[0].testTemplateSnippet).toContain('exec.CommandContext');
      expect(goConcurrency.scenarios[0].testTemplateSnippet).toContain('Process.Kill');
      expect(goConcurrency.scenarios[0].testTemplateSnippet).not.toContain('spawn(');
      expect(goConcurrency.recommendedAssertions[0]).toContain('t.Fatal');

      const pythonGeneral = generateCombinatorialMatrix({
        primaryLanguage: 'Python',
        issueTitle: 'Validate empty parser input',
      });
      expect(pythonGeneral.scenarios[0].testTemplateSnippet).toContain('handle_input');
      expect(pythonGeneral.scenarios[0].testTemplateSnippet).not.toContain('expect(');

      const pythonText = generateCombinatorialMatrix({
        primaryLanguage: 'Python',
        issueTitle: 'NLP tokenization boundary handling',
      });
      const exactBoundary = pythonText.scenarios.find(
        (scenario) => scenario.scenarioId === 'EXACT_TOKEN_BOUNDARY',
      );
      expect(exactBoundary?.testTemplateSnippet).toContain(
        'assert token_len(text) == max_tokens',
      );
      expect(exactBoundary?.testTemplateSnippet).toContain('token_len(chunk) <= max_tokens');
      expect(exactBoundary?.testTemplateSnippet).not.toContain('replace(" ", "")');
      expect(pythonText.recommendedAssertions[0]).toContain('token_len(chunk) <= max_tokens');
      expect(pythonText.recommendedAssertions).toContain(
        'assert "".join(chunks) == text, "Data loss detected during chunking"',
      );

      const javascriptText = generateCombinatorialMatrix({
        primaryLanguage: 'TypeScript',
        issueTitle: 'NLP tokenization boundary handling',
      });
      const javascriptExactBoundary = javascriptText.scenarios.find(
        (scenario) => scenario.scenarioId === 'EXACT_TOKEN_BOUNDARY',
      );
      expect(javascriptExactBoundary?.testTemplateSnippet).toContain(
        'expect(tokenLen(text)).toBe(maxTokens)',
      );
      expect(javascriptText.recommendedAssertions).toContain(
        'expect(chunks.join("")).toBe(text)',
      );
      expect(javascriptText.recommendedAssertions.join('\n')).not.toContain(
        'replaceAll(" ", "")',
      );
    });

    it('includes cleanup in syntax templates and generic fallback guidance', () => {
      const fixtures = [
        {
          language: 'Python',
          workerMarker: 'range(20)',
          setupCleanupMarker: 'finally:',
          interruptMarker: 'process.terminate()',
          waitMarker: 'process.wait(timeout=5)',
          cleanupMarker: 'shutil.rmtree(test_dir)',
        },
        {
          language: 'Go',
          workerMarker: 'make([]*exec.Cmd, 0, 20)',
          setupCleanupMarker: 'defer cleanup()',
          interruptMarker: 'cmd.Process.Kill()',
          waitMarker: 'cmd.Wait()',
          cleanupMarker: 'os.RemoveAll(testDir)',
        },
        {
          language: 'Rust',
          workerMarker: '0..20',
          setupCleanupMarker: '',
          interruptMarker: 'child.kill()',
          waitMarker: 'child.wait()',
          cleanupMarker: 'remove_dir_all(&test_dir)',
        },
        {
          language: 'TypeScript',
          workerMarker: 'length: 20',
          setupCleanupMarker: '',
          interruptMarker: 'child.kill()',
          waitMarker: 'Promise.all(exited)',
          cleanupMarker: 'rmSync(testDir',
        },
      ];

      for (const fixture of fixtures) {
        const matrix = generateCombinatorialMatrix({
          primaryLanguage: fixture.language,
          issueTitle: 'Concurrent worker pool cleanup can fail with EBUSY',
        });
        const scenario = matrix.scenarios.find(
          (candidate) => candidate.scenarioId === 'WINDOWS_EBUSY_HANDLE_RACE',
        );
        const snippet = scenario?.testTemplateSnippet ?? '';

        expect(scenario?.variantCombination).toEqual({
          WorkerConcurrency: 'HighContention',
          LifecycleInterruption: 'MidStreamAbort',
        });
        expect(snippet).toContain(fixture.workerMarker);
        if (fixture.language === 'Python') {
          expect(snippet).toContain('work_items = [tasks[index % len(tasks)] if tasks else {"id": index}');
        }
        if (fixture.language === 'TypeScript') {
          expect(snippet).toContain('Array.from({ length: 20 }');
          expect(snippet).toContain('tasks.length ? tasks[index % tasks.length] : { id: index }');
        }
        if (fixture.setupCleanupMarker) {
          expect(snippet).toContain(fixture.setupCleanupMarker);
        }
        expect(snippet).toContain(fixture.interruptMarker);
        expect(snippet).toContain(fixture.waitMarker);
        expect(snippet).toContain(fixture.cleanupMarker);
        if (fixture.language === 'Python') {
          expect(snippet).toContain('except subprocess.TimeoutExpired:');
          expect(snippet).toContain('process.kill()');
        }
        expect(snippet.indexOf(fixture.workerMarker)).toBeLessThan(snippet.indexOf(fixture.interruptMarker));
        expect(snippet.indexOf(fixture.waitMarker)).toBeLessThan(snippet.indexOf(fixture.cleanupMarker));
      }

      const kotlinFallback = generateCombinatorialMatrix({
        primaryLanguage: 'Kotlin',
        issueTitle: 'Concurrent worker pool cleanup can fail with EBUSY',
      }).scenarios.find((scenario) => scenario.scenarioId === 'WINDOWS_EBUSY_HANDLE_RACE');
      expect(kotlinFallback?.testTemplateSnippet).toContain(
        'Run the work with multiple workers, wait for every worker to finish, then verify that no handles remain open.',
      );
      expect(kotlinFallback?.testTemplateSnippet).toContain(
        'Start 20 child processes, cancel them, wait for every exit, remove their shared temporary directory, and verify cleanup succeeds on Windows.',
      );
    });

    it('uses syntax-specific Unicode and unresolved-chunk templates for supported languages', () => {
      const fixtures = [
        {
          language: 'Python',
          punctuationMarker: 'chunker.split_lines',
          tokenBoundMarker: 'token_len(chunk) <= max_tokens',
        },
        {
          language: 'Go',
          punctuationMarker: 'strings.Join(chunks, "")',
          tokenBoundMarker: 'tokenLen(chunk) > maxTokens',
        },
        {
          language: 'Rust',
          punctuationMarker: 'assert_eq!(chunks.concat(), text)',
          tokenBoundMarker: 'token_len(chunk) <= max_tokens',
        },
        {
          language: 'TypeScript',
          punctuationMarker: 'expect(chunks.join("")).toBe(text)',
          tokenBoundMarker: 'tokenLen(chunk) <= maxTokens',
        },
      ];

      for (const fixture of fixtures) {
        const matrix = generateCombinatorialMatrix({
          primaryLanguage: fixture.language,
          issueTitle: 'NLP tokenization boundary regression',
        });
        const unresolved = matrix.scenarios.find(
          (scenario) => scenario.scenarioId === 'SK_EARLY_EXIT_UNRESOLVED_TRAP',
        );
        const exactBoundary = matrix.scenarios.find(
          (scenario) => scenario.scenarioId === 'EXACT_TOKEN_BOUNDARY',
        );
        const punctuation = matrix.scenarios.find(
          (scenario) => scenario.scenarioId === 'PUNCTUATION_ONLY_DELIMITERS',
        );
        const unresolvedSnippet = unresolved?.testTemplateSnippet ?? '';
        const punctuationSnippet = punctuation?.testTemplateSnippet ?? '';

        expect(unresolvedSnippet).not.toBe(exactBoundary?.testTemplateSnippet);
        expect(unresolved?.variantCombination.TextScaleVsLimit).toBe('OverLimitNoDelimiters');
        expect(unresolvedSnippet).toContain(fixture.tokenBoundMarker);
        expect(unresolvedSnippet).toMatch(/VeryLongContinuousString|unbreakable remainder/);
        expect(punctuationSnippet).toContain(fixture.punctuationMarker);
        expect(punctuationSnippet).toContain('漢字。句子！次の文？');
      }

      const goBoundary = generateCombinatorialMatrix({
        primaryLanguage: 'Go',
        issueTitle: 'NLP tokenization boundary regression',
      }).scenarios.find((scenario) => scenario.scenarioId === 'EXACT_TOKEN_BOUNDARY');
      const rustBoundary = generateCombinatorialMatrix({
        primaryLanguage: 'Rust',
        issueTitle: 'NLP tokenization boundary regression',
      }).scenarios.find((scenario) => scenario.scenarioId === 'EXACT_TOKEN_BOUNDARY');
      expect(goBoundary?.testTemplateSnippet.indexOf('if len(tokens) < maxTokens')).toBeLessThan(
        goBoundary?.testTemplateSnippet.indexOf('tokens[:maxTokens]') ?? -1,
      );
      expect(
        rustBoundary?.testTemplateSnippet.indexOf('assert!(tokens.len() >= max_tokens'),
      ).toBeLessThan(
        rustBoundary?.testTemplateSnippet.indexOf('tokens[..max_tokens]') ?? -1,
      );

      const rustGeneral = generateCombinatorialMatrix({
        primaryLanguage: 'Rust',
        issueTitle: 'Validate parser input boundaries',
      });
      expect(rustGeneral.recommendedAssertions).toContain('assert!(!result.is_empty())');
      expect(rustGeneral.recommendedAssertions.some((assertion) => assertion.includes('is_some()'))).toBe(false);
    });

    it('uses generic text guidance for unsupported language templates', () => {
      const matrix = generateCombinatorialMatrix({
        primaryLanguage: 'Kotlin',
        issueTitle: 'NLP tokenization boundary regression',
      });
      const unresolved = matrix.scenarios.find(
        (scenario) => scenario.scenarioId === 'SK_EARLY_EXIT_UNRESOLVED_TRAP',
      );
      const punctuation = matrix.scenarios.find(
        (scenario) => scenario.scenarioId === 'PUNCTUATION_ONLY_DELIMITERS',
      );

      expect(unresolved?.testTemplateSnippet).toContain('unbreakable remainder');
      expect(unresolved?.testTemplateSnippet).toContain('token limit');
      expect(punctuation?.testTemplateSnippet).toBe(
        'Verify that punctuation-only text splits or remains intact without losing characters.',
      );
    });

    it('includes every declared matrix variant in at least one scenario', () => {
      const reports = [
        generateCombinatorialMatrix({ issueTitle: 'DatetimeIndex and RangeIndex alignment' }),
        generateCombinatorialMatrix({ issueTitle: 'Text chunker token limit and delimiters' }),
        generateCombinatorialMatrix({ issueTitle: 'Async stream worker pool cleanup' }),
        generateCombinatorialMatrix({ issueTitle: 'Validate parser input' }),
      ];

      for (const report of reports) {
        for (const dimension of report.dimensions) {
          for (const variant of dimension.variants) {
            expect(
              report.scenarios.some(
                (scenario) => scenario.variantCombination[dimension.name] === variant.id,
              ),
              `${report.domain}.${dimension.name} is missing variant ${variant.id}`,
            ).toBe(true);
          }
        }
      }
    });
  });

  // ─── 3. Upstream Community Fingerprint Analyzer Tests ───
  describe('Pillar C: Upstream Community Fingerprint Analyzer', () => {
    it('uses the default convention for no commits and the fallback for empty or unstructured messages', () => {
      expect(classifyCommitConvention([])).toEqual({
        convention: 'conventional',
        requiresSignedOffBy: false,
      });
      expect(classifyCommitConvention(['', 'update parser behavior'])).toEqual({
        convention: 'unstructured',
        requiresSignedOffBy: false,
      });
    });

    it('requires a strict majority to select a primary commit convention', () => {
      expect(
        classifyCommitConvention(['feat: add parser', 'Fix parser behavior']).convention,
      ).toBe('unstructured');
    });

    it('does not infer a test runner when the repository has no test files', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-no-tests-'));
      try {
        writeFileSync(join(tempDir, 'go.mod'), 'module example/parser\n');

        const fingerprint = analyzeRepoEngineeringFingerprint({ repoPath: tempDir });

        expect(fingerprint.testConventions).toEqual({
          filePattern: 'unknown',
          frameworkName: 'unknown',
          sampleTestPath: undefined,
          searchLimited: false,
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('uses an upward-rounded DCO threshold and requires a majority for commit style', () => {
      const signed = (subject: string) => `${subject}\n\nSigned-off-by: Dev <dev@example.com>`;
      const sparseHistory = [
        signed('fix: isolated parser case'),
        'update parser behavior',
        'adjust stream cleanup',
        'handle empty input',
        'rename parser helper',
        'document edge case',
      ];

      expect(classifyCommitConvention(sparseHistory)).toEqual({
        convention: 'unstructured',
        requiresSignedOffBy: false,
      });
      expect(
        classifyCommitConvention([
          ...sparseHistory.slice(0, 1),
          signed('docs: explain parser cases'),
          ...sparseHistory.slice(2),
        ]).requiresSignedOffBy,
      ).toBe(true);

      const mostlyUnstructured = [
        'fix: isolated parser case',
        ...Array.from({ length: 19 }, (_, index) => `update parser behavior ${index}`),
      ];
      expect(classifyCommitConvention(mostlyUnstructured).convention).toBe('unstructured');
    });

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

    it('does not infer contributor style from generated merge subjects', () => {
      expect(
        classifyCommitConvention([
          'Merge pull request #123 from contributor/feature',
          'Merge branch main into release',
          '[Core] Fix parser boundary handling',
        ]).convention,
      ).toBe('bracketed_component');
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
        expect(fingerprint.strictnessGateways.hasPreCommit).toBe(false);
        expect(fingerprint.strictnessGateways.hasStrictLint).toBe(false);
        expect(fingerprint.testConventions.filePattern).toBe('test_*.py');
        expect(fingerprint.contributorPersonaAdvice).not.toContain('Pre-commit hooks are configured');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('reads recent commits and discovers nested test and lint conventions', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-nested-'));
      const sourceDir = join(tempDir, 'src');
      mkdirSync(sourceDir);
      writeFileSync(join(sourceDir, 'parser.test.ts'), 'test("parser", () => {});');
      writeFileSync(
        join(tempDir, 'package.json'),
        JSON.stringify({
          packageManager: 'bun@1.3.0',
          scripts: { test: 'vitest run', lint: 'eslint .' },
          devDependencies: { vitest: '^3.0.0' },
        }),
      );
      const gitArgs: string[][] = [];

      try {
        const fingerprint = analyzeRepoEngineeringFingerprint({
          repoPath: tempDir,
          repoFullName: 'example/parser',
          runGit: (args) => {
            gitArgs.push(args);
            return {
              success: true,
              stdout: 'feat(core): parse empty input\n\nSigned-off-by: Dev <dev@example.com>\n---COMMIT_SEP---\n',
            };
          },
        });

        expect(gitArgs).toEqual([[
          '-C',
          tempDir,
          'rev-parse',
          '--is-shallow-repository',
        ], [
          '-C',
          tempDir,
          'log',
          '-n',
          '20',
          '--no-merges',
          '--format=%B---COMMIT_SEP---',
        ]]);
        expect(fingerprint.commitStyle.sampleRecentCommits).toEqual([
          'feat(core): parse empty input\n\nSigned-off-by: Dev <dev@example.com>',
        ]);
        expect(fingerprint.commitStyle.requiresSignedOffBy).toBe(true);
        expect(fingerprint.commitStyle.historyShallow).toBe(false);
        expect(fingerprint.testConventions).toMatchObject({
          filePattern: '*.test.ts',
          frameworkName: 'vitest',
        });
        expect(fingerprint.testConventions.sampleTestPath).toBe(join(sourceDir, 'parser.test.ts'));
        expect(fingerprint.strictnessGateways).toEqual({
          hasPreCommit: false,
          hasStrictLint: true,
          linterCommands: ['bun run lint'],
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('does not infer commit style or DCO policy from shallow history', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-shallow-'));
      try {
        const fingerprint = analyzeRepoEngineeringFingerprint({
          repoPath: tempDir,
          runGit: (args) => ({
            success: true,
            stdout: args.includes('--is-shallow-repository')
              ? 'true'
              : 'feat(core): add parser\n\nSigned-off-by: Dev <dev@example.com>\n---COMMIT_SEP---\n',
          }),
        });

        expect(fingerprint.commitStyle.primaryConvention).toBe('unknown');
        expect(fingerprint.commitStyle.requiresSignedOffBy).toBeUndefined();
        expect(fingerprint.commitStyle.historyShallow).toBe(true);
        expect(fingerprint.contributorPersonaAdvice).toContain('history is shallow');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('reports scan failures separately from entry-limit truncation', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-read-error-'));
      const filePath = join(tempDir, 'not-a-directory');
      writeFileSync(filePath, '');

      try {
        const fingerprint = analyzeRepoEngineeringFingerprint({
          repoPath: filePath,
          runGit: () => ({ success: false, stdout: '' }),
        });

        expect(fingerprint.testConventions.searchLimited).toBe(false);
        expect(fingerprint.contributorPersonaAdvice).not.toContain(
          'search hit its entry limit',
        );
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('formats shallow-history DCO policy as unknown', () => {
      const repoDir = mkdtempSync(join(tmpdir(), 'oc-fp-shallow-context-'));
      const memoryDir = mkdtempSync(join(tmpdir(), 'oc-fp-shallow-memory-'));
      try {
        const assembler = new ContextAssembler(new RepoMemoryLedger(memoryDir));
        const context = assembler.assemble({
          repoFullName: 'example/parser',
          issueTitle: 'Fix parser handling',
          issueBody: '',
          primaryLanguage: 'TypeScript',
          workspacePath: repoDir,
          runGit: (args) => ({
            success: true,
            stdout: args.includes('--is-shallow-repository') ? 'true' : '',
          }),
        });

        expect(assembler.formatContextPrompt(context)).toContain(
          '**DCO Signed-off-by**: Unknown (shallow history)',
        );
      } finally {
        rmSync(repoDir, { recursive: true, force: true });
        rmSync(memoryDir, { recursive: true, force: true });
      }
    });

    it('skips vendored test trees and preserves spec filename extensions', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-vendor-'));
      const vendoredTests = join(tempDir, '.venv', 'lib', 'tests');
      mkdirSync(vendoredTests, { recursive: true });
      writeFileSync(join(vendoredTests, 'test_dependency.py'), '');
      writeFileSync(join(tempDir, 'parser.spec.js'), '');

      try {
        const fingerprint = analyzeRepoEngineeringFingerprint({ repoPath: tempDir });
        expect(fingerprint.testConventions).toMatchObject({
          filePattern: '*.spec.js',
          frameworkName: 'unknown',
          sampleTestPath: join(tempDir, 'parser.spec.js'),
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('finds test files in monorepo trees deeper than three directories', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-deep-tests-'));
      const nestedTestDir = join(
        tempDir,
        'packages',
        'foo',
        'src',
        '__tests__',
      );
      const nestedTestPath = join(nestedTestDir, 'parser.test.ts');
      mkdirSync(nestedTestDir, { recursive: true });
      writeFileSync(nestedTestPath, 'test("parser", () => {});');

      try {
        const fingerprint = analyzeRepoEngineeringFingerprint({ repoPath: tempDir });
        expect(fingerprint.testConventions).toMatchObject({
          filePattern: '*.test.ts',
          sampleTestPath: nestedTestPath,
        });
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('detects Go and Python unittest test filenames and bracketed commit examples', () => {
      const fixtures = [
        { filename: 'parser_test.go', filePattern: '*_test.go', frameworkName: 'go test' },
        { filename: 'parser_test.py', filePattern: '*_test.py', frameworkName: 'pytest/unittest' },
      ];

      for (const fixture of fixtures) {
        const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-pattern-'));
        try {
          writeFileSync(join(tempDir, fixture.filename), '');
          const fingerprint = analyzeRepoEngineeringFingerprint({
            repoPath: tempDir,
            recentCommitMessages: ['[Core] Fix parser boundaries'],
          });

          expect(fingerprint.commitStyle.recommendedCommitExample).toBe(
            '[Core] Fix edge-case null pointer in stream reader',
          );
          expect(fingerprint.testConventions).toMatchObject({
            filePattern: fixture.filePattern,
            frameworkName: fixture.frameworkName,
          });
        } finally {
          rmSync(tempDir, { recursive: true, force: true });
        }
      }
    });

    it('continues when git history cannot be read', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-git-error-'));
      try {
        const fingerprint = analyzeRepoEngineeringFingerprint({
          repoPath: tempDir,
          runGit: () => {
            throw new Error('git unavailable');
          },
        });

        expect(fingerprint.commitStyle.primaryConvention).toBe('conventional');
        expect(fingerprint.commitStyle.sampleRecentCommits).toEqual([]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('includes discovered repository conventions and matrix guidance in assembled context', () => {
      const tempDir = mkdtempSync(join(tmpdir(), 'oc-fp-context-'));
      const memoryDir = mkdtempSync(join(tmpdir(), 'oc-fp-context-memory-'));
      try {
        mkdirSync(join(tempDir, 'tests'));
        writeFileSync(join(tempDir, 'tests', 'parser.spec.ts'), 'test("parser", () => {});');
        writeFileSync(
          join(tempDir, '.pre-commit-config.yaml'),
          'repos:\n  - repo: local\n    hooks:\n      - id: lint\n        entry: eslint .\n        language: system\n        types: [file]',
        );
        writeFileSync(
          join(tempDir, 'package.json'),
          JSON.stringify({ scripts: { test: 'vitest run' }, devDependencies: { vitest: '^3.0.0' } }),
        );
        const assembler = new ContextAssembler(new RepoMemoryLedger(memoryDir));
        const gitArgs: string[][] = [];
        const context = assembler.assemble({
          repoFullName: 'example/parser',
          issueTitle: 'Validate empty parser input',
          issueBody: 'Empty collections should return an empty result.',
          workspacePath: tempDir,
          primaryLanguage: 'Go',
          runGit: (args) => {
            gitArgs.push(args);
            return {
              success: true,
              stdout: '[Core] Fix parser bounds\n---COMMIT_SEP---\n',
            };
          },
        });
        const prompt = assembler.formatContextPrompt(context);

        expect(context.repoContext.engineeringFingerprint?.testConventions).toMatchObject({
          filePattern: '*.spec.ts',
          frameworkName: 'vitest',
        });
        expect(context.repoContext.engineeringFingerprint?.strictnessGateways.hasPreCommit).toBe(true);
        expect(context.repoContext.engineeringFingerprint?.strictnessGateways.hasStrictLint).toBe(true);
        expect(context.repoContext.engineeringFingerprint?.commitStyle.primaryConvention).toBe(
          'bracketed_component',
        );
        expect(gitArgs[0]).toEqual([
          '-C',
          tempDir,
          'rev-parse',
          '--is-shallow-repository',
        ]);
        expect(gitArgs[1]).toContain('--no-merges');
        expect(context.combinatorialMatrix?.domain).toBe('general_data_structure');
        expect(context.combinatorialMatrix?.scenarios[0].testTemplateSnippet).toContain(
          'handleInput([]Item{})',
        );
        const docsOnlyContext = assembler.assemble({
          repoFullName: 'example/parser',
          issueTitle: 'Fix README typo',
          issueBody: '',
          isDocsOnly: true,
        });
        expect(docsOnlyContext.combinatorialMatrix).toBeUndefined();
        expect(assembler.formatContextPrompt(docsOnlyContext)).not.toContain(
          '[COMBINATORIAL_MUTATION_MATRIX - MULTI-DIMENSIONAL BOUNDARY GUIDANCE]',
        );
        expect(prompt).toContain('[UPSTREAM_ENGINEERING_FINGERPRINT - CLONED COMMUNITY CONVENTIONS]');
        expect(prompt).toContain('[COMBINATORIAL_MUTATION_MATRIX - MULTI-DIMENSIONAL BOUNDARY GUIDANCE]');
        expect(prompt).toContain('[EMPTY_COLLECTION_SAFETY]');
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
        rmSync(memoryDir, { recursive: true, force: true });
      }
    });
  });

  it('allows the in-memory run repository to save context after workspace preparation', () => {
    const repository = new InMemoryRunRepository();
    const run = repository.createRun({ repoFullName: 'example/parser' });
    run.currentPhase = 'WORKSPACE_PREPARED';

    repository.saveArtifact(run.runId, 'context', { assembled: true });

    expect(repository.getRun(run.runId)?.manifest.currentPhase).toBe('CONTEXT_ASSEMBLED');
  });
});
