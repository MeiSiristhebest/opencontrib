import { describe, expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepoEngineeringFingerprint } from "../src/discovery/repo-fingerprint.js";

describe("Native repository test conventions", () => {
  it.each([
    ["tests/parser.rs", '#[test]\nfn parses() {}', "tests/*.rs", "cargo test"],
    ["src/test/java/ParserTest.java", 'import org.junit.jupiter.api.Test;\nclass ParserTest {}', "*Test.java", "JUnit"],
    ["src/test/kotlin/ParserTest.kt", 'import kotlin.test.Test\nclass ParserTest', "*Test.kt", "kotlin.test"],
    ["tests/ParserTests.cs", 'using Xunit;\nclass ParserTests {}', "*Tests.cs", "xUnit"],
  ])("recognizes native tests at %s", (file, contents, pattern, framework) => {
    const root = mkdtempSync(join(tmpdir(), "oc-review-native-"));
    try {
      const testPath = join(root, file);
      mkdirSync(dirname(testPath), { recursive: true });
      writeFileSync(testPath, contents);
      const result = analyzeRepoEngineeringFingerprint({ repoPath: root });
      expect(result.testConventions.sampleTestPath).toBe(testPath);
      expect(result.testConventions.filePattern).toBe(pattern);
      expect(result.testConventions.frameworkName).toBe(framework);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

});
