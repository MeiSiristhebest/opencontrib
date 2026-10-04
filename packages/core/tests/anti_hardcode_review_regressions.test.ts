import { describe, expect, it } from "bun:test";
import { lintAntiHardcode } from "../src/governance/anti-hardcode.js";

function diff(filePath: string, hunk: string): string {
  return [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    "@@ -1,1 +1,1 @@",
    hunk,
  ].join("\n");
}

describe("anti-hardcode review regressions", () => {
  it("checks runtime files under src/testing while exempting mock and test files", () => {
    expect(
      lintAntiHardcode(
        diff(
          "src/testing/combinatorial-matrix.ts",
          '+if (repo === "org/project") return fallback();',
        ),
      ).isClean,
    ).toBe(false);
    expect(
      lintAntiHardcode(
        diff("src/mocks/repo-fixture.ts", '+if (repo === "org/project") return fallback();'),
      ).isClean,
    ).toBe(true);
  });

  it("recognizes quoted Unicode test paths and extensionless documentation", () => {
    const quotedTestDiff = [
      'diff --git "a/tests/例子 with spaces.ts" "b/tests/例子 with spaces.ts"',
      '--- "a/tests/例子 with spaces.ts"',
      '+++ "b/tests/例子 with spaces.ts"',
      "@@ -1,0 +1,1 @@",
      '+if (repo === "org/project") return fallback();',
    ].join("\n");
    expect(lintAntiHardcode(quotedTestDiff).isClean).toBe(true);
    expect(
      lintAntiHardcode(
        diff("README", '+if (repo === "org/project") return fallback();'),
      ).isClean,
    ).toBe(true);
  });

  it("scans leading plus source lines and comparisons split across added lines", () => {
    const patch = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,0 +1,5 @@",
      '+++attempts; if (repo == "org/project") return fallback();',
      "+if (",
      "+  repo ===",
      '+  "org/other"',
      "+) return fallback();",
    ].join("\n");
    const result = lintAntiHardcode(patch, { targetRepo: "org/project" });
    expect(result.isClean).toBe(false);
    expect(result.violations.some((entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION")).toBe(true);
  });

  it("tracks added interpolation provenance inside a multiline template", () => {
    const patch = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,2 +1,3 @@",
      "+const message = `",
      '+${repo === "org/project" ? "special" : "generic"}',
      "+`;",
    ].join("\n");
    expect(lintAntiHardcode(patch, { targetRepo: "org/project" }).isClean).toBe(false);
  });

  it("seeds comment state from trusted base content before a hunk", () => {
    const filePath = "src/feature.ts";
    const patch = [
      `diff --git a/${filePath} b/${filePath}`,
      `--- a/${filePath}`,
      `+++ b/${filePath}`,
      "@@ -3,2 +3,3 @@",
      "  * Existing documentation.",
      '+ * Example: if (repo === "org/project") return null;',
      "  */",
    ].join("\n");
    const baseFileContents = new Map([
      [filePath, "const ready = true;\n/*\n * Existing documentation.\n */\n"],
    ]);
    expect(lintAntiHardcode(patch, { baseFileContents }).isClean).toBe(true);
  });

  it("does not treat API routes as filesystem paths but flags machine-local homes", () => {
    expect(
      lintAntiHardcode(diff("src/routes.ts", '+const routePath = "/api/users";')).isClean,
    ).toBe(true);
    const result = lintAntiHardcode(
      diff("src/tool.ts", '+const binary = "/Users/alice/project/bin/tool";'),
    );
    expect(result.isClean).toBe(false);
    expect(result.violations.some((entry) => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);
  });

  it("detects block-bodied sample returns in Python and Go", () => {
    const python = [
      "diff --git a/src/feature.py b/src/feature.py",
      "--- a/src/feature.py",
      "+++ b/src/feature.py",
      "@@ -1,0 +1,2 @@",
      '+if input == "test-sample":',
      "+    return canned_result",
    ].join("\n");
    const go = [
      "diff --git a/src/feature.go b/src/feature.go",
      "--- a/src/feature.go",
      "+++ b/src/feature.go",
      "@@ -1,0 +1,3 @@",
      '+if input == "mock-input" {',
      "+    return cannedResult",
      "+}",
    ].join("\n");
    expect(lintAntiHardcode(python).isClean).toBe(false);
    expect(lintAntiHardcode(go).isClean).toBe(false);
  });
});
