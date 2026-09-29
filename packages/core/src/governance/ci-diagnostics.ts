export interface FailedTestSnippet {
  testName: string;
  package?: string;
  sourceFile?: string;
  sourceLine?: number;
  failureMessage: string;
  stackSnippet: string;
}

export interface CiDiagnosticReport {
  hasFailure: boolean;
  totalFailedTests: number;
  failedTests: FailedTestSnippet[];
  compilationErrors: string[];
  panicMessages: string[];
  rootCauseSummary: string;
  recommendedAction: string;
}

const ANSI_REGEX = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;
const INFRASTRUCTURE_FAILURE_PATTERN =
  /(?:environment protection rules|is not allowed to deploy to|Resource not accessible by integration|The deployment was rejected or didn\'t satisfy other protection rules)/i;
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

export function parseCiRawLogs(rawLogText: string): CiDiagnosticReport {
  const cleanText = stripAnsiCodes(rawLogText);
  const lines = cleanText.split(/\r?\n/);

  const failedTests: FailedTestSnippet[] = [];
  const compilationErrors: string[] = [];
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

    // Only trust infrastructure messages in native GitHub Actions error lines;
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
      hasNativeRunnerErrorContext &&
      INFRASTRUCTURE_FAILURE_PATTERN.test(line)
    ) {
      compilationErrors.push(`[INFRASTRUCTURE_GATE] ${line.trim()}`);
    }
    if (RUNNER_PROCESS_EXIT_PATTERN.test(line)) {
      compilationErrors.push(`[RUNNER_PROCESS_EXIT] ${line.trim()}`);
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
    panicMessages.length > 0 ||
    infraFailures.length > 0 ||
    runnerExitFailures.length > 0;

  let rootCauseSummary = 'No failures detected in CI logs.';
  let recommendedAction = 'CI is healthy and passing.';

  if (failedTests.length > 0) {
    const first = failedTests[0];
    rootCauseSummary = `CI failed with ${failedTests.length} failing test(s). Primary failure in '${first.testName}'${
      first.sourceFile ? ` (${first.sourceFile}:${first.sourceLine})` : ''
    }: ${first.failureMessage}`;
    recommendedAction = `Reproduce '${first.testName}' in sandbox, fix the underlying cross-platform or logic bug, and push updated commit.`;
  } else if (realCompilationErrors.length > 0) {
    rootCauseSummary = `CI failed with ${realCompilationErrors.length} compilation error(s): ${realCompilationErrors[0]}`;
    recommendedAction = `Fix syntax or typing errors locally before pushing.`;
  } else if (panicMessages.length > 0) {
    rootCauseSummary = `CI experienced a runtime panic: ${panicMessages[0]}`;
    recommendedAction = `Inspect nil pointers or out-of-bounds access in the stack trace.`;
  } else if (infraFailures.length > 0) {
    rootCauseSummary = `CI failed due to target repository environment protection / app token permissions: ${infraFailures[0]}`;
    recommendedAction = `This is an upstream infrastructure privilege limitation on fork PRs (not a code or test regression). No code action required; awaiting maintainer dispatch or approval.`;
  } else if (runnerExitFailures.length > 0) {
    rootCauseSummary = `CI process exited unsuccessfully: ${runnerExitFailures[0]}`;
    recommendedAction = `Inspect the preceding runner output to identify why the CI process exited unsuccessfully.`;
  }

  return {
    hasFailure,
    totalFailedTests: failedTests.length,
    failedTests,
    compilationErrors: realCompilationErrors,
    panicMessages,
    rootCauseSummary,
    recommendedAction,
  };
}
