import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class JavaJunitOutputParser implements TestOutputParser {
  readonly id = 'java-junit';

  supports(output: string): boolean {
    return (
      /Tests run:\s*\d+,\s*Failures:\s*\d+/.test(output) ||
      /BUILD SUCCESS/i.test(output) && output.includes('Surefire') ||
      /BUILD SUCCESS/i.test(output) && output.includes('Gradle') ||
      /\d+\s+tests completed,\s*\d+\s+failed/.test(output) ||
      /\[INFO\] Results:/.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;
    let total = 0;

    // 1. Maven Surefire / Failsafe format: "Tests run: 12, Failures: 0, Errors: 0, Skipped: 0"
    const mavenSummaries = [...output.matchAll(/^(?:\[INFO\]\s*)?Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?\s*$/gmi)];
    if (mavenSummaries.length) {
      for (const summary of mavenSummaries) {
        const runs = Number(summary[1]);
        const failures = Number(summary[2]) + Number(summary[3]);
        failed += failures;
        passed += Math.max(0, runs - failures - Number(summary[4] ?? 0));
        total += runs;
      }
      return { passed, failed, total };
    }

    // 2. Gradle test format: "15 tests completed, 0 failed, 0 skipped"
    for (const summary of output.matchAll(/^(\d+)\s+tests completed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?\s*$/gmi)) {
      total += Number(summary[1]);
      failed += Number(summary[2]);
      passed += Math.max(0, Number(summary[1]) - Number(summary[2]) - Number(summary[3] ?? 0));
    }

    return { passed, failed, total };
  }
}
