import type { ParsedTestCounts, TestOutputParser } from './types.js';
import { NodeTestOutputParser } from './node-parser.js';
import { PytestOutputParser } from './pytest-parser.js';
import { GoTestOutputParser } from './go-parser.js';
import { CargoTestOutputParser } from './cargo-parser.js';
import { JavaJunitOutputParser } from './junit-parser.js';
import { CppGTestOutputParser } from './gtest-parser.js';
import { DotnetTestOutputParser } from './dotnet-parser.js';
import { RubyRSpecOutputParser } from './rspec-parser.js';
import { PhpUnitOutputParser } from './phpunit-parser.js';

export class TestOutputParserRegistry {
  private parsers: TestOutputParser[] = [];

  constructor() {
    // Register comprehensive multi-language built-in parsers in priority order
    this.register(new NodeTestOutputParser());
    this.register(new CargoTestOutputParser());
    this.register(new PytestOutputParser());
    this.register(new GoTestOutputParser());
    this.register(new JavaJunitOutputParser());
    this.register(new CppGTestOutputParser());
    this.register(new DotnetTestOutputParser());
    this.register(new RubyRSpecOutputParser());
    this.register(new PhpUnitOutputParser());
  }

  register(parser: TestOutputParser): void {
    // Prepend to allow custom user extension/override
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
