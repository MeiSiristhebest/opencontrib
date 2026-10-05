import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContributionRunManager } from "@opencontrib/core";
import { saveCanonicalArtifact } from "../../core/src/run/canonical-writer.js";
import { createOpenContribMcpServer } from "../src/server.js";

it("MCP context uses the prepared workspace and repository language", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-mcp-context-review-"));
  const originalHome = process.env.OPENCONTRIB_HOME;
  try {
    process.env.OPENCONTRIB_HOME = join(root, "home");
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    writeFileSync(join(workspace, "go.mod"), "module example/parser\ngo 1.22\n");
    writeFileSync(join(workspace, "parser_test.go"), "package parser\n");
    const manager = buildContributionRunManager();
    const run = manager.createRun({ repoFullName: "example/parser" });
    saveCanonicalArtifact(manager, run.runId, "workspace", {
      workspacePath: workspace, branchName: "fixture", isWorktree: false,
      baseRepoPath: workspace, baseCommitSha: "a".repeat(40),
      repoFullName: "example/parser", createdAt: new Date().toISOString(),
    }, "WORKSPACE_PREPARED");
    const server = createOpenContribMcpServer();
    const tool = (server as any)._registeredTools.contrib_assemble_context;
    const languageField = tool.inputSchema.shape.repoDetails.shape.primaryLanguage;
    expect(languageField).toBeDefined();
    const result = await tool.handler({ runId: run.runId,
      issue: { number: 1, title: "Fix chunking token loss", body: "", labels: [] },
      repoDetails: { owner: "example", repo: "parser", defaultBranch: "main", primaryLanguage: "Go" },
      repoTree: [],
    });
    const response = JSON.parse(result.content[0].text);
    expect(response.context.repoContext.primaryLanguage).toBe("Go");
    expect(response.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(response.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
  } finally {
    if (originalHome === undefined) delete process.env.OPENCONTRIB_HOME;
    else process.env.OPENCONTRIB_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});
