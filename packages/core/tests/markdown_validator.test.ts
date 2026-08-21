import { describe, expect, it } from 'bun:test';
import { validateMarkdownIntegrity } from '../src/governance/markdown-validator.js';

describe('Industrial Markdown Integrity & Validation Engine (5-Layer / 16-Pattern Matrix)', () => {
  it('detects Layer 1 Encoding & Character Set flaws (ENC-01..03)', () => {
    // ENC-01: Unicode replacement char \uFFFD
    const report1 = validateMarkdownIntegrity('### Title\nNormal text with \uFFFD corruption.');
    expect(report1.isValid).toBe(false);
    expect(report1.errors.some((e) => e.ruleId === 'ENC-01')).toBe(true);

    // ENC-02: ANSI escape sequences
    const report2 = validateMarkdownIntegrity('### Title\n\x1b[32mSuccess\x1b[0m output.');
    expect(report2.isValid).toBe(false);
    expect(report2.errors.some((e) => e.ruleId === 'ENC-02')).toBe(true);

    // ENC-03: Non-printable control characters
    const report3 = validateMarkdownIntegrity('### Title\nText with binary \x07 bell.');
    expect(report3.isValid).toBe(false);
    expect(report3.errors.some((e) => e.ruleId === 'ENC-03')).toBe(true);
  });

  it('detects Layer 2 AST Structural Integrity flaws (AST-01..03)', () => {
    // AST-01: Unclosed code block (odd fences)
    const report1 = validateMarkdownIntegrity('### Header\n```ts\nconst a = 1;\n');
    expect(report1.isValid).toBe(false);
    expect(report1.errors.some((e) => e.ruleId === 'AST-01')).toBe(true);

    // AST-02: Numbered header artifact (e.g. 3##) & Missing space after hash
    const report2 = validateMarkdownIntegrity('3## Key Changes\n\n###MissingSpace\n');
    expect(report2.isValid).toBe(false);
    expect(report2.errors.filter((e) => e.ruleId === 'AST-02').length).toBe(2);

    // AST-03: GFM table without delimiter row
    const report3 = validateMarkdownIntegrity('| Col 1 | Col 2 |\n| Row 1 | Row 2 |\n');
    expect(report3.isValid).toBe(false);
    expect(report3.errors.some((e) => e.ruleId === 'AST-03')).toBe(true);
  });

  it('detects Layer 3 HTML Tag Balancing and Whitelist flaws (HTM-01..02)', () => {
    // HTM-01: Unclosed paired tag
    const report1 = validateMarkdownIntegrity('<div align="center">\n# Title\n');
    expect(report1.isValid).toBe(false);
    expect(report1.errors.some((e) => e.ruleId === 'HTM-01')).toBe(true);

    // HTM-02: Disallowed tag
    const report2 = validateMarkdownIntegrity('<script>alert(1)</script>');
    expect(report2.isValid).toBe(false);
    expect(report2.errors.some((e) => e.ruleId === 'HTM-02')).toBe(true);

    // Properly closed tag should pass
    const report3 = validateMarkdownIntegrity('<div align="center">\n# Title\n</div>');
    expect(report3.isValid).toBe(true);
  });

  it('detects Layer 4 Link Syntax flaws (LNK-01..02)', () => {
    // LNK-01: Reversed link syntax (text)[url]
    const report1 = validateMarkdownIntegrity('(Click here)[https://github.com]');
    expect(report1.isValid).toBe(false);
    expect(report1.errors.some((e) => e.ruleId === 'LNK-01')).toBe(true);

    // LNK-02: Empty destination link
    const report2 = validateMarkdownIntegrity('[Click here]()');
    expect(report2.warningCount).toBeGreaterThan(0);
    expect(report2.errors.some((e) => e.ruleId === 'LNK-02')).toBe(true);
  });

  it('detects Layer 5 Script Execution and Template Token Leakage (SRC-01..03)', () => {
    // SRC-01: Raw Buffer or node -e command leaked in body
    const report1 = validateMarkdownIntegrity('```\n```\nBuffer.from("IyMjIFByb2JsZW0gRGVzY3JpcHRpb24KRml4ZXMgIzExMDYKCkluIG")');
    expect(report1.isValid).toBe(false);
    expect(report1.errors.some((e) => e.ruleId === 'SRC-01')).toBe(true);

    // SRC-03: Unfilled template placeholder token
    const report2 = validateMarkdownIntegrity('### Description\n<INSERT_REPRODUCTION_COMMAND_HERE>');
    expect(report2.warningCount).toBeGreaterThan(0);
    expect(report2.errors.some((e) => e.ruleId === 'SRC-03')).toBe(true);
  });

  it('passes 100% on clean, professional, fully-formed Markdown PR documents', () => {
    const validPr = `
# Fix IPv6 Bracket Normalization in GitSourceFetcher

Fixes #1106

## Problem Description
WHATWG URL parsing preserves brackets on IPv6 hostnames (e.g. \`[::1]\`), which bypassed the private IP address regular expression.

## Key Changes
- Strip leading and trailing brackets before checking against \`PRIVATE_ADDR_RE\`.
- Normalize IPv4-mapped IPv6 representations.

## Verification
| Test Suite | Result | Duration |
| :--- | :---: | :--- |
| \`git-fetcher.test.ts\` | PASS | 14ms |

\`\`\`bash
bun test src/source-fetcher/git-fetcher.test.ts
\`\`\`
`;
    const report = validateMarkdownIntegrity(validPr);
    expect(report.isValid).toBe(true);
    expect(report.fatalCount).toBe(0);
    expect(report.errors.length).toBe(0);
  });
});
