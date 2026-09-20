import { describe, expect, test } from "bun:test";
import { matchExpectedFailure } from "../src/evidence/expected-failure-matcher.js";

describe("matchExpectedFailure — fail-closed regex assertion (P0-04)", () => {
  test("returns matched:true for empty/undefined pattern (backward compat)", () => {
    expect(matchExpectedFailure({ output: "anything" })).toEqual({
      matched: true,
    });
    expect(matchExpectedFailure({ output: "anything", pattern: "" })).toEqual({
      matched: true,
    });
    expect(
      matchExpectedFailure({ output: "anything", pattern: undefined }),
    ).toEqual({ matched: true });
  });

  test("matches valid regex against matching output", () => {
    const r = matchExpectedFailure({
      output: "err123 something went wrong",
      pattern: "err\\d+",
    });
    expect(r.matched).toBe(true);
    expect(r.expected).toBe("err\\d+");
    expect(r.observedSnippet).toBeDefined();
  });

  test("rejects non-matching regex", () => {
    const r = matchExpectedFailure({
      output: "all tests passed successfully",
      pattern: "assertion.?failed",
    });
    expect(r.matched).toBe(false);
  });

  test("throws InvalidAssertionRegexError on invalid regex pattern", () => {
    expect(() =>
      matchExpectedFailure({
        output: "some output",
        pattern: "[invalid(",
      }),
    ).toThrow(/InvalidAssertionRegexError/);
    expect(() =>
      matchExpectedFailure({
        output: "some output",
        pattern: "(unclosed paren",
      }),
    ).toThrow(/InvalidAssertionRegexError/);
  });

  test("error message includes the invalid pattern and original error", () => {
    let err: Error | undefined;
    try {
      matchExpectedFailure({
        output: "some output",
        pattern: "[invalid(",
      });
    } catch (e: any) {
      err = e;
    }
    expect(err).toBeDefined();
    expect(err!.message).toContain("[invalid(");
    expect(err!.message).toContain("INVALID_ASSERTION_PATTERN");
    expect(err!.message).toContain("Evidence capture failed closed");
  });

  test("literal mode uses substring search, ignores regex semantics", () => {
    const r = matchExpectedFailure({
      output: "err123 foo err456",
      pattern: "err\\d+",
      mode: "literal",
    });
    // In literal mode, the backslash is treated as a literal character
    expect(r.matched).toBe(false);
  });

  test("case-insensitive flag is applied by default", () => {
    const r = matchExpectedFailure({
      output: "ERROR: something broke",
      pattern: "error",
    });
    expect(r.matched).toBe(true);
  });
});

describe("captureRedEvidence — propagates InvalidAssertionRegexError (P0-04)", () => {
  test("throws when expectedAssertion is an invalid regex", () => {
    const {
      captureRedEvidence,
    } = require("../src/evidence/evidence-collector.js");
    expect(() =>
      captureRedEvidence({
        cwd: process.cwd(),
        testCommand: "echo FAIL",
        expectedAssertion: "[invalid(",
      }),
    ).toThrow(/InvalidAssertionRegexError/);
  });
});
