export interface FailedTestSnippet {
  testName: string;
  package?: string;
  sourceFile?: string;
  sourceLine?: number;
  failureMessage: string;
  stackSnippet: string;
}

export type CiFailureCategory =
  | 'NONE'
  | 'INFRASTRUCTURE_OR_PERMISSIONS'
  | 'TEST_FAILURE'
  | 'LINT_STYLE_FAILURE'
  | 'COMPILATION_OR_BUILD_ERROR'
  | 'RUNTIME_PANIC'
  | 'UNKNOWN_PROCESS_FAILURE';

export interface CiDiagnosticReport {
  hasFailure: boolean;
  failureCategory: CiFailureCategory;
  totalFailedTests: number;
  failedTests: FailedTestSnippet[];
  compilationErrors: string[];
  lintErrors: string[];
  panicMessages: string[];
  infraFailures: string[];
  rootCauseSummary: string;
  recommendedAction: string;
}

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

const INFRASTRUCTURE_FAILURE_PATTERN =
  /(?:environment protection rules|is not allowed to deploy to|Resource not accessible by integration|The deployment was rejected or didn\'t satisfy other protection rules|Input required and not supplied:\s*(?:private_key|app_id)|github-app-token|github-app-auth|secrets\.[A-Z0-9_]+\s*is missing|Workflow does not have ['"]?pull_requests:\s*write['"]?|RequestError\s*\[HttpError\]:\s*Resource not accessible by integration|HttpError:\s*Resource not accessible)/i;

const RUNNER_PROCESS_EXIT_PATTERN =
  /^\s*Error:\s*Process completed with exit code ([1-9]\d*)\./i;

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function isCompilerDiagnostic(line: string): boolean {
  return (
    !INFRASTRUCTURE_FAILURE_PATTERN.test(line) &&
    !RUNNER_PROCESS_EXIT_PATTERN.test(line) &&
    (/^\s*(?:error(?:\s+TS\d+|\s*\[E\d+\]):|fatal error:|syntax error:|SyntaxError:)/i.test(
      line,
    ) ||
      /^\s*[^\s:]+\.(?:go|ts|tsx|js|jsx|py|rs|c|cc|cpp|cxx|h|hpp|java|kt|cs):\d+(?::\d+)?:\s*(?:error\b|fatal error\b|syntax error\b|undefined:|cannot\b|expected\b|unknown\b|no such file\b|invalid operation\b|not enough\b)/i.test(
        line,
      ) ||
      /^\s*[^\s(]+\(\d+(?:,\d+)?\):\s*error\s+TS\d+\b/i.test(line))
  );
}

function isLintStyleDiagnostic(line: string): boolean {
  if (INFRASTRUCTURE_FAILURE_PATTERN.test(line) || RUNNER_PROCESS_EXIT_PATTERN.test(line)) {
    return false;
  }
  // Python Flake8: path/file.py:12:34: E501 line too long
  if (/^\s*[^\s:]+\.py:\d+:\d+:\s*(?:[FEW]\d+|C\d+|N\d+)\s+/i.test(line)) return true;
  // ESLint / Biome: path/file.ts:12:34: error: ...
  if (/^\s*[^\s:]+\.[cm]?[jt]sx?:\d+:\d+:\s*(?:error|warning)\s+/i.test(line)) return true;
  // Black / Prettier: would reformat / Code style issues
  if (/^\s*would reformat\s+/i.test(line) || /Code style issues found in/i.test(line)) return true;
  // Isort: Imports are incorrectly sorted
  if (/Imports are incorrectly sorted/i.test(line)) return true;
  // Pre-commit hooks
  if (/^\[error\]\s*hook id:\s*\S+/i.test(line) || /Hook failed:/i.test(line)) return true;
  // Golangci-lint / gofmt
  if (/File is not `?gofmt`?-ed/i.test(line) || /^\s*[^\s:]+\.go:\d+:\d+:\s*.+\([a-z0-9_\-]+\)$/i.test(line)) return true;
  // Rust Clippy
  if (/error: this expression borrows a value/i.test(line) || /warning: .+ \[clippy::/i.test(line)) return true;

  return false;
}

export function parseCiRawLogs(rawLogText: string): CiDiagnosticReport {
  const cleanText = stripAnsiCodes(rawLogText);
  const lines = cleanText.split(/\r?\n/);

  const failedTests: FailedTestSnippet[] = [];
  const compilationErrors: string[] = [];
  const lintErrors: string[] = [];
  const panicMessages: string[] = [];

  // Buffer recent lines before --- FAIL: to catch file:line assertions printed during test execution
  const recentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    recentLines.push(line);
    if (recentLines.length > 20) {
      recentLines.shift();
    }

    // Go / Pytest / Jest test failure match: --- FAIL: TestName (0.00s)
    const goFailMatch = line.match(/^--- FAIL:\s+([^\s]+)/i);
    const pytestFailMatch = line.match(/^FAILED\s+([^:]+)::([^\s]+)/i);

    if (goFailMatch) {
      const testName = goFailMatch[1];
      let sourceFile: string | undefined;
      let sourceLine: number | undefined;
      let failureMessage: string | undefined;

      // Look back in recentLines for file.go:123: message
      for (let j = recentLines.length - 1; j >= 0; j--) {
        const prev = recentLines[j];
        const match = prev.match(/^\s*([a-zA-Z0-9_\-./]+\.(go|ts|js|py|rs)):(\d+):\s*(.+)/);
        if (match) {
          sourceFile = match[1];
          sourceLine = parseInt(match[3], 10);
          failureMessage = match[4];
          break;
        }
      }

      // Also peek ahead 5 lines in case error was printed after FAIL
      if (!sourceFile) {
        for (let k = i + 1; k < Math.min(lines.length, i + 6); k++) {
          const next = lines[k];
          const match = next.match(/^\s*([a-zA-Z0-9_\-./]+\.(go|ts|js|py|rs)):(\d+):\s*(.+)/);
          if (match) {
            sourceFile = match[1];
            sourceLine = parseInt(match[3], 10);
            failureMessage = match[4];
            break;
          }
        }
      }

      failedTests.push({
        testName,
        sourceFile,
        sourceLine,
        failureMessage: failureMessage || 'Test assertion failed',
        stackSnippet: recentLines.slice(-6).join('\n'),
      });
      continue;
    }

    if (pytestFailMatch) {
      failedTests.push({
        testName: pytestFailMatch[2],
        sourceFile: pytestFailMatch[1],
        failureMessage: `Pytest failed: ${pytestFailMatch[2]} in ${pytestFailMatch[1]}`,
        stackSnippet: line,
      });
      continue;
    }

    // Panic detection
    if (line.startsWith('panic:')) {
      panicMessages.push(line);
    }

    // Only trust infrastructure messages in native GitHub Actions error lines or runner context;
    // build scripts can echo these phrases without the workflow being blocked.
    const hasNativeRunnerErrorContext =
      /^\s*(?:##\[error\]|::error(?::|\s|$))/i.test(line) ||
      (/^\s*Error:\s*/i.test(line) &&
        lines
          .slice(i + 1, Math.min(lines.length, i + 6))
          .some((nextLine) =>
            /^\s*Error:\s*Process completed with exit code [1-9]\d*\./i.test(
              nextLine,
            ),
          ));

    if (
      (hasNativeRunnerErrorContext && INFRASTRUCTURE_FAILURE_PATTERN.test(line)) ||
      (INFRASTRUCTURE_FAILURE_PATTERN.test(line) && /Integration not found|Resource not accessible|github-app-token|secrets\./i.test(line))
    ) {
      compilationErrors.push(`[INFRASTRUCTURE_GATE] ${line.trim()}`);
    }

    if (RUNNER_PROCESS_EXIT_PATTERN.test(line)) {
      compilationErrors.push(`[RUNNER_PROCESS_EXIT] ${line.trim()}`);
    }

    // Distinct Lint/Style errors
    if (isLintStyleDiagnostic(line) && !lintErrors.includes(line.trim())) {
      lintErrors.push(line.trim());
    }

    // Preserve compiler errors as well as infrastructure failures. Go emits a
    // `# package/path` header immediately before its compiler diagnostics.
    if (isCompilerDiagnostic(line) && !compilationErrors.includes(line.trim())) {
      compilationErrors.push(line.trim());
    }
    if (
      /^\s*#\s+\S+/.test(line) &&
      lines.slice(i + 1, i + 5).some(isCompilerDiagnostic) &&
      !compilationErrors.includes(`[COMPILER_PACKAGE] ${line.trim()}`)
    ) {
      compilationErrors.push(`[COMPILER_PACKAGE] ${line.trim()}`);
    }
  }

  const infraFailures = compilationErrors.filter((e) => e.startsWith('[INFRASTRUCTURE_GATE]'));
  const runnerExitFailures = compilationErrors.filter((e) => e.startsWith('[RUNNER_PROCESS_EXIT]'));
  const realCompilationErrors = compilationErrors.filter(
    (e) => !e.startsWith('[INFRASTRUCTURE_GATE]') && !e.startsWith('[RUNNER_PROCESS_EXIT]'),
  );

  const hasFailure =
    failedTests.length > 0 ||
    realCompilationErrors.length > 0 ||
    lintErrors.length > 0 ||
    panicMessages.length > 0 ||
    infraFailures.length > 0 ||
    runnerExitFailures.length > 0;

  // Determine authoritative failure category
  let failureCategory: CiFailureCategory = 'NONE';
  if (!hasFailure) {
    failureCategory = 'NONE';
  } else if (infraFailures.length > 0 && failedTests.length === 0 && realCompilationErrors.length === 0 && lintErrors.length === 0) {
    // Pure infrastructure/permission denial on fork PR
    failureCategory = 'INFRASTRUCTURE_OR_PERMISSIONS';
  } else if (failedTests.length > 0) {
    failureCategory = 'TEST_FAILURE';
  } else if (lintErrors.length > 0 && failedTests.length === 0 && realCompilationErrors.length === 0) {
    failureCategory = 'LINT_STYLE_FAILURE';
  } else if (realCompilationErrors.length > 0) {
    failureCategory = 'COMPILATION_OR_BUILD_ERROR';
  } else if (panicMessages.length > 0) {
    failureCategory = 'RUNTIME_PANIC';
  } else if (infraFailures.length > 0) {
    failureCategory = 'INFRASTRUCTURE_OR_PERMISSIONS';
  } else {
    failureCategory = 'UNKNOWN_PROCESS_FAILURE';
  }

  let rootCauseSummary = 'No failures detected in CI logs.';
  let recommendedAction = 'CI is healthy and passing.';

  if (failureCategory === 'TEST_FAILURE' && failedTests.length > 0) {
    const first = failedTests[0];
    rootCauseSummary = `CI failed with ${failedTests.length} failing test(s). Primary failure in '${first.testName}'${
      first.sourceFile ? ` (${first.sourceFile}:${first.sourceLine})` : ''
    }: ${first.failureMessage}`;
    recommendedAction = `Reproduce '${first.testName}' in sandbox, fix the underlying cross-platform or logic bug, and push updated commit.`;
  } else if (failureCategory === 'LINT_STYLE_FAILURE' && lintErrors.length > 0) {
    rootCauseSummary = `CI failed code style or static analysis gate: ${lintErrors[0]}`;
    recommendedAction = `Run the repository's configured formatter/linter locally to resolve style violations before pushing.`;
  } else if (failureCategory === 'COMPILATION_OR_BUILD_ERROR' && realCompilationErrors.length > 0) {
    rootCauseSummary = `CI failed with ${realCompilationErrors.length} compilation error(s): ${realCompilationErrors[0]}`;
    recommendedAction = `Fix syntax or typing errors locally before pushing.`;
  } else if (failureCategory === 'RUNTIME_PANIC' && panicMessages.length > 0) {
    rootCauseSummary = `CI experienced a runtime panic: ${panicMessages[0]}`;
    recommendedAction = `Inspect nil pointers or out-of-bounds access in the stack trace.`;
  } else if (failureCategory === 'INFRASTRUCTURE_OR_PERMISSIONS' && infraFailures.length > 0) {
    rootCauseSummary = `CI failed due to target repository environment protection or fork token permissions: ${infraFailures[0]}`;
    recommendedAction = `This is an upstream infrastructure privilege limitation on fork PRs (not a code or test regression). No code action required; awaiting maintainer dispatch or approval.`;
  } else if (runnerExitFailures.length > 0) {
    rootCauseSummary = `CI process exited unsuccessfully: ${runnerExitFailures[0]}`;
    recommendedAction = `Inspect the preceding runner output to identify why the CI process exited unsuccessfully.`;
  }

  return {
    hasFailure,
    failureCategory,
    totalFailedTests: failedTests.length,
    failedTests,
    compilationErrors: realCompilationErrors,
    lintErrors,
    panicMessages,
    infraFailures,
    rootCauseSummary,
    recommendedAction,
  };
}
