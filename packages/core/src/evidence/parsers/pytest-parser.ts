import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class PytestOutputParser implements TestOutputParser {
  readonly id = 'pytest';

  supports(output: string): boolean {
    return /\d+\s+passed/i.test(output) && /\d+\s+failed/i.test(output) || /===+.*passed.*===+/i.test(output) || /\d+\s+passed in [\d\.]+s/i.test(output);
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    const pytestPass = output.match(/(\d+)\s+passed/i);
    if (pytestPass) passed = parseInt(pytestPass[1], 10);

    const pytestFail = output.match(/(\d+)\s+failed/i);
    if (pytestFail) failed = parseInt(pytestFail[1], 10);

    return { passed, failed, total: passed + failed };
  }
}
