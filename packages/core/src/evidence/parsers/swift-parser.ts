import type { ParsedTestCounts, TestOutputParser } from "./types.js";

/** Terminal XCTest and Swift Testing summaries emitted by `swift test`. */
export class SwiftTestOutputParser implements TestOutputParser {
  readonly id = "swift-test";

  supports(output: string): boolean {
    return /Test Suite 'All tests'|Test run with \d+ tests?/.test(output);
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;
    let total = 0;
    const xctest = [...output.matchAll(/^Test Suite 'All tests' (?:passed|failed)[^\n]*\n\s*Executed (\d+) tests?, with (?:(\d+) tests? skipped and )?(\d+) failures?[^\n]*$/gm)].at(-1);
    if (xctest) {
      const count = Number(xctest[1]);
      const skipped = Number(xctest[2] ?? 0);
      const failures = Number(xctest[3]);
      if (failures + skipped > count) return { passed: 0, failed: 0, total: 0 };
      passed += count - skipped - failures;
      failed += failures;
      total += count;
    }
    const swift = [...output.matchAll(/^[^\n]*Test run with (\d+) tests?(?: in \d+ suites?)? (passed|failed) after [\d.]+ seconds[^\n]*$/gm)].at(-1);
    if (swift) {
      const count = Number(swift[1]);
      total += count;
      if (swift[2] === "passed") passed += count;
      // A failing summary counts issues, not failed tests. Do not invent a
      // passed/failed split; the nonzero runner exit still rejects GREEN.
    }
    return { passed, failed, total };
  }
}
