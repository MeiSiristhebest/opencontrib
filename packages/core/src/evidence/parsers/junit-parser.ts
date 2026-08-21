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
    const mavenMatch = output.match(/Tests run:\s*(\d+),\s*Failures:\s*(\d+),\s*Errors:\s*(\d+)(?:,\s*Skipped:\s*(\d+))?/i);
    if (mavenMatch) {
      const runs = parseInt(mavenMatch[1], 10);
      const failures = parseInt(mavenMatch[2], 10);
      const errors = parseInt(mavenMatch[3], 10);
      failed = failures + errors;
      passed = Math.max(0, runs - failed);
      total = runs;
      return { passed, failed, total };
    }

    // 2. Gradle test format: "15 tests completed, 0 failed, 0 skipped"
    const gradleMatch = output.match(/(\d+)\s+tests completed,\s*(\d+)\s+failed(?:,\s*(\d+)\s+skipped)?/i);
    if (gradleMatch) {
      total = parseInt(gradleMatch[1], 10);
      failed = parseInt(gradleMatch[2], 10);
      passed = Math.max(0, total - failed);
      return { passed, failed, total };
    }

    if (/BUILD SUCCESS/i.test(output)) {
      passed = 1;
      total = 1;
    } else if (/BUILD FAILURE/i.test(output)) {
      failed = 1;
      total = 1;
    }

    return { passed, failed, total };
  }
}
