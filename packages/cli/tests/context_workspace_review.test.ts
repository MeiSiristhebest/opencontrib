import { expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ActiveSessionManager,
  ContributionRunManager,
  hashCommunityGateSnapshot,
} from "../../core/src/index.js";
import { IssueBindingService } from "../../core/src/github/issue-binding-service.js";
import { saveCanonicalArtifact } from "../../core/src/run/canonical-writer.js";
import { createContextCommand } from "../src/commands/discovery.js";

function initializeWorkspace(
  workspace: string,
  repoFullName = "example/parser",
): void {
  mkdirSync(workspace, { recursive: true });
  writeFileSync(join(workspace, "go.mod"), "module example/parser\ngo 1.22\n");
  writeFileSync(join(workspace, "parser_test.go"), "package parser\n");
  execFileSync("git", ["-C", workspace, "init", "--quiet"], { stdio: "ignore" });
  execFileSync("git", ["-C", workspace, "config", "--local", "core.ignoreStat", "false"], { stdio: "ignore" });
  execFileSync("git", [
    "-C", workspace,
    "add", "--", "go.mod", "parser_test.go",
  ], { stdio: "ignore" });
  execFileSync("git", [
    "-C", workspace,
    "-c", "user.name=OpenContrib Test",
    "-c", "user.email=test@example.invalid",
    "-c", "commit.gpgsign=false",
    "commit", "--allow-empty",
    "-m", "Update parser",
    "-m", "Signed-off-by: OpenContrib Test <test@example.invalid>",
  ], { stdio: "ignore" });
  execFileSync("git", [
    "-C", workspace,
    "remote", "add", "origin",
    `https://github.com/${repoFullName}.git`,
  ], { stdio: "ignore" });
}

function saveWorkspaceArtifact(
  manager: ContributionRunManager,
  runId: string,
  workspacePath: string,
  baseCommitSha = execFileSync(
    "git",
    ["-C", workspacePath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim(),
  privateDisclosure = false,
): void {
  const communityGate = {
    sourceCommitSha: baseCommitSha,
    policy: {
      hasGatingRules: false,
      requiresIssueApprovalBeforePr: false,
      autoClosesNewIssues: false,
      hasLgtmApprovalProtocol: false,
      restrictedTriageHours: false,
      privateVulnerabilityDisclosure: privateDisclosure,
      reasons: [],
      suggestedContributorAction: "Follow the repository contribution policy.",
      matchedKeywords: [],
    },
  };
  saveCanonicalArtifact(manager, runId, "workspace", {
    workspacePath,
    branchName: "fixture",
    isWorktree: false,
    baseRepoPath: workspacePath,
    baseCommitSha,
    repoFullName: "example/parser",
    communityGate,
    communityGateSha256: hashCommunityGateSnapshot(communityGate),
    createdAt: new Date().toISOString(),
  }, "WORKSPACE_PREPARED");
}

function testIssueProvider() {
  return {
    getIssue: async (owner: string, repo: string, issueNumber: number) => ({
      status: "OK" as const,
      data: {
        number: issueNumber,
        title: "Fix parser",
        state: "open" as const,
        htmlUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
        body: "Provider issue body.",
        labels: ["provider-label"],
      },
    }),
  };
}

async function bindIssue(
  manager: ContributionRunManager,
  runId: string,
  issueNumber = 1,
): Promise<void> {
  await new IssueBindingService(manager, testIssueProvider()).bind({
    runId,
    repoFullName: "example/parser",
    issueNumber,
  });
}

async function createPreparedRun(testHome: string, workspace: string) {
  const dataDir = join(testHome, ".opencontrib");
  const manager = new ContributionRunManager({
    baseDir: join(dataDir, "runs"),
    activeSession: new ActiveSessionManager(join(dataDir, "active_session.json")),
  });
  const run = manager.createRun({ repoFullName: "example/parser" });
  saveWorkspaceArtifact(manager, run.runId, workspace);
  await bindIssue(manager, run.runId);
  return { manager, run };
}

async function runContextCli(
  manager: ContributionRunManager,
  runId: string,
  repo: string,
  issueNumber: number | undefined,
  issueBindingProvider = testIssueProvider(),
  comments: string[] = [],
) {
  const [owner, name] = repo.split("/");
  const input = JSON.stringify({
    issue: {
      ...(issueNumber === undefined ? {} : { number: issueNumber }),
      title: "Fix parser",
      body: "",
      labels: [],
      comments,
    },
    repoDetails: { owner, repo: name, defaultBranch: "main", primaryLanguage: "Go" },
    repoTree: [],
  });
  const output: string[] = [];
  const originalLog = console.log;
  console.log = (...values: unknown[]) => output.push(values.join(" "));
  let status = 0;
  try {
    await createContextCommand({ runManager: manager, issueBindingProvider })
      .parseAsync(
        ["node", "context", "--run-id", runId, "--input", input],
        { from: "node" },
      );
  } catch {
    status = 1;
  } finally {
    console.log = originalLog;
  }
  return { status, stdout: output.join("\n"), stderr: "", signal: null };
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

async function expectRunContextFailure(
  manager: ContributionRunManager,
  runId: string,
  repo: string,
  expectedMessage: string,
  issueNumber: number | undefined,
): Promise<void> {
  const result = await runContextCli(manager, runId, repo, issueNumber);
  expect(result.status).not.toBe(0);
  const failure = parseCliResponse(result);
  expect(failure.status).toBe("error");
  expect(failure.message).toContain(expectedMessage);
  expect(manager.getRun(runId)?.artifacts.context).toBeUndefined();
}

it("CLI context uses a repository-bound run and preserves useful diagnostics", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-cli-context-review-"));
  const testHome = join(root, "home");
  const workspace = join(root, "workspace");
  try {
    initializeWorkspace(workspace);
    const { manager, run } = await createPreparedRun(testHome, workspace);

    const matching = await runContextCli(
      manager,
      run.runId,
      "example/parser",
      1,
      testIssueProvider(),
      ["Untrusted caller supplied comment"],
    );
    if (matching.status !== 0) {
      throw new Error(`CLI failed. stdout:\n${matching.stdout}\nstderr:\n${matching.stderr}`);
    }
    const success = parseCliResponse(matching);
    expect(success.status).toBe("success");
    expect(success.context.problemContext.issueBody).toBe("Provider issue body.");
    expect(success.context.problemContext.linkedComments).toEqual([]);
    expect(success.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(success.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
    expect(success.context.repoContext.engineeringFingerprint.commitStyle.requiresSignedOffBy).toBe(true);

    const unpreparedRun = manager.createRun({ repoFullName: "example/parser", issueNumber: 1 });
    await expectRunContextFailure(
      manager,
      unpreparedRun.runId,
      "example/parser",
      "no prepared workspace",
      1,
    );

    const mismatchRun = manager.createRun({ repoFullName: "example/parser" });
    saveWorkspaceArtifact(manager, mismatchRun.runId, workspace);
    await bindIssue(manager, mismatchRun.runId);
    expect(manager.getRun(mismatchRun.runId)?.artifacts.context).toBeUndefined();

    await expectRunContextFailure(
      manager,
      mismatchRun.runId,
      "other/parser",
      "bound to example/parser",
      1,
    );

    const issueMismatchRun = manager.createRun({
      repoFullName: "example/parser",
    });
    saveWorkspaceArtifact(manager, issueMismatchRun.runId, workspace);
    await bindIssue(manager, issueMismatchRun.runId);
    await expectRunContextFailure(
      manager,
      issueMismatchRun.runId,
      "example/parser",
      "bound to issue #1",
      2,
    );

    const staleRun = manager.createRun({ repoFullName: "example/parser", issueNumber: 1 });
    const deletedWorkspace = join(root, "deleted-workspace");
    initializeWorkspace(deletedWorkspace);
    saveWorkspaceArtifact(manager, staleRun.runId, deletedWorkspace);
    await bindIssue(manager, staleRun.runId);
    rmSync(deletedWorkspace, { recursive: true, force: true });
    await expectRunContextFailure(
      manager,
      staleRun.runId,
      "example/parser",
      "recorded repository and base commit",
      1,
    );

    const wrongOriginWorkspace = join(root, "wrong-origin-workspace");
    initializeWorkspace(wrongOriginWorkspace, "other/parser");
    const wrongOriginRun = manager.createRun({ repoFullName: "example/parser", issueNumber: 1 });
    saveWorkspaceArtifact(manager, wrongOriginRun.runId, wrongOriginWorkspace);
    await bindIssue(manager, wrongOriginRun.runId);
    await expectRunContextFailure(
      manager,
      wrongOriginRun.runId,
      "example/parser",
      "recorded repository and base commit",
      1,
    );

    const wrongBaseRun = manager.createRun({ repoFullName: "example/parser", issueNumber: 1 });
    saveWorkspaceArtifact(manager, wrongBaseRun.runId, workspace, "a".repeat(40));
    await bindIssue(manager, wrongBaseRun.runId);
    await expectRunContextFailure(
      manager,
      wrongBaseRun.runId,
      "example/parser",
      "recorded repository and base commit",
      1,
    );

    const unboundRun = manager.createRun({ repoFullName: "example/parser" });
    manager.saveArtifact(unboundRun.runId, "opportunity", {
      issueNumber: 2,
      title: "Fix parser",
    });
    saveWorkspaceArtifact(manager, unboundRun.runId, workspace);
    await expectRunContextFailure(
      manager,
      unboundRun.runId,
      "example/parser",
      "provider-verified issue binding",
      2,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("CLI context keeps private disclosure reports numberless", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-cli-private-context-review-"));
  const testHome = join(root, "home");
  const workspace = join(root, "workspace");
  try {
    initializeWorkspace(workspace);
    const { manager } = await createPreparedRun(testHome, workspace);
    const privateRun = manager.createRun({ repoFullName: "example/parser" });
    saveWorkspaceArtifact(manager, privateRun.runId, workspace, undefined, true);
    let providerCalls = 0;
    const provider = {
      getIssue: async () => {
        providerCalls += 1;
        throw new Error("private context must not query a public issue");
      },
    };

    const privateContext = await runContextCli(
      manager,
      privateRun.runId,
      "example/parser",
      undefined,
      provider,
    );
    expect(privateContext.status).toBe(0);
    const success = parseCliResponse(privateContext);
    expect(success.context.problemContext.issueNumber).toBeUndefined();
    expect(manager.getRun(privateRun.runId)?.artifacts.context.problemContext.issueNumber).toBeUndefined();
    expect(providerCalls).toBe(0);

    const numberedPrivateRun = manager.createRun({
      repoFullName: "example/parser",
      issueNumber: 4,
    });
    saveWorkspaceArtifact(manager, numberedPrivateRun.runId, workspace, undefined, true);
    await expectRunContextFailure(
      manager,
      numberedPrivateRun.runId,
      "example/parser",
      "cannot use a public issue number or binding",
      undefined,
    );

    const boundPrivateRun = manager.createRun({ repoFullName: "example/parser" });
    saveWorkspaceArtifact(manager, boundPrivateRun.runId, workspace, undefined, true);
    saveCanonicalArtifact(manager, boundPrivateRun.runId, "issue_binding", {
      runId: boundPrivateRun.runId,
      provider: "github",
      repoFullName: "example/parser",
      providerIssueId: 4,
      state: "open",
      title: "Private vulnerability",
      issueUrl: "https://github.com/example/parser/issues/4",
      providerVerified: true,
      verifiedAt: new Date().toISOString(),
    });
    await expectRunContextFailure(
      manager,
      boundPrivateRun.runId,
      "example/parser",
      "cannot use a public issue number or binding",
      undefined,
    );
    expect(providerCalls).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
