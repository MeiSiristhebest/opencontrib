import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepoEngineeringFingerprint } from "../src/discovery/repo-fingerprint.js";

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
