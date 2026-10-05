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

});
