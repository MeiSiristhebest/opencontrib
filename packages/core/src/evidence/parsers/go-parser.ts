import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class GoTestOutputParser implements TestOutputParser {
  readonly id = 'go-test';

  supports(output: string): boolean {
    return (
      output.includes('--- PASS:') ||
      output.includes('--- FAIL:') ||
      output.includes('PASS\n') ||
      output.includes('FAIL\n') ||
      output.includes('ok\t') ||
      output.includes('ok  \t') ||
      /ok\s+\S+\s+[\d\.]+s/.test(output) ||
      /FAIL\s+\S+\s+[\d\.]+s/.test(output)
    );
  }

  parse(output: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    // 1. Precise per-test matching (go test -v)
    const passMatches = output.match(/---\s+PASS:\s+\S+/g);
    if (passMatches) {
      passed += passMatches.length;
    }

    const failMatches = output.match(/---\s+FAIL:\s+\S+/g);
    if (failMatches) {
      failed += failMatches.length;
    }

    // 2. Fallback: package-level summary matching (go test standard)
    if (passed === 0 && failed === 0) {
      const okMatches = output.match(/ok\s+\S+\s+[\d\.]+s/g);
      if (okMatches) {
        passed = okMatches.length;
      }
      const failPkgMatches = output.match(/FAIL\s+\S+\s+[\d\.]+s/g);
      if (failPkgMatches) {
        failed = failPkgMatches.length;
      }
      if (passed === 0 && (output.includes('PASS') || output.includes('ok\t'))) {
        passed = 1;
      }
      if (failed === 0 && (output.includes('FAIL\t') || output.includes('FAIL\n'))) {
        failed = 1;
      }
    }

    return { passed, failed, total: passed + failed };
  }
}
