import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class PhpUnitOutputParser implements TestOutputParser {
  readonly id = 'php-phpunit';

  supports(output: string): boolean {
    return (
      /OK\s*\(\d+\s*tests?,\s*\d+\s*assertions?\)/i.test(output) ||
      /FAILURES!\s*Tests:\s*\d+,\s*Assertions:\s*\d+/i.test(output) ||
      /ERRORS!\s*Tests:\s*\d+,\s*Assertions:\s*\d+/i.test(output) ||
      /Tests:\s*\d+,\s*Assertions:\s*\d+/i.test(output) ||
      /PASS\s+Tests\\/i.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;
    let total = 0;

    // 1. Success format: "OK (14 tests, 28 assertions)"
    const okMatch = output.match(/OK\s*\(\s*(\d+)\s*tests?/i);
    if (okMatch) {
      passed = parseInt(okMatch[1], 10);
      total = passed;
      return { passed, failed: 0, total };
    }

    // 2. Failure format: "FAILURES! Tests: 14, Assertions: 20, Failures: 2, Errors: 1."
    const failMatch = output.match(/Tests:\s*(\d+).*?Failures:\s*(\d+)(?:,\s*Errors:\s*(\d+))?/i);
    if (failMatch) {
      total = parseInt(failMatch[1], 10);
      const failures = parseInt(failMatch[2], 10);
      const errors = failMatch[3] ? parseInt(failMatch[3], 10) : 0;
      failed = failures + errors;
      passed = Math.max(0, total - failed);
      return { passed, failed, total };
    }

    return { passed, failed, total: passed + failed };
  }
}
