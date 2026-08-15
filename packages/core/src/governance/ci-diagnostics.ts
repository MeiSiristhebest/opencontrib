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

export function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_REGEX, '');
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

    // Compilation error detection
    if (line.match(/^#\s+[^\s]+/) || line.includes(': syntax error:') || line.includes(': undefined:')) {
      compilationErrors.push(line);
    }
  }

  const hasFailure = failedTests.length > 0 || compilationErrors.length > 0 || panicMessages.length > 0;

  let rootCauseSummary = 'No failures detected in CI logs.';
  let recommendedAction = 'CI is healthy and passing.';

  if (failedTests.length > 0) {
    const first = failedTests[0];
    rootCauseSummary = `CI failed with ${failedTests.length} failing test(s). Primary failure in '${first.testName}'${
      first.sourceFile ? ` (${first.sourceFile}:${first.sourceLine})` : ''
    }: ${first.failureMessage}`;
    recommendedAction = `Reproduce '${first.testName}' in sandbox, fix the underlying cross-platform or logic bug, and push updated commit.`;
  } else if (compilationErrors.length > 0) {
    rootCauseSummary = `CI failed with ${compilationErrors.length} compilation error(s): ${compilationErrors[0]}`;
    recommendedAction = `Fix syntax or typing errors locally before pushing.`;
  } else if (panicMessages.length > 0) {
    rootCauseSummary = `CI experienced a runtime panic: ${panicMessages[0]}`;
    recommendedAction = `Inspect nil pointers or out-of-bounds access in the stack trace.`;
  }

  return {
    hasFailure,
    totalFailedTests: failedTests.length,
    failedTests,
    compilationErrors,
    panicMessages,
    rootCauseSummary,
    recommendedAction,
  };
}
