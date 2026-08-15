import type { ParsedTestCounts, TestOutputParser } from './types.js';
import { NodeTestOutputParser } from './node-parser.js';
import { PytestOutputParser } from './pytest-parser.js';
import { GoTestOutputParser } from './go-parser.js';
import { CargoTestOutputParser } from './cargo-parser.js';

export class TestOutputParserRegistry {
  private parsers: TestOutputParser[] = [];

  constructor() {
    // Register default built-in parsers in priority order
    this.register(new NodeTestOutputParser());
    this.register(new CargoTestOutputParser());
    this.register(new PytestOutputParser());
    this.register(new GoTestOutputParser());
  }

  register(parser: TestOutputParser): void {
    // Prepend or push to allow user extension/override
    this.parsers.unshift(parser);
  }

  getParsers(): readonly TestOutputParser[] {
    return this.parsers;
  }

  parse(output: string): ParsedTestCounts {
    if (!output || typeof output !== 'string') {
      return { passed: 0, failed: 0, total: 0 };
    }

    for (const parser of this.parsers) {
      if (parser.supports(output)) {
        const counts = parser.parse(output);
        if (counts.total > 0) {
          return counts;
        }
      }
    }

    return { passed: 0, failed: 0, total: 0 };
  }
}

export const defaultTestOutputParserRegistry = new TestOutputParserRegistry();
