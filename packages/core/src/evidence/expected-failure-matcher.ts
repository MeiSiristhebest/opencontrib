export interface ExpectedFailureMatch {
  matched: boolean;
  expected?: string;
  observedSnippet?: string;
}

/**
 * Match a trusted RED assertion using one shared syntax across execution
 * backends. Regex is the default contract; literal mode is retained only for
 * callers that explicitly request it.
 */
export function validateExpectedFailurePattern(
  pattern?: string,
): string | undefined {
  if (!pattern || pattern.trim().length === 0) {
    return undefined;
  }

  const cleanPattern = pattern.trim();
  try {
    new RegExp(cleanPattern, "i");
    return cleanPattern;
  } catch (error) {
    throw new Error(
      `INVALID_ASSERTION_PATTERN: InvalidAssertionRegexError: expectedAssertion pattern "${cleanPattern}" is not a valid regular expression. ` +
        `Evidence capture failed closed. Original error: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function matchExpectedFailure(input: {
  output: string;
  pattern?: string;
  mode?: "regex" | "literal";
}): ExpectedFailureMatch {
  const { output, pattern, mode = "regex" } = input;
  if (!pattern || pattern.trim().length === 0) {
    return { matched: true };
  }

  const cleanPattern = pattern.trim();
  if (mode === "literal") {
    return {
      matched: output.includes(cleanPattern),
      expected: cleanPattern,
      observedSnippet: output.slice(0, 500),
    };
  }

  const validatedPattern = validateExpectedFailurePattern(cleanPattern);
  if (!validatedPattern) {
    return { matched: true };
  }
  return {
    matched: new RegExp(validatedPattern, "i").test(output),
    expected: validatedPattern,
    observedSnippet: output.slice(0, 500),
  };
}
