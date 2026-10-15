import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { spawnSync } from "child_process";
import {
  WorktreeManager,
  safeRmSync,
  safeRmAsync,
  GIT_DEFAULT_TIMEOUT_MS,
  GIT_NETWORK_TIMEOUT_MS,
} from "../src/workspace/worktree-manager.js";

describe("WorktreeManager & safeRmSync Resilience", () => {
  let tempBase: string;

  beforeEach(() => {
    tempBase = mkdtempSync(join(tmpdir(), "oc-resilience-test-"));
  });

  afterEach(() => {
    if (existsSync(tempBase)) {
      safeRmSync(tempBase, { recursive: true, force: true });
    }
  });

  it("exports sensible network and default timeout constants", () => {
    expect(GIT_DEFAULT_TIMEOUT_MS).toBe(25_000);
    expect(GIT_NETWORK_TIMEOUT_MS).toBe(180_000);
  });

  it("safeRmSync cleans up directories containing read-only files on Windows", () => {
    const targetDir = join(tempBase, "readonly-dir");
    mkdirSync(targetDir, { recursive: true });
    const targetFile = join(targetDir, "locked.txt");
    writeFileSync(targetFile, "cannot delete me easily");

    if (process.platform === "win32") {
      spawnSync("attrib", ["+r", targetFile], { stdio: "ignore" });
    }

    const removed = safeRmSync(targetDir, { recursive: true, force: true }, [
      tempBase,
    ]);
    expect(removed).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
  });

  it("isValidCachedRepo correctly discriminates between valid and corrupt/dummy repositories", () => {
    const manager = new WorktreeManager();

    // 1. Non-existent path
    expect(
      manager.isValidCachedRepo(join(tempBase, "missing"), "owner/repo"),
    ).toBe(false);

    // 2. Plain directory without git
    const emptyDir = join(tempBase, "plain-dir");
    mkdirSync(emptyDir, { recursive: true });
    expect(manager.isValidCachedRepo(emptyDir, "owner/repo")).toBe(false);

    // 3. Git repo without origin or mismatching origin
    const gitDir = join(tempBase, "git-no-origin");
    mkdirSync(gitDir, { recursive: true });
    spawnSync("git", ["init", gitDir], { stdio: "ignore" });
    expect(manager.isValidCachedRepo(gitDir, "owner/repo")).toBe(false);

    // 4. Git repo with matching origin
    spawnSync(
      "git",
      ["-C", gitDir, "remote", "add", "origin", "https://github.com/owner/repo.git"],
      { stdio: "ignore" },
    );
    expect(manager.isValidCachedRepo(gitDir, "owner/repo")).toBe(true);

    // 5. Mismatching repo
    expect(manager.isValidCachedRepo(gitDir, "owner/different-repo")).toBe(false);
  });

  it("cleans up stale auto-allocated workspace from interrupted previous run", () => {
    const manager = new WorktreeManager();
    const sourceRepo = join(tempBase, "source");
    mkdirSync(sourceRepo, { recursive: true });
    spawnSync("git", ["init", sourceRepo], { stdio: "ignore" });
    spawnSync("git", ["-C", sourceRepo, "config", "user.name", "Tester"], {
      stdio: "ignore",
    });
    spawnSync("git", ["-C", sourceRepo, "config", "user.email", "test@test.com"], {
      stdio: "ignore",
    });
    writeFileSync(join(sourceRepo, "file.txt"), "hello");
    spawnSync("git", ["-C", sourceRepo, "add", "."], { stdio: "ignore" });
    spawnSync("git", ["-C", sourceRepo, "commit", "-m", "initial"], {
      stdio: "ignore",
    });
    spawnSync(
      "git",
      [
        "-C",
        sourceRepo,
        "remote",
        "add",
        "origin",
        "https://github.com/test-owner/test-repo.git",
      ],
      { stdio: "ignore" },
    );

    const commitSha = spawnSync(
      "git",
      ["-C", sourceRepo, "rev-parse", "HEAD"],
      { encoding: "utf-8" },
    ).stdout.trim();
    (manager as any).resolveUpstreamBase = () => commitSha;

    // First create a valid workspace
    const ws = manager.createIsolatedWorkspace({
      repoFullName: "test-owner/test-repo",
      issueOrTaskId: "101",
      localRepoPath: sourceRepo,
    });
    expect(existsSync(ws.workspacePath)).toBe(true);

    // Simulate an interrupted run leaving corrupt Git metadata in workspace
    const gitFile = join(ws.workspacePath, ".git");
    if (existsSync(gitFile)) {
      writeFileSync(gitFile, "corrupt metadata");
    }

    // Re-creating without explicit input.workspacePath should auto-recover and recreate
    const recovered = manager.createIsolatedWorkspace({
      repoFullName: "test-owner/test-repo",
      issueOrTaskId: "101",
      localRepoPath: sourceRepo,
    });
    expect(existsSync(recovered.workspacePath)).toBe(true);
    expect(recovered.isWorktree).toBe(true);

    manager.cleanupWorkspace(recovered.workspacePath, sourceRepo);
    expect(existsSync(recovered.workspacePath)).toBe(false);
  });

  it("safeRmAsync cleans up directories without blocking the event loop", async () => {
    const targetDir = join(tempBase, "async-cleanup-dir");
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(join(targetDir, "file.txt"), "async test");

    const removed = await safeRmAsync(targetDir, { recursive: true, force: true }, [
      tempBase,
    ]);
    expect(removed).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
  });
});
