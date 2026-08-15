import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class CargoTestOutputParser implements TestOutputParser {
  readonly id = 'cargo-test';

  supports(output: string): boolean {
    return output.includes('test result:') || /running \d+ test/i.test(output);
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    const cargoPass = output.match(/(\d+)\s+passed/i);
    if (cargoPass) passed = parseInt(cargoPass[1], 10);

    const cargoFail = output.match(/(\d+)\s+failed/i);
    if (cargoFail) failed = parseInt(cargoFail[1], 10);

    return { passed, failed, total: passed + failed };
  }
}
