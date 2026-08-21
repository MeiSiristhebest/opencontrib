import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class CppGTestOutputParser implements TestOutputParser {
  readonly id = 'cpp-gtest';

  supports(output: string): boolean {
    return (
      output.includes('[  PASSED  ]') ||
      output.includes('[  FAILED  ]') ||
      /\[==========\]\s*\d+\s*tests?\s*from\s*\d+\s*test suites? ran/i.test(output) ||
      /\d+%\s*tests passed,\s*\d+\s*tests failed out of \d+/i.test(output) ||
      /All tests passed \(\d+ assertions in \d+ test cases\)/i.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    // 1. Google Test format: "[  PASSED  ] 14 tests." / "[  FAILED  ] 2 tests."
    const gtestPassedMatch = output.match(/\[\s*PASSED\s*\]\s*(\d+)\s*tests?/i);
    const gtestFailedMatch = output.match(/\[\s*FAILED\s*\]\s*(\d+)\s*tests?/i);
    if (gtestPassedMatch || gtestFailedMatch) {
      passed = gtestPassedMatch ? parseInt(gtestPassedMatch[1], 10) : 0;
      failed = gtestFailedMatch ? parseInt(gtestFailedMatch[1], 10) : 0;
      return { passed, failed, total: passed + failed };
    }

    // 2. CTest summary format: "100% tests passed, 0 tests failed out of 25"
    const ctestMatch = output.match(/\d+%\s*tests passed,\s*(\d+)\s*tests failed out of (\d+)/i);
    if (ctestMatch) {
      failed = parseInt(ctestMatch[1], 10);
      const total = parseInt(ctestMatch[2], 10);
      passed = Math.max(0, total - failed);
      return { passed, failed, total };
    }

    // 3. Catch2 format: "test cases: 10 | 10 passed"
    const catch2Match = output.match(/test cases:\s*(\d+)\s*\|\s*(\d+)\s*passed/i);
    if (catch2Match) {
      const total = parseInt(catch2Match[1], 10);
      passed = parseInt(catch2Match[2], 10);
      failed = Math.max(0, total - passed);
      return { passed, failed, total };
    }

    return { passed, failed, total: passed + failed };
  }
}
