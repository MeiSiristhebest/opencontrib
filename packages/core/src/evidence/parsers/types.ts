export interface ParsedTestCounts {
  passed: number;
  failed: number;
  total: number;
}

export interface TestOutputParser {
  readonly id: string;
  supports(output: string): boolean;
  parse(output: string): ParsedTestCounts;
}
