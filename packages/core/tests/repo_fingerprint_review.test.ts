import { describe, expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  analyzeRepoEngineeringFingerprint,
  isPreparedRepositoryWorkspace,
} from "../src/discovery/repo-fingerprint.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;

describe("Native repository test conventions", () => {
  it.each([
    ["tests/parser.rs", '#[test]\nfn parses() {}', "tests/*.rs", "cargo test"],
    ["src/test/java/ParserTest.java", 'import org.junit.jupiter.api.Test;\nclass ParserTest {}', "*Test.java", "JUnit"],
    ["src/test/java/TestParser.java", 'import org.junit.jupiter.api.Test;\nclass TestParser {}', "Test*.java", "JUnit"],
    ["src/test/kotlin/ParserTest.kt", 'import kotlin.test.Test\nclass ParserTest', "*Test.kt", "kotlin.test"],
    ["tests/ParserTests.cs", 'using Xunit;\nclass ParserTests {}', "*Tests.cs", "xUnit"],
  ])("recognizes native tests at %s", (file, contents, pattern, framework) => {
    const root = mkdtempSync(join(tmpdir(), "oc-review-native-"));
    try {
      const testPath = join(root, file);
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(testPath, contents);
      if (framework === "cargo test") {
        writeFileSync(join(root, "Cargo.toml"), "[package]\nname = \"parser\"\nversion = \"0.1.0\"\n");
      }
      const result = analyzeRepoEngineeringFingerprint({ repoPath: root });
      expect(result.testConventions.sampleTestPath).toBe(testPath);
      expect(result.testConventions.filePattern).toBe(pattern);
      expect(result.testConventions.frameworkName).toBe(framework);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not infer Cargo test conventions from Rust fixtures without a manifest", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-review-rust-no-cargo-"));
    try {
      const testPath = join(root, "tests", "parser.rs");
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(testPath, "#[test]\nfn parses() {}\n");

      const result = analyzeRepoEngineeringFingerprint({ repoPath: root });

      expect(result.testConventions.filePattern).not.toBe("tests/*.rs");
      expect(result.testConventions.frameworkName).not.toBe("cargo test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recognizes Rust integration tests in nested Cargo crates", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-review-nested-cargo-"));
    try {
      const crate = join(root, "crates", "parser");
      const testPath = join(crate, "tests", "parser.rs");
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(testPath, "#[test]\nfn parses() {}\n");
      writeFileSync(join(crate, "Cargo.toml"), "[package]\nname = \"parser\"\nversion = \"0.1.0\"\n");

      const result = analyzeRepoEngineeringFingerprint({ repoPath: root });

      expect(result.testConventions.sampleTestPath).toBe(testPath);
      expect(result.testConventions.filePattern).toBe("**/tests/*.rs");
      expect(result.testConventions.frameworkName).toBe("cargo test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds framework detection reads to a test source prefix", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-review-large-test-"));
    try {
      const testPath = join(root, "src", "test", "java", "ParserTest.java");
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(
        testPath,
        `${" ".repeat(128 * 1024)}\nimport org.junit.jupiter.api.Test;\nclass ParserTest {}`,
      );

      const result = analyzeRepoEngineeringFingerprint({ repoPath: root });

      expect(result.testConventions.filePattern).toBe("*Test.java");
      expect(result.testConventions.frameworkName).not.toBe("JUnit");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("Prepared repository workspace binding", () => {
  const gitTest = gitAvailable ? it : it.skip;

  gitTest("requires the exact clean baseline recorded for the run", () => {
    const root = mkdtempSync(join(tmpdir(), "oc-prepared-workspace-"));
    try {
      writeFileSync(join(root, "parser.ts"), "export const value = 1;\n");
      writeFileSync(join(root, ".gitignore"), "ignored_test.go\nnode_modules/\n");
      execFileSync("git", ["-C", root, "init", "--quiet"], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "config", "--local", "core.ignoreStat", "false"], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "add", "--", "parser.ts", ".gitignore"], { stdio: "ignore" });
      execFileSync("git", [
        "-C", root,
        "-c", "user.name=OpenContrib Test",
        "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false",
        "commit", "-m", "Baseline",
      ], { stdio: "ignore" });
      execFileSync("git", ["-C", root, "config", "--local", "core.ignoreStat", "true"], { stdio: "ignore" });
      execFileSync("git", [
        "-C", root,
        "remote", "add", "origin", "https://github.com/example/parser.git",
      ], { stdio: "ignore" });

      const baseCommitSha = execFileSync(
        "git",
        ["-C", root, "rev-parse", "HEAD"],
        { encoding: "utf8" },
      ).trim();
      const binding = { repoFullName: "example/parser", baseCommitSha };
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(true);

      mkdirSync(join(root, "node_modules", "fixture"), { recursive: true });
      writeFileSync(join(root, "node_modules", "fixture", "index.js"), "module.exports = {};\n");
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(true);

      writeFileSync(join(root, "ignored_test.go"), "package parser\n");
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(false);
      rmSync(join(root, "ignored_test.go"));

      writeFileSync(join(root, "parser.ts"), "export const value = 2;\n");
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(false);

      writeFileSync(join(root, "parser.ts"), "export const value = 1;\n");
      execFileSync("git", ["-C", root, "update-index", "--assume-unchanged", "parser.ts"], { stdio: "ignore" });
      writeFileSync(join(root, "parser.ts"), "export const value = 3;\n");
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(false);

      execFileSync("git", ["-C", root, "update-index", "--no-assume-unchanged", "parser.ts"], { stdio: "ignore" });
      writeFileSync(join(root, "parser.ts"), "export const value = 1;\n");
      execFileSync("git", ["-C", root, "update-index", "--skip-worktree", "parser.ts"], { stdio: "ignore" });
      writeFileSync(join(root, "parser.ts"), "export const value = 4;\n");
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(false);

      execFileSync("git", ["-C", root, "update-index", "--no-skip-worktree", "parser.ts"], { stdio: "ignore" });
      writeFileSync(join(root, "parser.ts"), "export const value = 1;\n");
      writeFileSync(join(root, "notes.txt"), "untracked\n");
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(false);

      execFileSync("git", ["-C", root, "add", "--", "notes.txt"], { stdio: "ignore" });
      execFileSync("git", [
        "-C", root,
        "-c", "user.name=OpenContrib Test",
        "-c", "user.email=test@example.invalid",
        "-c", "commit.gpgsign=false",
        "commit", "-m", "Advanced workspace",
      ], { stdio: "ignore" });
      expect(isPreparedRepositoryWorkspace(root, binding)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
