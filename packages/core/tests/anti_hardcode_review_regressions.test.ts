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
    expect(
      lintAntiHardcode(
        diff("src/readme.js", '+if (repo === "org/project") return fallback();'),
      ).isClean,
    ).toBe(false);
    expect(
      lintAntiHardcode(
        diff("src/README.md", '+if (repo === "org/project") return fallback();'),
      ).isClean,
    ).toBe(true);
  });

  it("ignores SQL and Lua line-comment examples", () => {
    for (const filePath of ["src/example.sql", "src/example.lua"]) {
      const result = lintAntiHardcode(
        diff(filePath, '+-- if repository == "owner/repo" this is an example'),
        { targetRepo: "owner/repo" },
      );

      expect(result.isClean).toBe(true);
    }
  });

  it("recognizes Python, Rust, and C++ prefixed repository strings", () => {
    const examples = [
      ["src/feature.py", '+if repo == r"owner/repo": return fallback()'],
      ["src/feature.rs", '+if repo == r#"owner/repo"# { return fallback(); }'],
      ["src/feature.cpp", '+if (repo == R"(owner/repo)") return fallback();'],
    ] as const;

    for (const [filePath, addedLine] of examples) {
      const result = lintAntiHardcode(diff(filePath, addedLine), {
        targetRepo: "owner/repo",
      });

      expect(result.violations.some(
        (entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION",
      )).toBe(true);
    }
  });

  it("scans leading plus source lines and comparisons split across added lines", () => {
    const leadingPlusComparison = diff(
      "src/feature.ts",
      '++attempts; if (repo === "org/project") return fallback();',
    );
    const leadingPlusResult = lintAntiHardcode(leadingPlusComparison, {
      targetRepo: "org/project",
    });
    expect(leadingPlusResult.violations).toHaveLength(1);
    expect(leadingPlusResult.violations[0]?.rule).toBe(
      "REPO_LITERAL_DISCRIMINATION",
    );

    const patch = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,0 +1,5 @@",
      "+++attempts;",
      "+if (",
      "+  repo ===",
      '+  "org/other"',
      "+) return fallback();",
    ].join("\n");
    const result = lintAntiHardcode(patch, { targetRepo: "org/project" });
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.rule).toBe("REPO_LITERAL_DISCRIMINATION");
  });

  it("detects reversed sample guards and returns added beneath unchanged guards", () => {
    const reversedGuard = diff(
      "src/feature.ts",
      '+if ("test-sample" === input) return cannedResult;',
    );
    expect(
      lintAntiHardcode(reversedGuard).violations.some(
        (entry) => entry.rule === "TEST_SAMPLE_SHORT_CIRCUIT",
      ),
    ).toBe(true);

    const returnAddedToExistingGuard = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,2 +1,3 @@",
      ' if (input === "test-sample") {',
      "+  return cannedResult;",
      " }",
    ].join("\n");
    expect(
      lintAntiHardcode(returnAddedToExistingGuard).violations.some(
        (entry) => entry.rule === "TEST_SAMPLE_SHORT_CIRCUIT",
      ),
    ).toBe(true);
  });

  it("detects Python elif sample guards with unchanged returns", () => {
    const pythonElif = diff(
      "src/feature.py",
      '+elif input == "test-sample": return canned_result',
    );
    const addedGuard = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1,3 +1,4 @@",
      "+if (input === \"test-sample\") {",
      " return cannedResult;",
      " }",
      " return computeResult(input);",
    ].join("\n");

    expect(
      lintAntiHardcode(pythonElif).violations.some(
        (entry) => entry.rule === "TEST_SAMPLE_SHORT_CIRCUIT",
      ),
    ).toBe(true);
    expect(
      lintAntiHardcode(addedGuard).violations.some(
        (entry) => entry.rule === "TEST_SAMPLE_SHORT_CIRCUIT",
      ),
    ).toBe(true);
  });

  it("scans code after C++ raw delimiters preceded by backslashes", () => {
    const patch = diff(
      "src/feature.cpp",
      '+auto example = R"tag(payload \\)tag"; if (repo == "owner/repo") return fallback();',
    );
    const result = lintAntiHardcode(patch, { targetRepo: "owner/repo" });

    expect(
      result.violations.some((entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION"),
    ).toBe(true);
  });

  it("scans executable Python f-string expressions", () => {
    const patch = diff(
      "src/feature.py",
      '+message = f"{special() if repo == \'owner/repo\' else normal()}"',
    );
    const result = lintAntiHardcode(patch, { targetRepo: "owner/repo" });
    expect(result.violations.some((entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION")).toBe(
      true,
    );
  });

  it("resets lexer state between unseeded hunks and tolerates short base content", () => {
    const multipleHunks = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -1 +1 @@",
      "+/*",
      "@@ -10 +10 @@",
      '+if (repo === "org/project") return fallback();',
    ].join("\n");
    expect(
      lintAntiHardcode(multipleHunks).violations.some(
        (entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION",
      ),
    ).toBe(true);

    const staleBasePatch = [
      "diff --git a/src/feature.ts b/src/feature.ts",
      "--- a/src/feature.ts",
      "+++ b/src/feature.ts",
      "@@ -5,0 +5,1 @@",
      "+const ready = true;",
    ].join("\n");
    expect(() =>
      lintAntiHardcode(staleBasePatch, {
        baseFileContents: new Map([["src/feature.ts", "short file"]]),
      }),
    ).not.toThrow();
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

  it("does not classify web route literals as filesystem paths", () => {
    const result = lintAntiHardcode(
      diff(
        "src/routes.tsx",
        '+<Route path="/home" element={<Home />} />',
      ),
    );

    expect(result.isClean).toBe(true);

    const routeObject = lintAntiHardcode(
      diff("src/routes.ts", '+const route = { path: "/home" };'),
    );
    expect(routeObject.isClean).toBe(true);
  });

  it("scans Vue, Svelte, and GitHub Action source files", () => {
    const fixtures = [
      ["src/App.vue", '+<script>if (repo === "owner/repo") return fallback();</script>'],
      ["src/App.svelte", '+<script>if (repo === "owner/repo") return fallback();</script>'],
      [".github/actions/check/index.js", '+if (repo === "owner/repo") return fallback();'],
    ] as const;

    for (const [filePath, addedLine] of fixtures) {
      const result = lintAntiHardcode(
        diff(filePath, addedLine),
      );

      expect(result.violations.some(
        (entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION",
      )).toBe(true);
    }

    expect(
      lintAntiHardcode(
        diff(
          "src/App.vue",
          '+<!-- if (repo === "owner/repo") return fallback(); -->',
        ),
        { targetRepo: "owner/repo" },
      ).isClean,
    ).toBe(true);
  });

  it("keeps Rust lifetimes and Kotlin raw strings from hiding later code", () => {
    const rust = [
      "diff --git a/src/feature.rs b/src/feature.rs",
      "--- a/src/feature.rs",
      "+++ b/src/feature.rs",
      "@@ -1,0 +1,3 @@",
      "+fn route(repo: &'static str) {",
      '+  if repo == "owner/repo" { return; }',
      "+}",
    ].join("\n");
    const kotlin = [
      "diff --git a/src/Feature.kt b/src/Feature.kt",
      "--- a/src/Feature.kt",
      "+++ b/src/Feature.kt",
      "@@ -1,0 +1,3 @@",
      '+val example = """unmatched " quote"""',
      '+if (repo == "owner/repo") return fallback()',
      "+println(example)",
    ].join("\n");

    for (const patch of [rust, kotlin]) {
      const result = lintAntiHardcode(patch, { targetRepo: "owner/repo" });

      expect(result.violations.some(
        (entry) => entry.rule === "REPO_LITERAL_DISCRIMINATION",
      )).toBe(true);
    }
  });

  it("does not parse Go raw strings as interpolated templates", () => {
    const result = lintAntiHardcode(
      diff("src/example.go", '+message := `example ${repo == "owner/repo"}`'),
      { targetRepo: "owner/repo" },
    );

    expect(result.isClean).toBe(true);
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
