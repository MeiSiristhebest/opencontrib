import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class RubyRSpecOutputParser implements TestOutputParser {
  readonly id = 'ruby-rspec';

  supports(output: string): boolean {
    return (
      /\d+\s+examples?,\s*\d+\s+failures?/i.test(output) ||
      /\d+\s+runs?,\s*\d+\s+assertions?,\s*\d+\s+failures?,\s*\d+\s+errors?/i.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;
    let total = 0;

    // RSpec: "14 examples, 0 failures, 1 pending"
    const rspecMatch = output.match(/(\d+)\s+examples?,\s*(\d+)\s+failures?(?:,\s*(\d+)\s+pending)?/i);
    if (rspecMatch) {
      total = parseInt(rspecMatch[1], 10);
      failed = parseInt(rspecMatch[2], 10);
      passed = Math.max(0, total - failed);
      return { passed, failed, total };
    }

    // Minitest: "10 runs, 25 assertions, 0 failures, 0 errors, 0 skips"
    const minitestMatch = output.match(/(\d+)\s+runs?,\s*\d+\s+assertions?,\s*(\d+)\s+failures?,\s*(\d+)\s+errors?/i);
    if (minitestMatch) {
      total = parseInt(minitestMatch[1], 10);
      failed = parseInt(minitestMatch[2], 10) + parseInt(minitestMatch[3], 10);
      passed = Math.max(0, total - failed);
      return { passed, failed, total };
    }

    return { passed, failed, total: passed + failed };
  }
}
