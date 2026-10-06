import { expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActiveSessionManager,
  ContributionRunManager,
} from "../../core/src/index.js";
import { saveCanonicalArtifact } from "../../core/src/run/canonical-writer.js";
import { createOpenContribMcpServer } from "../src/server.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const contextTest = gitAvailable ? it : it.skip;

function saveWorkspaceArtifact(
  manager: ContributionRunManager,
  runId: string,
  workspacePath: string,
): void {
  const baseCommitSha = execFileSync(
    "git",
    ["-C", workspacePath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  saveCanonicalArtifact(manager, runId, "workspace", {
    workspacePath,
    branchName: "fixture",
    isWorktree: false,
    baseRepoPath: workspacePath,
    baseCommitSha,
    repoFullName: "example/parser",
    createdAt: new Date().toISOString(),
  }, "WORKSPACE_PREPARED");
}

contextTest("MCP context uses the prepared workspace and repository language", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-mcp-context-review-"));
  try {
    const home = join(root, "home");
    const dataDir = join(home, ".opencontrib");
    const manager = new ContributionRunManager({
      baseDir: join(dataDir, "runs"),
      activeSession: new ActiveSessionManager(join(dataDir, "active_session.json")),
    });
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "go.mod"), "module example/parser\ngo 1.22\n");
    writeFileSync(join(workspace, "parser_test.go"), "package parser\n");
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    execFileSync("git", ["-C", workspace, "init", "--quiet"], { stdio: "ignore" });
    execFileSync("git", [
      "-C", workspace,
      "add", "--", "go.mod", "parser_test.go",
    ], { stdio: "ignore" });
    execFileSync("git", [
      "-C", workspace,
      "-c", "user.name=OpenContrib Test",
      "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false",
      "-c", `core.hooksPath=${hooks}`,
      "commit", "--allow-empty", "-m", "Update parser",
      "-m", "Signed-off-by: OpenContrib Test <test@example.invalid>",
    ], { stdio: "ignore" });
    execFileSync("git", [
      "-C", workspace,
      "remote", "add", "origin", "https://github.com/example/parser.git",
    ], { stdio: "ignore" });
    const run = manager.createRun({ repoFullName: "example/parser", issueNumber: 1 });
    saveWorkspaceArtifact(manager, run.runId, workspace);
    const server = createOpenContribMcpServer({ runManager: manager });
    const tool = (server as any)._registeredTools.contrib_assemble_context;
    const result = await tool.handler({ runId: run.runId,
      issue: { number: 1, title: "Fix chunking token loss", body: "", labels: [] },
      repoDetails: { owner: "example", repo: "parser", defaultBranch: "main", primaryLanguage: "Go" },
      repoTree: [],
    });
    if (result.isError) {
      throw new Error(`MCP context failed: ${result.content.map((item: any) => item.text ?? "").join("\n")}`);
    }
    const response = JSON.parse(result.content[0].text);
    expect(response.status).toBe("success");
    expect(response.context.repoContext.primaryLanguage).toBe("Go");
    expect(response.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(response.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
    expect(response.context.repoContext.engineeringFingerprint.commitStyle.requiresSignedOffBy).toBe(true);

    const unpreparedRun = manager.createRun({ repoFullName: "example/parser", issueNumber: 2 });
    const unpreparedResult = await tool.handler({
      runId: unpreparedRun.runId,
      issue: { number: 2, title: "Fix parser", body: "", labels: [] },
      repoDetails: {
        owner: "example",
        repo: "parser",
        defaultBranch: "main",
        primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(unpreparedResult.isError).toBe(true);
    const unprepared = JSON.parse(unpreparedResult.content[0].text);
    expect(unprepared.status).toBe("error");
    expect(unprepared.message).toContain("no prepared workspace");
    expect(manager.getRun(unpreparedRun.runId)?.artifacts.context).toBeUndefined();

    const mismatchResult = await tool.handler({ runId: run.runId,
      issue: { number: 1, title: "Fix chunking token loss", body: "", labels: [] },
      repoDetails: { owner: "other", repo: "parser", defaultBranch: "main", primaryLanguage: "Go" },
      repoTree: [],
    });
    expect(mismatchResult.isError).toBe(true);
    const mismatch = JSON.parse(mismatchResult.content[0].text);
    expect(mismatch.status).toBe("error");
    expect(mismatch.message).toContain("example/parser");

    const issueMismatchRun = manager.createRun({
      repoFullName: "example/parser",
      issueNumber: 1,
    });
    saveWorkspaceArtifact(manager, issueMismatchRun.runId, workspace);
    const issueMismatchResult = await tool.handler({
      runId: issueMismatchRun.runId,
      issue: { number: 2, title: "Fix another parser issue", body: "", labels: [] },
      repoDetails: {
        owner: "example",
        repo: "parser",
        defaultBranch: "main",
        primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(issueMismatchResult.isError).toBe(true);
    const issueMismatch = JSON.parse(issueMismatchResult.content[0].text);
    expect(issueMismatch.status).toBe("error");
    expect(issueMismatch.message).toContain("bound to issue #1");
    expect(manager.getRun(issueMismatchRun.runId)?.artifacts.context).toBeUndefined();

    const unusableRun = manager.createRun({ repoFullName: "example/parser", issueNumber: 3 });
    const nonRepository = join(root, "non-repository");
    mkdirSync(nonRepository);
    saveCanonicalArtifact(manager, unusableRun.runId, "workspace", {
      workspacePath: nonRepository, branchName: "fixture", isWorktree: false,
      baseRepoPath: nonRepository, baseCommitSha: "a".repeat(40),
      repoFullName: "example/parser", createdAt: new Date().toISOString(),
    }, "WORKSPACE_PREPARED");
    const unusableResult = await tool.handler({
      runId: unusableRun.runId,
      issue: { number: 3, title: "Fix parser", body: "", labels: [] },
      repoDetails: {
        owner: "example", repo: "parser", defaultBranch: "main", primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(unusableResult.isError).toBe(true);
    const unusable = JSON.parse(unusableResult.content[0].text);
    expect(unusable.status).toBe("error");
    expect(unusable.message).toContain("recorded repository and base commit");
    expect(manager.getRun(unusableRun.runId)?.artifacts.context).toBeUndefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
