import { expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContributionRunManager } from "../../core/src/index.js";
import { saveCanonicalArtifact } from "../../core/src/run/canonical-writer.js";
import { createOpenContribMcpServer } from "../src/server.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const contextTest = gitAvailable ? it : it.skip;

contextTest("MCP context uses the prepared workspace and repository language", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-mcp-context-review-"));
  const originalHome = process.env.OPENCONTRIB_HOME;
  try {
    process.env.OPENCONTRIB_HOME = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "go.mod"), "module example/parser\ngo 1.22\n");
    writeFileSync(join(workspace, "parser_test.go"), "package parser\n");
    const hooks = join(root, "hooks");
    mkdirSync(hooks);
    execFileSync("git", ["-C", workspace, "init", "--quiet"], { stdio: "ignore" });
    execFileSync("git", [
      "-C", workspace,
      "-c", "user.name=OpenContrib Test",
      "-c", "user.email=test@example.invalid",
      "-c", "commit.gpgsign=false",
      "-c", `core.hooksPath=${hooks}`,
      "commit", "--allow-empty", "-m", "Update parser",
      "-m", "Signed-off-by: OpenContrib Test <test@example.invalid>",
    ], { stdio: "ignore" });
    const manager = buildContributionRunManager();
    const run = manager.createRun({ repoFullName: "example/parser" });
    saveCanonicalArtifact(manager, run.runId, "workspace", {
      workspacePath: workspace, branchName: "fixture", isWorktree: false,
      baseRepoPath: workspace, baseCommitSha: "a".repeat(40),
      repoFullName: "example/parser", createdAt: new Date().toISOString(),
    }, "WORKSPACE_PREPARED");
    const server = createOpenContribMcpServer();
    const tool = (server as any)._registeredTools.contrib_assemble_context;
    const result = await tool.handler({ runId: run.runId,
      issue: { number: 1, title: "Fix chunking token loss", body: "", labels: [] },
      repoDetails: { owner: "example", repo: "parser", defaultBranch: "main", primaryLanguage: "Go" },
      repoTree: [],
    });
    expect(result.isError).not.toBe(true);
    const response = JSON.parse(result.content[0].text);
    expect(response.status).toBe("success");
    expect(response.context.repoContext.primaryLanguage).toBe("Go");
    expect(response.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(response.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
    expect(response.context.repoContext.engineeringFingerprint.commitStyle.requiresSignedOffBy).toBe(true);

    const unpreparedRun = manager.createRun({ repoFullName: "example/parser" });
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
  } finally {
    if (originalHome === undefined) delete process.env.OPENCONTRIB_HOME;
    else process.env.OPENCONTRIB_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});
