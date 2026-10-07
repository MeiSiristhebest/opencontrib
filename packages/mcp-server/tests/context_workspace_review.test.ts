import { expect, it, spyOn } from "bun:test";
import { execFileSync, spawnSync } from "node:child_process";
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
import { createOpenContribMcpServer } from "../src/server.js";

const gitAvailable = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const contextTest = gitAvailable ? it : it.skip;

function saveWorkspaceArtifact(
  manager: ContributionRunManager,
  runId: string,
  workspacePath: string,
  privateDisclosure = false,
): void {
  const baseCommitSha = execFileSync(
    "git",
    ["-C", workspacePath, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
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

function testIssueProvider(onLookup: () => void = () => {}) {
  return {
    getIssue: async (owner: string, repo: string, issueNumber: number) => {
      onLookup();
      return {
        status: "OK" as const,
        data: {
          number: issueNumber,
          title: "Fix chunking token loss",
          state: "open" as const,
          htmlUrl: `https://github.com/${owner}/${repo}/issues/${issueNumber}`,
          body: "Provider issue body.",
          labels: ["provider-label"],
        },
      };
    },
  };
}

async function bindIssue(
  manager: ContributionRunManager,
  runId: string,
  issueNumber = 1,
  provider = testIssueProvider(),
): Promise<void> {
  await new IssueBindingService(manager, provider).bind({
    runId,
    repoFullName: "example/parser",
    issueNumber,
  });
}

it("MCP context rejects requests without a canonical run", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-mcp-context-no-run-"));
  try {
    const manager = new ContributionRunManager({
      baseDir: join(root, "runs"),
      activeSession: new ActiveSessionManager(join(root, "active_session.json")),
    });
    const server = createOpenContribMcpServer({ runManager: manager });
    const tool = (server as any)._registeredTools.contrib_assemble_context;
    const result = await tool.handler({
      issue: { number: 1, title: "Fix parser", body: "", labels: [] },
      repoDetails: { owner: "example", repo: "parser", defaultBranch: "main" },
      repoTree: [],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("run");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("MCP scout and probe reject missing runs before executing providers or scanners", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-mcp-discovery-no-run-"));
  try {
    const manager = new ContributionRunManager({
      baseDir: join(root, "runs"),
      activeSession: new ActiveSessionManager(join(root, "active_session.json")),
    });
    const tools = (createOpenContribMcpServer({ runManager: manager }) as any)._registeredTools;
    for (const [name, args] of [
      ["contrib_scout", { target: "example/parser" }],
      ["contrib_probe_run", { targetPath: root, onlyProbes: [] }],
    ] as const) {
      const result = await tools[name].handler(args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("run");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("MCP probe does not report success when canonical persistence fails", async () => {
  const root = mkdtempSync(join(tmpdir(), "oc-mcp-probe-save-"));
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  try {
    const manager = new ContributionRunManager({
      baseDir: join(root, "runs"),
      activeSession: new ActiveSessionManager(join(root, "active_session.json")),
    });
    const run = manager.createRun({ repoFullName: "example/parser" });
    const save = spyOn(manager, "saveArtifact").mockImplementation(() => { throw new Error("Fixture persistence failure"); });
    try {
      const tool = (createOpenContribMcpServer({ runManager: manager }) as any)._registeredTools.contrib_probe_run;
      const result = await tool.handler({ runId: run.runId, targetPath: workspace, onlyProbes: [] });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Fixture persistence failure");
      expect(manager.getRun(run.runId)!.manifest.currentPhase).toBe("INITIALIZED");
    } finally {
      save.mockRestore();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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
      "-c", `core.hooksPath=${hooks}`,
      "commit", "--allow-empty", "-m", "Update parser",
      "-m", "Signed-off-by: OpenContrib Test <test@example.invalid>",
    ], { stdio: "ignore" });
    execFileSync("git", [
      "-C", workspace,
      "remote", "add", "origin", "https://github.com/example/parser.git",
    ], { stdio: "ignore" });
    const run = manager.createRun({ repoFullName: "example/parser" });
    saveWorkspaceArtifact(manager, run.runId, workspace);
    let providerLookups = 0;
    const issueBindingProvider = testIssueProvider(() => {
      providerLookups += 1;
    });
    await bindIssue(manager, run.runId, 1, issueBindingProvider);
    const server = createOpenContribMcpServer({
      runManager: manager,
      issueBindingProvider,
    });
    const tool = (server as any)._registeredTools.contrib_assemble_context;
    const result = await tool.handler({ runId: run.runId,
      issue: { number: 1, title: "Fix chunking token loss", body: "", labels: [] },
      repoDetails: { owner: "example", repo: "parser.git", defaultBranch: "main", primaryLanguage: "Go" },
      repoTree: [],
    });
    if (result.isError) {
      throw new Error(`MCP context failed: ${result.content.map((item: any) => item.text ?? "").join("\n")}`);
    }
    const response = JSON.parse(result.content[0].text);
    expect(response.status).toBe("success");
    expect(response.context.problemContext.issueBody).toBe("Provider issue body.");
    expect(response.context.repoContext.primaryLanguage).toBe("Go");
    expect(response.context.repoContext.runnableCommands.testCommand).toBe("go test ./...");
    expect(response.context.repoContext.engineeringFingerprint.testConventions.filePattern).toBe("*_test.go");
    expect(response.context.repoContext.engineeringFingerprint.commitStyle.requiresSignedOffBy).toBe(true);
    expect(providerLookups).toBe(2);

    const privateRun = manager.createRun({ repoFullName: "example/parser" });
    saveWorkspaceArtifact(manager, privateRun.runId, workspace, true);
    const privateContextResult = await tool.handler({
      runId: privateRun.runId,
      issue: { title: "Private vulnerability", body: "Report details", labels: [] },
      repoDetails: {
        owner: "example",
        repo: "parser",
        defaultBranch: "main",
        primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(privateContextResult.isError).not.toBe(true);
    const privateContext = JSON.parse(privateContextResult.content[0].text);
    expect(privateContext.status).toBe("success");
    expect(privateContext.context.problemContext.issueNumber).toBeUndefined();
    expect(providerLookups).toBe(2);

    const numberedPrivateRun = manager.createRun({
      repoFullName: "example/parser",
      issueNumber: 4,
    });
    saveWorkspaceArtifact(manager, numberedPrivateRun.runId, workspace, true);
    const numberedPrivateResult = await tool.handler({
      runId: numberedPrivateRun.runId,
      issue: { title: "Private vulnerability", body: "Report details", labels: [] },
      repoDetails: {
        owner: "example",
        repo: "parser",
        defaultBranch: "main",
        primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(numberedPrivateResult.isError).toBe(true);
    expect(JSON.parse(numberedPrivateResult.content[0].text).message).toContain(
      "cannot use a public issue number or binding",
    );
    expect(manager.getRun(numberedPrivateRun.runId)?.artifacts.context).toBeUndefined();

    const boundPrivateRun = manager.createRun({ repoFullName: "example/parser" });
    saveWorkspaceArtifact(manager, boundPrivateRun.runId, workspace, true);
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
    const boundPrivateResult = await tool.handler({
      runId: boundPrivateRun.runId,
      issue: { title: "Private vulnerability", body: "Report details", labels: [] },
      repoDetails: {
        owner: "example",
        repo: "parser",
        defaultBranch: "main",
        primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(boundPrivateResult.isError).toBe(true);
    expect(JSON.parse(boundPrivateResult.content[0].text).message).toContain(
      "cannot use a public issue number or binding",
    );
    expect(manager.getRun(boundPrivateRun.runId)?.artifacts.context).toBeUndefined();
    expect(providerLookups).toBe(2);

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
    await bindIssue(manager, issueMismatchRun.runId);
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

    const unboundRun = manager.createRun({ repoFullName: "example/parser" });
    manager.saveArtifact(unboundRun.runId, "opportunity", {
      issueNumber: 2,
      title: "Fix chunking token loss",
    });
    saveWorkspaceArtifact(manager, unboundRun.runId, workspace);
    const unboundResult = await tool.handler({
      runId: unboundRun.runId,
      issue: { number: 2, title: "Fix chunking token loss", body: "", labels: [] },
      repoDetails: {
        owner: "example",
        repo: "parser",
        defaultBranch: "main",
        primaryLanguage: "Go",
      },
      repoTree: [],
    });
    expect(unboundResult.isError).toBe(true);
    const unbound = JSON.parse(unboundResult.content[0].text);
    expect(unbound.status).toBe("error");
    expect(unbound.message).toContain("provider-verified issue binding");
    expect(manager.getRun(unboundRun.runId)?.artifacts.context).toBeUndefined();

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
