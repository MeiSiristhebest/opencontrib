import { expect, it } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContributionRunManager } from "@opencontrib/core";
import { saveCanonicalArtifact } from "../../core/src/run/canonical-writer.js";

const cliEntry = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));

function initializeWorkspace(workspace: string): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "go.mod"), "module example/parser\ngo 1.22\n");
  writeFileSync(join(workspace, "parser_test.go"), "package parser\n");
  execFileSync("git", ["-C", workspace, "init", "--quiet"], { stdio: "ignore" });
  execFileSync("git", [
    "-C", workspace,
    "-c", "user.name=OpenContrib Test",
    "-c", "user.email=test@example.invalid",
    "commit", "--allow-empty",
    "-m", "Update parser",
    "-m", "Signed-off-by: OpenContrib Test <test@example.invalid>",
  ], { stdio: "ignore" });
}

function createPreparedRun(testHome: string, workspace: string) {
  const originalHome = process.env.OPENCONTRIB_HOME;
  process.env.OPENCONTRIB_HOME = testHome;
  try {
    const manager = buildContributionRunManager();
    const run = manager.createRun({ repoFullName: "example/parser" });
    saveCanonicalArtifact(manager, run.runId, "workspace", {
      workspacePath: workspace,
      branchName: "fixture",
      isWorktree: false,
      baseRepoPath: workspace,
      baseCommitSha: "a".repeat(40),
      repoFullName: "example/parser",
      createdAt: new Date().toISOString(),
    }, "WORKSPACE_PREPARED");
    return { manager, run };
  } finally {
    if (originalHome === undefined) delete process.env.OPENCONTRIB_HOME;
    else process.env.OPENCONTRIB_HOME = originalHome;
  }
}

function runContextCli(testHome: string, runId: string, repo: string) {
  const [owner, name] = repo.split("/");
  const input = JSON.stringify({
    issue: { number: 1, title: "Fix parser", body: "", labels: [] },
    repoDetails: { owner, repo: name, defaultBranch: "main", primaryLanguage: "Go" },
    repoTree: [],
  });
  return spawnSync(process.execPath, [
    cliEntry, "--home", testHome, "discovery", "context", "--run-id", runId,
    "--input", input,
  ], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCONTRIB_HOME: testHome,
      NODE_ENV: "development",
      OPENCONTRIB_TELEMETRY: "0",
      DO_NOT_TRACK: "1",
      CI: "true",
    },
    timeout: 60_000,
  });
}

function parseCliResponse(result: {
  stdout: string;
  stderr: string;
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
}): any {
  const responseLine = result.stdout.split(/\r?\n/).find((line) => {
    try {
      const parsed = JSON.parse(line);
      return parsed?.status === "success" || parsed?.status === "error";
    } catch {
      return false;
    }
  });
  if (!responseLine) {
    throw new Error(
      `CLI returned no JSON response (status=${result.status}, signal=${result.signal}, error=${result.error?.message ?? "none"}). stdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
  return JSON.parse(responseLine);
}

it("CLI context uses a repository-bound run and preserves useful diagnostics", () => {
  const root = mkdtempSync(join(tmpdir(), "oc-cli-context-review-"));
  const testHome = join(root, "home");
  const workspace = join(root, "workspace");
  try {
    initializeWorkspace(workspace);
    const { manager, run } = createPreparedRun(testHome, workspace);

    const matching = runContextCli(testHome, run.runId, "example/parser");
    if (matching.status !== 0) {
      throw new Error(`CLI failed. stdout:\n${matching.stdout}\nstderr:\n${matching.stderr}`);
    }
    const success = parseCliResponse(matching);
    expect(success.status).toBe("success");
    expect(success.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(success.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
    expect(success.context.repoContext.engineeringFingerprint.commitStyle.requiresSignedOffBy).toBe(true);

    const mismatched = runContextCli(testHome, run.runId, "other/parser");
    expect(mismatched.status).not.toBe(0);
    const failure = parseCliResponse(mismatched);
    expect(failure.status).toBe("error");
    expect(failure.message).toContain("bound to example/parser");
    expect(manager.getRun(run.runId)?.artifacts.context).toBeDefined();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
