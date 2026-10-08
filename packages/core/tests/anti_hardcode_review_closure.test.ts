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

function changesSeededMultilineMiddleLinePatch(
  file: string,
  oldLine: string,
  newLine: string,
): string {
  return [
    `diff --git a/${file} b/${file}`,
    `--- a/${file}`,
    `+++ b/${file}`,
    "@@ -2,1 +2,1 @@",
    `-${oldLine}`,
    `+${newLine}`,
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

  it("does not treat assignments as repository comparisons", () => {
    expect(detectsRepo("src/main.ts", 'const repo = "owner/repo";')).toBe(false);
    expect(detectsRepo("src/main.py", 'repo = "owner/repo"')).toBe(false);
    expect(detectsRepo("src/main.ts", 'if (repo === "owner/repo") return special();')).toBe(true);
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

  it("allows home-root module aliases in import specifiers", () => {
    const aliases = lintAntiHardcode(
      patch(
        "src/aliases.ts",
        'import { component } from "~/components/component";\nconst helper = require("~/lib/helper");',
      ),
    );
    expect(aliases.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(false);

    const filesystemPath = lintAntiHardcode(
      patch("src/paths.ts", 'const config = "~/private/config.json";'),
    );
    expect(filesystemPath.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);
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

  it("scans C# raw interpolated strings with repeated dollar delimiters", () => {
    expect(
      detectsRepo("src/main.cs", 'var text = $"""{{repo == "owner/repo"}}""";'),
    ).toBe(true);
    expect(
      detectsRepo("src/main.cs", 'var text = $$"""{{repo == "owner/repo"}}""";'),
    ).toBe(true);
    expect(
      detectsRepo("src/main.cs", 'var text = $$$"""{{{repo == "owner/repo"}}}""";'),
    ).toBe(true);
    expect(
      detectsRepo("src/main.cs", 'var text = $$$"""{{repo == "owner/repo"}}""";'),
    ).toBe(false);
  });

  it("allows Spring mapping arrays but still flags non-route absolute paths", () => {
    for (const code of [
      '@GetMapping({"/system"})\nvoid status() {}',
      '@RequestMapping(path = {"/system", "/status"})\nvoid status() {}',
      '@PostMapping(value={"/system"})\nvoid status() {}',
    ]) {
      expect(
        lintAntiHardcode(patch("src/Controller.java", code)).violations.some(
          entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH",
        ),
      ).toBe(false);
    }
  });

  it("exempts container paths in Dockerfile COPY --from operands", () => {
    const containerCopy = lintAntiHardcode(
      patch(
        "Dockerfile",
        'COPY --from=builder "/usr/local/bin/tool" "/usr/local/bin/tool"',
      ),
    );
    expect(
      containerCopy.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH"),
    ).toBe(false);

    const hostCopy = lintAntiHardcode(
      patch("Dockerfile", 'COPY "/home/me/private-key" /root/.ssh'),
    );
    expect(
      hostCopy.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH"),
    ).toBe(true);
  });

  it.each([
    'WORKDIR "/usr/src/app"',
    'COPY tool "/usr/local/bin/tool"',
    'COPY ["tool", "/usr/local/bin/tool"]',
    'RUN "/usr/bin/tool"',
    'RUN ["/usr/bin/tool", "--version"]',
    'ADD archive "/usr/local/bin/tool"',
    'SHELL ["/bin/sh", "-c"]',
  ])("exempts container paths in %s", instruction => {
    const result = lintAntiHardcode(patch("Dockerfile", instruction));
    expect(result.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(false);
  });

  it("keeps Docker build-context paths and bind-mount sources visible to lint", () => {
    const copiedSecret = lintAntiHardcode(patch("Dockerfile", 'COPY ["/home/me/private-key", "/root/.ssh"]'));
    expect(copiedSecret.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);

    const addedSecret = lintAntiHardcode(patch("Dockerfile", 'ADD "/home/me/archive" "/opt/app"'));
    expect(addedSecret.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);

    const continuedCopy = lintAntiHardcode(patch("Dockerfile", 'COPY \\\n  "/home/me/private-key" \\\n  "/root/.ssh"'));
    expect(continuedCopy.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);

    const mountedSecret = lintAntiHardcode(patch("Dockerfile", 'RUN --mount=type=bind,source="/home/me/secrets",target="/app/secrets" cat /app/secrets/key'));
    expect(mountedSecret.violations.filter(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toHaveLength(1);
  });

  it("does not exempt host-specific Dockerfile environment values", () => {
    const result = lintAntiHardcode(patch("Dockerfile", 'ENV APP_HOME="/home/me/private"'));
    expect(result.violations.some(entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH")).toBe(true);
  });

  it.each([
    "src/ParserTest.java",
    "src/ParserTests.cs",
    "src/ParserSpec.kt",
    "src/Parser.Tests/ParserTests.cs",
  ])("exempts supported ecosystem test suffixes in %s", file => {
    expect(detectsRepo(file, 'if (repo === "owner/repo") return special();')).toBe(false);
  });

  it("still scans production files without a supported test suffix", () => {
    expect(detectsRepo("src/Parser.java", 'if (repo === "owner/repo") return special();')).toBe(true);
  });

  it.each([
    ["src/template.ts", "const value = `first", "old value", "last`;"],
    ["src/settings.py", "value = '''first", "old value", "last'''"],
  ])("uses base lexical state to inspect added paths inside multiline strings in %s", (file, first, oldValue, last) => {
    const base = `${first}\n${oldValue}\n${last}\n`;
    const diff = changesSeededMultilineMiddleLinePatch(file, oldValue, "/tmp/secret");
    expect(
      lintAntiHardcode(diff, { baseFileContents: new Map([[file, base]]) }).violations.some(
        entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH",
      ),
    ).toBe(true);
    expect(
      lintAntiHardcode(diff).violations.some(
        entry => entry.rule === "ABSOLUTE_ENVIRONMENT_PATH",
      ),
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
    'if [ "$repo" = "owner/repo" ]; then exit 0; fi',
    'if [ "${repo}" = "owner/repo" ]; then exit 0; fi',
    'if [ "owner/repo" = "${targetRepo}" ]; then exit 0; fi',
  ])("detects quoted shell repository comparisons: %s", code => {
    expect(detectsRepo("scripts/check.sh", code)).toBe(true);
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
