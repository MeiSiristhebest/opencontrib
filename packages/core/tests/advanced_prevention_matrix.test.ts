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
import { ContextAssembler } from '../src/discovery/context-assembler.js';
import { auditGovernance } from '../src/domain/governance.js';
import { GovernanceAuditResultSchema } from '../src/contracts/schemas.js';
import { RepoMemoryLedger } from '../src/memory/repo-memory.js';

describe('Advanced Prevention & Anti-Hardcode Engine Suite', () => {
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
          issueTitle: 'Process log chunks concurrently using a worker pool',
        }).domain,
      ).toBe('concurrency_stream');
      expect(generateCombinatorialMatrix({ issueTitle: 'Streaming parser updates' }).domain).toBe(
        'concurrency_stream',
      );
      expect(generateCombinatorialMatrix({ issueTitle: 'Block invalid parser inputs' }).domain).toBe(
        'general_data_structure',
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
      expect(exactBoundary?.testTemplateSnippet).toContain('token_len(chunk) <= max_tokens');
      expect(pythonText.recommendedAssertions[0]).toContain('token_len(chunk) <= max_tokens');
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
        expect(fingerprint.strictnessGateways.hasPreCommit).toBe(true);
        expect(fingerprint.strictnessGateways.hasStrictLint).toBe(false);
        expect(fingerprint.testConventions.filePattern).toBe('test_*.py');
        expect(fingerprint.contributorPersonaAdvice).toContain('Pre-commit hooks are configured');
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
        expect(gitArgs[0]).toContain('--no-merges');
        expect(context.combinatorialMatrix?.domain).toBe('general_data_structure');
        expect(context.combinatorialMatrix?.scenarios[0].testTemplateSnippet).toContain(
          'handleInput([]Item{})',
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
});
