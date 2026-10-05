import { expect, it } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContributionRunManager } from "@opencontrib/core";
import { saveCanonicalArtifact } from "../../core/src/run/canonical-writer.js";
import { discoveryCommand } from "../src/commands/discovery.js";

it("CLI context reads the run's prepared workspace", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-cli-context-review-"));
  const originalHome = process.env.OPENCONTRIB_HOME;
  const originalLog = console.log;
  const logs: string[] = [];
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
    console.log = (...args) => logs.push(args.join(" "));
    await discoveryCommand.parseAsync(["node", "test", "context", "--run-id", run.runId,
      "--input", JSON.stringify({
        issue: { number: 1, title: "Fix parser", body: "", labels: [] },
        repoDetails: { owner: "example", repo: "parser", defaultBranch: "main", primaryLanguage: "Go" },
        repoTree: [],
      })]);
    const response = JSON.parse(logs.find(line => line.startsWith("{"))!);
    expect(response.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(response.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
  } finally {
    console.log = originalLog;
    if (originalHome === undefined) delete process.env.OPENCONTRIB_HOME;
    else process.env.OPENCONTRIB_HOME = originalHome;
    rmSync(root, { recursive: true, force: true });
  }
});
