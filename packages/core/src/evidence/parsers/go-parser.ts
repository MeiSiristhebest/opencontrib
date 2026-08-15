import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class GoTestOutputParser implements TestOutputParser {
  readonly id = 'go-test';

  supports(output: string): boolean {
    return (
      output.includes('PASS') ||
      output.includes('ok\t') ||
      output.includes('ok  \t') ||
      output.includes('FAIL\t') ||
      /ok\s+\S+\s+[\d\.]+s/.test(output) ||
      /FAIL\s+\S+\s+[\d\.]+s/.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    if (output.includes('PASS') || output.includes('ok\t') || output.includes('ok  \t') || /ok\s+\S+\s+[\d\.]+s/.test(output)) {
      passed = 1;
    }
    if (output.includes('FAIL\t') || output.includes('FAIL\n') || /FAIL\s+\S+\s+[\d\.]+s/.test(output)) {
      failed = 1;
    }

    return { passed, failed, total: passed + failed };
  }
}
