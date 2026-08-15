import { describe, expect, test } from 'bun:test';
import { SandboxRuntime, SanitizedLocalSandboxProvider, defaultSandboxRuntime, defaultSandboxProvider } from '../src/sandbox/sandbox-runtime.js';

import { WorktreeManager, MAX_GENERATED_FILES, MAX_GENERATED_FILE_CHARS } from '../src/workspace/worktree-manager.js';
import { verifyDualStageReproduction, parseAddedTestCasesFromDiffText, countAddedTestCasesFromGitDiff } from '../src/evidence/evidence-collector.js';
import { OpenAICompatibleProvider, MockLLMProvider, LLMService } from '../src/llm/llm-service.js';

import { deriveEvidenceBackedQualityRubric } from '../src/governance/governance-auditor.js';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';

describe('Sandbox Runtime & Environment Security Hardening', () => {
  test('strictly defines denied credential and token file paths', () => {
    const sandbox = new SandboxRuntime();
    const deniedPaths = sandbox.getDeniedPaths();

    expect(deniedPaths.some((p) => p.includes('.ssh'))).toBe(true);
    expect(deniedPaths.some((p) => p.includes('.aws'))).toBe(true);
    expect(deniedPaths.some((p) => p.includes('.git-credentials'))).toBe(true);
    expect(deniedPaths.some((p) => p.includes('.npmrc'))).toBe(true);
    expect(deniedPaths.some((p) => p.includes('.pypirc'))).toBe(true);
    expect(deniedPaths.some((p) => p.includes('.config'))).toBe(true);
  });

  test('cleanses environment variables and isolates HOME / TMP / CI flags', () => {
    const sandbox = new SandboxRuntime();
    const mockTempDir = mkdtempSync(join(tmpdir(), 'test-sandbox-env-'));

    try {
      const sanitized = sandbox.buildSanitizedEnvironment(mockTempDir);

      expect(sanitized.HOME).toBe(mockTempDir);
      expect(sanitized.CI).toBe('true');
      expect(sanitized.FORCE_COLOR).toBe('0');
      expect(sanitized.DEBIAN_FRONTEND).toBe('noninteractive');
      expect(sanitized.GIT_TERMINAL_PROMPT).toBe('0');
      // Must not leak user-defined sensitive tokens
      expect(sanitized.OPENAI_API_KEY).toBeUndefined();
      expect(sanitized.GITHUB_TOKEN).toBeUndefined();
      expect(sanitized.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    } finally {
      rmSync(mockTempDir, { recursive: true, force: true });
    }
  });

  test('executes harmless commands inside sanitized environment successfully', () => {
    const result = defaultSandboxRuntime.executeInSandbox({
      cwd: process.cwd(),
      command: process.platform === 'win32' ? 'powershell' : 'echo',
      args: process.platform === 'win32' ? ['-NoProfile', '-Command', 'Write-Output "SANDBOX_OK"'] : ['"SANDBOX_OK"'],
      timeoutMs: 10000,
    });

    expect(result.isSandboxed).toBe(true);
    expect(result.passed).toBe(true);
    expect(result.output).toContain('SANDBOX_OK');
  });
});

describe('Workspace Security Boundaries & Path Traversal Protection', () => {
  const manager = new WorktreeManager();
  const testRoot = mkdtempSync(join(tmpdir(), 'test-ws-boundary-'));

  test('detects and blocks path traversal attempts escaping root', () => {
    expect(manager.isPathWithinWorkspace(testRoot, 'src/index.ts')).toBe(true);
    expect(manager.isPathWithinWorkspace(testRoot, 'deep/nested/folder/file.js')).toBe(true);

    // Traversal attacks
    expect(manager.isPathWithinWorkspace(testRoot, '../outside.ts')).toBe(false);
    expect(manager.isPathWithinWorkspace(testRoot, '../../etc/passwd')).toBe(false);
  });

  test('applySurgicalFilesSafely strictly enforces file count and size limits', () => {
    // 1. Enforces MAX_GENERATED_FILES limit
    const excessiveFiles = Array.from({ length: MAX_GENERATED_FILES + 1 }, (_, i) => ({
      path: `src/file_${i}.ts`,
      operation: 'CREATE',
      content: `console.log(${i});`,
    }));

    const countResult = manager.applySurgicalFilesSafely(testRoot, excessiveFiles);
    expect(countResult.appliedFiles.length).toBe(0);
    expect(countResult.errors[0]).toContain('exceeds safety limit');

    // 2. Enforces MAX_GENERATED_FILE_CHARS limit
    const hugeFile = [
      {
        path: 'src/huge.ts',
        operation: 'CREATE',
        content: 'x'.repeat(MAX_GENERATED_FILE_CHARS + 10),
      },
    ];

    const sizeResult = manager.applySurgicalFilesSafely(testRoot, hugeFile);
    expect(sizeResult.appliedFiles.length).toBe(0);
    expect(sizeResult.errors[0]).toContain('exceeds safety limit');

    // 3. Blocks writes into protected .git directory
    const gitWrite = [
      {
        path: '.git/config',
        operation: 'MODIFY',
        content: '[core]\n',
      },
    ];
    const gitResult = manager.applySurgicalFilesSafely(testRoot, gitWrite);
    expect(gitResult.appliedFiles.length).toBe(0);
    expect(gitResult.errors[0]).toContain('Security violation');
  });
});

describe('Pre-Fix to Post-Fix Dual-Stage Empirical Verification', () => {
  test('verifies dual-stage reproduction: pre-fix failure assertion + post-fix pass', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'dual-stage-test-'));

    try {
      const dualResult = await verifyDualStageReproduction({
        cwd: tempDir,
        testCommand: process.platform === 'win32' ? 'powershell -NoProfile -Command Write-Output "TEST_PASS"' : 'echo "TEST_PASS"',
        preFixBaselineCaptured: true,
        preFixFailureOutput: 'AssertionError: Expected 42 but got undefined',
        stressLoopCount: 3,
      });

      expect(dualResult.preFixFailingAssertionCaptured).toBe(true);
      expect(dualResult.postFixPassed).toBe(true);
      expect(dualResult.isReproductionVerified).toBe(true);
      expect(dualResult.stressLoopPassed).toBe(true);
      expect(dualResult.completedRuns).toBe(3);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

describe('LLM Service Engineering & Provider Separation', () => {
  test('OpenAICompatibleProvider throws clear error when API key is missing (no silent mock injection)', async () => {
    const provider = new OpenAICompatibleProvider({ apiKey: '' });
    let errorCaught = false;

    try {
      await provider.complete('test prompt');
    } catch (err: any) {
      errorCaught = true;
      expect(err.message).toContain('Missing API key');
    }

    expect(errorCaught).toBe(true);
  });

  test('MockLLMProvider functions reliably for offline test suites', async () => {
    const mock = new MockLLMProvider();
    const response = await mock.complete('Please generate a surgical patch with PatchDraftSchema');
    const parsed = JSON.parse(response);

    expect(parsed.title).toContain('surgical patch');
    expect(parsed.files.length).toBeGreaterThan(0);
  });

  test('LLMService throws clear error when no provider is passed and no API key is in environment', () => {
    const oldKey = process.env.OPENAI_API_KEY;
    const oldLlmKey = process.env.LLM_API_KEY;
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.LLM_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;

    try {
      expect(() => new LLMService()).toThrow('No LLM Provider configured');
    } finally {
      if (oldKey) process.env.OPENAI_API_KEY = oldKey;
      if (oldLlmKey) process.env.LLM_API_KEY = oldLlmKey;
      if (oldAnthropic) process.env.ANTHROPIC_API_KEY = oldAnthropic;
    }
  });
});


describe('Evidence-Backed Quality Rubric & Subagent Review Decoupling', () => {
  test('calibrates conservative score when subagent review is unavailable (no fake 95 score)', () => {
    const rubric = deriveEvidenceBackedQualityRubric({
      hasReproductionAssertion: false,
      testsPassed: true,
      passedTestsCount: 2,
      diffLines: 20,
      subagentReviewAvailable: false,
    });

    expect(rubric.breakdown.styleMatch).toBe(80);
    expect(rubric.breakdown.securityAudit).toBe(80);
    expect(rubric.breakdown.rootCause).toBe(90); // 90 when tests pass but not reproduction-verified
  });

  test('awards maximum confidence when empirical reproduction and subagent review are both verified', () => {
    const rubric = deriveEvidenceBackedQualityRubric({
      hasReproductionAssertion: true,
      testsPassed: true,
      passedTestsCount: 5,
      diffLines: 15,
      styleScore: 96,
      securityScore: 95,
      subagentReviewAvailable: true,
    });

    expect(rubric.breakdown.rootCause).toBe(95);
    expect(rubric.breakdown.implementation).toBe(94);
    expect(rubric.rubricResult.isPassed).toBe(true);
    expect(rubric.rubricResult.overallScore).toBeGreaterThanOrEqual(90);
  });

  test('WorktreeManager strictly fails closed when cloning a nonexistent repository fails', () => {
    const manager = new WorktreeManager();
    expect(() => {
      manager.createIsolatedWorkspace({
        repoFullName: 'nonexistent-org-test-xyz/nonexistent-repo-99999',
        issueOrTaskId: 'test-999',
      });
    }).toThrow('Failed to create isolated workspace');
  });

  test('SandboxProvider strictly blocks execution when cwd escapes workspaceRoot', () => {
    const sandbox = new SanitizedLocalSandboxProvider();
    const allowedRoot = join(tmpdir(), 'opencontrib-allowed-root');
    const evilCwd = join(tmpdir(), 'opencontrib-other-dir');

    const result = sandbox.executeInSandbox({
      cwd: evilCwd,
      workspaceRoot: allowedRoot,
      command: 'echo "evil escape"',
    });

    expect(result.exitCode).toBe(126);
    expect(result.passed).toBe(false);
    expect(result.isSandboxed).toBe(false);
    expect(result.stderr).toContain('violates workspace boundary');
  });

  test('parseAddedTestCasesFromDiffText counts test cases accurately and excludes suites and comments', () => {
    const sampleDiff = `
+describe("Auth suite", () => {
+  // it("commented test", () => {})
+  /* test("block comment", () => {}) */
+  it("authenticates valid token", () => {});
+  it.skip("handles expired token", () => {});
+  test("rejects forged signature", () => {});
+});
+def test_python_case():
+  pass
+# def test_commented():
+func TestGoCase(t *testing.T) {}
+#[test]
+fn rust_case() {}
+`;

    const count = parseAddedTestCasesFromDiffText(sampleDiff);
    // it (1) + it.skip (1) + test (1) + def test_ (1) + func Test (1) + #[test] (1) = 6
    // strictly excludes: describe (1), // it (1), /* test (1), # def test (1)
    expect(count).toBe(6);
  });

  test('TestOutputParserRegistry parses multiple ecosystem outputs and supports custom extension (OCP)', async () => {
    const { defaultTestOutputParserRegistry, TestOutputParserRegistry } = await import('../src/evidence/index.js');

    // Builtin Jest/Vitest/Bun parser
    const jestOut = 'Tests: 12 passed, 1 failed, 13 total';
    const parsedJest = defaultTestOutputParserRegistry.parse(jestOut);
    expect(parsedJest.passed).toBe(12);
    expect(parsedJest.failed).toBe(1);
    expect(parsedJest.total).toBe(13);

    // Builtin Cargo parser
    const cargoOut = 'test result: ok. 8 passed; 0 failed; 0 ignored';
    const parsedCargo = defaultTestOutputParserRegistry.parse(cargoOut);
    expect(parsedCargo.passed).toBe(8);
    expect(parsedCargo.failed).toBe(0);

    // Custom parser extension without modifying existing code (OCP)
    const customRegistry = new TestOutputParserRegistry();
    customRegistry.register({
      id: 'custom-tap',
      supports: (out) => out.includes('# TAP version 13'),
      parse: (out) => ({ passed: 99, failed: 1, total: 100 }),
    });

    const tapResult = customRegistry.parse('# TAP version 13\n1..100');
    expect(tapResult.passed).toBe(99);
    expect(tapResult.failed).toBe(1);
  });

  test('countAddedTestCasesFromGitDiff uses injected VcsDeltaPort (DIP)', async () => {
    const { countAddedTestCasesFromGitDiff } = await import('../src/evidence/index.js');

    const mockVcsAdapter = {
      async getDiff(opts: any) {
        return `+it("handles mock delta", () => {});\n+func TestMock(t *testing.T) {}`;
      },
    };

    const count = await countAddedTestCasesFromGitDiff('/fake/cwd', 'mock-sha', mockVcsAdapter);
    expect(count).toBe(2);
  });
});

