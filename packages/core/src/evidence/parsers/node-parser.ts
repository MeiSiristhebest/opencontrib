import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class NodeTestOutputParser implements TestOutputParser {
  readonly id = 'node-jest-vitest-bun';

  supports(output: string): boolean {
    return (
      /(\d+)\s+(?:pass|passed)/i.test(output) ||
      /(\d+)\s+(?:fail|failed)/i.test(output) ||
      /Tests:\s+\d+\s+passed/i.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    // Bun / Vitest / Jest: e.g. "31 pass, 0 fail" or "31 passed, 0 failed" or "Tests: 2 passed, 2 total"
    const passMatch = output.match(/(\d+)\s+(?:pass|passed)/i);
    if (passMatch) passed = parseInt(passMatch[1], 10);

    const failMatch = output.match(/(\d+)\s+(?:fail|failed)/i);
    if (failMatch) failed = parseInt(failMatch[1], 10);

    return { passed, failed, total: passed + failed };
  }
}
