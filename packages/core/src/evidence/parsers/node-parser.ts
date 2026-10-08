import type { ParsedTestCounts, TestOutputParser } from './types.js';

export class NodeTestOutputParser implements TestOutputParser {
  readonly id = 'node-jest-vitest-bun';

  supports(output: string): boolean {
    return /^Ran \d+ tests? across /m.test(output) || /^\s*Tests:?\s+/m.test(output) ||
      /^(?:#|ℹ)\s+(?:pass|fail)\s+\d+\s*$/m.test(output) || /^\s*\d+ passing \(/m.test(output);
  }

  parse(output: string, runner?: string): ParsedTestCounts {
    let passed = 0;
    let failed = 0;

    const last = (pattern: RegExp, text = output) => [...text.matchAll(pattern)].at(-1);
    const bun = !runner || runner === "bun" ? last(/^Ran (\d+) tests? across .+$/gm) : undefined;
    if (bun) {
      const summary = output.slice(0, bun.index);
      passed = Number(last(/^\s*(\d+) pass\s*$/gm, summary)?.[1] ?? 0);
      failed = Number(last(/^\s*(\d+) fail\s*$/gm, summary)?.[1] ?? 0);
      if (passed + failed > Number(bun[1])) return { passed: 0, failed: 0, total: 0 };
    } else {
      if (runner === "bun") return { passed: 0, failed: 0, total: 0 };
      const tapPass = !runner || runner === "node" ? last(/^(?:#|ℹ)\s+pass\s+(\d+)\s*$/gm) : undefined;
      const tapFail = !runner || runner === "node" ? last(/^(?:#|ℹ)\s+fail\s+(\d+)\s*$/gm) : undefined;
      if (tapPass && tapFail) {
        passed = Number(tapPass[1]);
        failed = Number(tapFail[1]);
        const total = last(/^(?:#|ℹ)\s+tests\s+(\d+)\s*$/gm);
        if (!total || passed + failed > Number(total[1])) return { passed: 0, failed: 0, total: 0 };
      } else {
        if (runner === "node") return { passed: 0, failed: 0, total: 0 };
        const summary = !runner || runner === "jest" || runner === "vitest" ? last(/^\s*Tests:?\s+(.+)$/gm)?.[1] : undefined;
        if (summary) {
          passed = Number(/(\d+) passed/.exec(summary)?.[1] ?? 0);
          failed = Number(/(\d+) failed/.exec(summary)?.[1] ?? 0);
        } else if (!runner || runner === "mocha") {
          passed = Number(last(/^\s*(\d+) passing \([^)]+\)\s*$/gm)?.[1] ?? 0);
          failed = Number(last(/^\s*(\d+) failing\s*$/gm)?.[1] ?? 0);
        }
      }
    }

    return { passed, failed, total: passed + failed };
  }
}
