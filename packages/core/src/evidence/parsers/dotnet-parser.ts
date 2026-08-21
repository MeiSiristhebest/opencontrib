import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class DotnetTestOutputParser implements TestOutputParser {
  readonly id = 'dotnet-test';

  supports(output: string): boolean {
    return (
      /Passed!\s+-\s+Failed:\s*\d+,\s*Passed:\s*\d+/i.test(output) ||
      /Failed!\s+-\s+Failed:\s*\d+,\s*Passed:\s*\d+/i.test(output) ||
      /Total tests:\s*\d+\.\s*Passed:\s*\d+/i.test(output) ||
      /Passed:\s*\d+,\s*Failed:\s*\d+,\s*Skipped:\s*\d+,\s*Total:\s*\d+/i.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;
    let total = 0;

    // Format 1: "Passed!  - Failed:     0, Passed:    18, Skipped:     0, Total:    18"
    const match1 = output.match(/Failed:\s*(\d+),\s*Passed:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?,\s*Total:\s*(\d+)/i);
    if (match1) {
      failed = parseInt(match1[1], 10);
      passed = parseInt(match1[2], 10);
      total = parseInt(match1[4], 10);
      return { passed, failed, total };
    }

    // Format 2: "Total tests: 12. Passed: 12. Failed: 0."
    const match2 = output.match(/Total tests:\s*(\d+)\.\s*Passed:\s*(\d+)\.\s*Failed:\s*(\d+)/i);
    if (match2) {
      total = parseInt(match2[1], 10);
      passed = parseInt(match2[2], 10);
      failed = parseInt(match2[3], 10);
      return { passed, failed, total };
    }

    return { passed, failed, total: passed + failed };
  }
}
