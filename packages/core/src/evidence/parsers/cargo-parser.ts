import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class CargoTestOutputParser implements TestOutputParser {
  readonly id = 'cargo-test';

  supports(output: string): boolean {
    return output.includes('test result:') || /running \d+ test/i.test(output);
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    for (const summary of output.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed;/gm)) {
      passed += Number(summary[1]);
      failed += Number(summary[2]);
    }

    return { passed, failed, total: passed + failed };
  }
}
