import { describe, expect, it } from "bun:test";
import { lintAntiHardcode } from "../src/governance/anti-hardcode.js";

function patch(file: string, code: string): string {
  const lines = code.split("\n");
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`,
    `@@ -0,0 +1,${lines.length} @@`, ...lines.map(line => `+${line}`)].join("\n");
}

function detectsRepo(file: string, code: string): boolean {
  return lintAntiHardcode(patch(file, code), { targetRepo: "owner/repo" })
    .violations.some(entry => entry.rule === "REPO_LITERAL_DISCRIMINATION");
}

function detectsIssueNumber(file: string, code: string): boolean {
  return lintAntiHardcode(patch(file, code), { issueNumber: 123 }).violations
    .some(entry => entry.rule === "ISSUE_NUMBER_HARDCODING");
}

function changesMiddleLinePatch(file: string, firstLine: string, oldLine: string, newLine: string, lastLine: string): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -1,3 +1,3 @@",
    ` ${firstLine}`,
    `-${oldLine}`,
    `+${newLine}`,
    ` ${lastLine}`,
  ].join("\n");
}

describe("Repository literal review regressions", () => {
  it.each([
    'if (repository.fullName === "owner/repo") return special();',
    'if (repo.toLowerCase() === "owner/repo") return special();',
    'if (repository.fullName.trim().toLowerCase() === "owner/repo") return special();',
    'if ("owner/repo" === repository.fullName) return special();',
    'if (repository.fullName.includes("owner/repo")) return special();',
  ])("detects repository access and normalization: %s", code => {
    expect(detectsRepo("src/main.ts", code)).toBe(true);
  });

  it.each([
    String.raw`if (repo === "owner\/repo") return special();`,
    String.raw`if (repo === "owner\u002frepo") return special();`,
    String.raw`if (repo === "\x6fwner/repo") return special();`,
    String.raw`if (repo === "owner\u{2f}repo") return special();`,
  ])("decodes JavaScript repository literals: %s", code => {
    expect(detectsRepo("src/main.ts", code)).toBe(true);
  });

  it.each([
    ['src/main.kt', 'val text = "${repo == "owner/repo"}"'],
    ['src/main.kts', 'val text = """${repo == "owner/repo"}"""'],
    ['src/main.kt', 'val text = """\\${repo == "owner/repo"}"""'],
    ['src/main.kt', 'val text = """line one\n${repo == "owner/repo"}\nlast line"""'],
    ['src/App.vue', '<template><div v-if="repo === \'owner/repo\'" /></template>'],
    ['src/App.vue', '<div :hidden="repository.fullName === \'owner/repo\'" />'],
    ['src/App.vue', '<div @click="repo === \'owner/repo\' ? special() : normal()" />'],
    ['src/main.ts', 'switch (repo) { case "owner/repo": return special(); }'],
    ['src/main.ts', 'switch (repository.fullName.toLowerCase()) { case "owner/repo": return special(); }'],
    ['src/main.rs', 'match repo { "owner/repo" => special(), _ => normal() }'],
    ['src/main.kt', 'when (repo) { "owner/repo" -> special() }'],
  ])("scans executable expressions in %s: %s", (file, code) => {
    expect(detectsRepo(file, code)).toBe(true);
  });

  it.each([
    ["src/main.cs", String.raw`var text = $"value: {repo == "owner/repo"}";`],
    ["src/main.cs", String.raw`var text = $@"quoted ""label"" {repo == "owner/repo"}";`],
    ["src/main.swift", String.raw`let text = "value: \(repo == "owner/repo")"`],
  ])("scans C# and Swift interpolation expressions in %s", (file, code) => {
    expect(detectsRepo(file, code)).toBe(true);
  });

  it.each([
    ["src/main.cs", String.raw`var text = $"literal {{repo == \"owner/repo\"}}";`],
    ["src/main.swift", String.raw`let text = "literal \\(repo == \"owner/repo\")"`],
  ])("does not scan escaped interpolation markers as code in %s", (file, code) => {
    expect(detectsRepo(file, code)).toBe(false);
  });

  it.each([
    ['src/main.go', 'help := `${repo == "owner/repo"}`'],
    ['src/main.kt', String.raw`val text = "\${repo == \"owner/repo\"}"`],
    ['src/main.py', String.raw`if repo == r"owner\u002frepo": pass`],
    ['src/main.rs', String.raw`if repo == r"owner\u002frepo" { special(); }`],
    ['src/main.sql', String.raw`SELECT CASE WHEN repo = 'owner\u002frepo' THEN 1 ELSE 0 END`],
    ['src/main.rb', String.raw`special() if repo == 'owner\u002frepo'`],
    ['src/App.vue', '<div title="repo === \'owner/repo\'" />'],
    ['src/App.vue', '<!-- <div v-if="repo === \'owner/repo\'" /> -->'],
    ['src/main.ts', 'switch (command) { case "owner/repo": return special(); }'],
    ['src/main.ts', 'switch (repo) { default: break; } switch (command) { case "owner/repo": return special(); }'],
    ['src/main.ts', 'if (config.fullName === "owner/repo") return special();'],
  ])("keeps inert or unrelated source clean in %s", (file, code) => {
    expect(detectsRepo(file, code)).toBe(false);
  });

  it("distinguishes SQL assignments from repository comparisons and recognizes <>", () => {
    expect(
      detectsRepo("db/migration.sql", "UPDATE repositories SET repo = 'owner/repo';"),
    ).toBe(false);
    expect(
      detectsRepo("db/check.sql", "SELECT * FROM repositories WHERE repo <> 'owner/repo';"),
    ).toBe(true);
  });

  it("does not count unrelated hardcode rules as issue-number findings", () => {
    expect(
      detectsIssueNumber(
        "src/main.ts",
        String.raw`const binary = "C:\Users\Mei\Downloads\tool.exe";`,
      ),
    ).toBe(false);
  });

  it.each([
    ["src/main.ts", "switch (issueNumber) { case 123: return workaround(); }"],
    ["src/main.kt", "when (issueNumber) { 123 -> workaround() }"],
    ["src/main.rs", "match issue_number { 123 => workaround(), _ => normal() }"],
  ])("detects provider-bound issue-number dispatch in %s", (file, code) => {
    expect(detectsIssueNumber(file, code)).toBe(true);
  });

  it.each(["Dockerfile", "Makefile", "Containerfile", "GNUmakefile"])(
    "ignores hash comments in %s",
    file => {
      expect(detectsRepo(file, '# Example: if repo == "owner/repo"')).toBe(false);
    },
  );

  it("ignores Dockerfile comments after shell whitespace", () => {
    expect(
      detectsRepo("Dockerfile", 'RUN echo ready # if repo == "owner/repo"'),
    ).toBe(false);
  });

  it("preserves hash tokens inside Dockerfile RUN commands", () => {
    expect(
      detectsRepo(
        "Dockerfile",
        'RUN printf foo#bar && if (repo === "owner/repo") return special();',
      ),
    ).toBe(true);
  });

  it.each([
    ["src/routes.ts", `router.get("/system", handler);`],
    ["src/Controller.java", `@GetMapping("/system")\nvoid status() {}`],
    ["src/Controller.java", `@RequestMapping(path = "/system")\nvoid status() {}`],
  ])("allows positional web route paths in %s", (file, code) => {
    expect(
      lintAntiHardcode(patch(file, code)).violations.some(
        entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH",
      ),
    ).toBe(false);
  });

  it("continues to flag absolute environment paths outside route declarations", () => {
    expect(
      lintAntiHardcode(patch("src/config.ts", `const backup = "/system/secrets";`)).violations.some(
        entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH",
      ),
    ).toBe(true);
  });

  it("skips quotes inside JavaScript regular-expression literals", () => {
    expect(
      detectsRepo(
        "src/main.ts",
        'const quote = /"/;\nif (repo === "owner/repo") return fallback();',
      ),
    ).toBe(true);
    expect(
      detectsRepo("src/main.ts", String.raw`const example = /repo === "owner\/repo"/;`),
    ).toBe(false);
  });

  it("honors Rust raw-string closing delimiters", () => {
    expect(
      detectsRepo(
        "src/main.rs",
        String.raw`let note = r#"embedded "quote" text"#; if repo == "owner/repo" { special(); }`,
      ),
    ).toBe(true);
  });

  it.each([
    ["src/template.ts", "const value = `first", "old value", "last`;"],
    ["src/settings.py", "value = '''first", "old value", "last'''"],
  ])("checks added paths inside existing multiline strings in %s", (file, first, oldValue, last) => {
    const base = `${first}\n${oldValue}\n${last}\n`;
    const result = lintAntiHardcode(
      changesMiddleLinePatch(file, first, oldValue, "/tmp/secret", last),
      { baseFileContents: new Map([[file, base]]) },
    );
    expect(result.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);
  });

  it("recognizes shell equality predicates without treating assignments as comparisons", () => {
    expect(
      detectsRepo("scripts/check.sh", 'if [ $repo = "owner/repo" ]; then exit 0; fi'),
    ).toBe(true);
    expect(
      detectsRepo("scripts/check.sh", 'repo="owner/repo"; printf "%s" "$repo"'),
    ).toBe(false);
  });

  it.each([
    ["src/main.py", "if issue_number == 123: return workaround()"],
    ["src/main.py", "if issue_id == 123: return workaround()"],
    ["src/main.py", "if pr_number == 123: return workaround()"],
    ["src/main.py", "if bug_id == 123: return workaround()"],
  ])("detects provider-bound snake-case issue identifiers in %s", (file, code) => {
    expect(detectsIssueNumber(file, code)).toBe(true);
  });

});
