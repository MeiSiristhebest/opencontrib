import { describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  computeSourceTreeHash,
  resolveTestFiles,
} from "../src/evidence/evidence-collector.js";

/**
 * Provenance no-follow rules: the trusted host must never read (or hash)
 * content that a workspace symlink points at outside its boundary.
 *
 * Windows note: creating filesystem symlinks requires privileges or
 * developer mode, so these tests assert on POSIX runners only.
 */
describe("Symlink no-follow provenance rules", () => {
  const skipOnWindows = process.platform === "win32";

  test("computeSourceTreeHash binds symlinks to their target string, not external content", () => {
    if (skipOnWindows) return;
    const outsideDir = mkdtempSync(join(tmpdir(), "oc-h-outside-"));
    const wsDir = mkdtempSync(join(tmpdir(), "oc-h-ws-"));
    const outside = join(outsideDir, "data.txt");
    writeFileSync(outside, "v1");
    symlinkSync(outside, join(wsDir, "link"));
    try {
      const h1 = computeSourceTreeHash(wsDir);
      expect(h1).not.toBe("");
      // Mutating the external target must not change the host fingerprint.
      writeFileSync(outside, "v2-mutated");
      const h2 = computeSourceTreeHash(wsDir);
      expect(h2).toBe(h1);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test("resolveTestFiles hashes a symlinked test file without following the link", () => {
    if (skipOnWindows) return;
    const outsideDir = mkdtempSync(join(tmpdir(), "oc-ti-outside-"));
    const wsDir = mkdtempSync(join(tmpdir(), "oc-ti-ws-"));
    const outsideTest = join(outsideDir, "leak.test.js");
    writeFileSync(outsideTest, "describe('x', function() {});\n");
    const testsDir = join(wsDir, "tests");
    writeFileSync(join(testsDir, "placeholder.js"), "x");
    symlinkSync(outsideTest, join(testsDir, "leak.test.js"));
    try {
      const before = resolveTestFiles(
        wsDir,
        "node tests/leak.test.js",
        "tests/leak.test.js",
      );
      expect(before.length).toBeGreaterThan(0);
      const entry = before.find((f) => f.path === "tests/leak.test.js");
      expect(entry?.sha256).toBeDefined();
      expect(entry!.sha256).not.toBe("");
      // Mutating the external test file must not change the identity digest.
      writeFileSync(outsideTest, "describe('mutated', function() {});\n");
      const after = resolveTestFiles(
        wsDir,
        "node tests/leak.test.js",
        "tests/leak.test.js",
      );
      const afterEntry = after.find((f) => f.path === "tests/leak.test.js");
      expect(afterEntry?.sha256).toBe(entry!.sha256);
    } finally {
      rmSync(wsDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
