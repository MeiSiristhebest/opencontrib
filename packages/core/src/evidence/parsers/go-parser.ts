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
    output = output.split(/\r?\n/).map(line => {
      if (!line.startsWith("{")) return line;
      try {
        const event = JSON.parse(line);
        return typeof event.Output === "string" ? event.Output : "";
      } catch {
        return "";
      }
    }).join("\n");
    let passed = 0;
    let failed = 0;

    // 1. Precise per-test matching (go test -v)
    const passMatches = output.match(/^\s*---\s+PASS:\s+\S+\s+\([\dhms.]+\)\s*$/gm);
    if (passMatches) {
      passed += passMatches.length;
    }

    const failMatches = output.match(/^\s*---\s+FAIL:\s+\S+\s+\([\dhms.]+\)\s*$/gm);
    if (failMatches) {
      failed += failMatches.length;
    }

    // Package success, cached results and no-test packages do not count tests.

    return { passed, failed, total: passed + failed };
  }
}
