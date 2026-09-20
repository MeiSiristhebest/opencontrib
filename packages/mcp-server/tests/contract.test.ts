import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createOpenContribMcpServer } from "../src/server.js";
import {
  AUTHORITATIVE_ARTIFACT_TYPES,
  PROTOCOL_CONTRACT_PHASES,
  WorktreeManager,
} from "@opencontrib/core";

const DRAFT_ARTIFACT_TYPES = [
  "opportunity",
  "probe",
  "context",
  "poc",
  "patch",
  "pr_draft",
] as const;

class LocalFetchWorktreeManager extends WorktreeManager {
  constructor(private readonly remotePath: string) {
    super();
  }

  override runGit(args: string[], cwd?: string, timeoutMs = 25000) {
    const mapped = [...args];
    const fetchIndex = mapped.indexOf("fetch");
    const originIndex =
      fetchIndex >= 0 ? mapped.indexOf("origin", fetchIndex) : -1;
    if (fetchIndex >= 0 && originIndex >= 0)
      mapped[originIndex] = this.remotePath;
    return super.runGit(mapped, cwd, timeoutMs);
  }
}

describe("OpenContrib MCP Contract Tests & Schema Invariants", () => {
  const server = createOpenContribMcpServer();
  const tools = (server as any)._registeredTools;
  const resources = (server as any)._registeredResources;
  const prompts = (server as any)._registeredPrompts;

  it("keeps every canonical protocol MCP tool registered", () => {
    for (const definition of Object.values(PROTOCOL_CONTRACT_PHASES)) {
      expect(tools[definition.mcp.tool]).toBeDefined();
      expect(tools[definition.mcp.tool].handler).toBeFunction();
    }
  });

  it("verifies all registered MCP tools have well-defined input schemas and handler functions", () => {
    const expectedTools = [
      "contrib_scout",
      "contrib_rank_opportunity",
      "contrib_qualify_issue",
      "contrib_assess_feasibility",
      "contrib_diagnose_manifests",
      "contrib_assemble_context",
      "contrib_prepare_workspace",
      "contrib_collect_evidence",
      "contrib_capture_red",
      "contrib_verify_green",
      "contrib_verify_poc",
      "contrib_audit_governance",
      "contrib_analyze_impact",
      "contrib_diagnose_ci",
      "contrib_render_pr_template",
      "contrib_render_issue_claim",
      "contrib_sync_flywheel",
      "contrib_track_pr_status",
      "contrib_lint_markdown",
      "contrib_purge_sandbox",
      "contrib_doctor",
      "contrib_create_run",
      "contrib_save_artifact",
      "contrib_get_run",
      "contrib_resume_run",
      "contrib_eval_prepare_judge",
      "contrib_eval_parse_judgment",
      "contrib_resolve_pointer",
      "contrib_list_pointers",
      "contrib_probe_plan",
      "contrib_probe_run",
      "contrib_probe_hotspot",
      "contrib_probe_fuzz",
      "contrib_request_approval",
      "contrib_submit_pr",
      "contrib_plan_capabilities",
      "contrib_list_plugins",
      "contrib_plugin_info",
      "contrib_run_pipeline",
    ];

    expect(Object.keys(tools).length).toBe(expectedTools.length);
    for (const toolName of expectedTools) {
      expect(tools[toolName]).toBeDefined();
      expect(tools[toolName].handler).toBeFunction();
    }
  });

  it("contract test: contrib_analyze_impact catches cross-platform filepath.ToSlash traps", async () => {
    const result = await tools["contrib_analyze_impact"].handler({
      modifiedFiles: ["internal/tool/code_search.go"],
      patchContent: "+normalized := filepath.ToSlash(path)",
    });

    expect(result.content).toBeDefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.analysis.isCompliant).toBe(false);
    expect(parsed.analysis.crossPlatformHazards.length).toBeGreaterThan(0);
  });

  it("contract test: contrib_diagnose_ci parses multi-line CI test failures", async () => {
    const result = await tools["contrib_diagnose_ci"].handler({
      rawLogText:
        "--- FAIL: TestCodeSearch_RejectsBackslashPathTraversal (0.00s)\n    code_search_test.go:613: failed",
    });

    expect(result.content).toBeDefined();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("failure_detected");
    expect(parsed.report.totalFailedTests).toBe(1);
    expect(parsed.report.failedTests[0].testName).toBe(
      "TestCodeSearch_RejectsBackslashPathTraversal",
    );
  });

  it("contract test: contrib_rank_opportunity derives signals without prescribing decisions", async () => {
    const result = await tools["contrib_rank_opportunity"].handler({
      issue: {
        number: 101,
        title: "fix: handle falsy value in cache",
        body: "ShortCache returns undefined when cached value is false or 0",
        labels: ["bug"],
        createdAt: "2026-08-01T00:00:00Z",
        commentsCount: 2,
        isOpen: true,
        assigneesCount: 0,
      },
      repository: {
        fullName: "bytedance/flowgram.ai",
        stars: 1200,
      },
    });

    expect(result.content).toBeDefined();
    expect(result.content[0].type).toBe("text");
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.status).toBe("success");
    expect(parsed.signals).toBeDefined();
    expect(typeof parsed.signals.signals.skillMatch).toBe("number");
    expect(typeof parsed.signals.signals.environmentFeasibility).toBe("number");
    expect(typeof parsed.signals.signals.issueActionability).toBe("number");
  });

  it("contract test: Run ID path traversal is strictly rejected across run tools", async () => {
    const maliciousRunId = "../../etc/passwd";

    const saveResult = await tools["contrib_save_artifact"].handler({
      runId: maliciousRunId,
      artifactType: "patch",
      content: "malicious patch",
    });
    expect(saveResult.isError).toBe(true);
    expect(saveResult.content[0].text).toContain("Security error");

    const getResult = await tools["contrib_get_run"].handler({
      runId: maliciousRunId,
    });
    expect(getResult.isError).toBe(true);
    expect(getResult.content[0].text).toContain("Security error");
  });

  it("contract test: contrib_create_run and contrib_save_artifact lifecycle with schemaVersion and event tracking", async () => {
    // PATCH_DRAFTED requires a prepared workspace, so use contrib_prepare_workspace
    // to save the workspace artifact and advance to WORKSPACE_PREPARED.
    const tempDir = mkdtempSync(join(tmpdir(), "opencontrib-contract-test-"));
    const bareDir = mkdtempSync(join(tmpdir(), "opencontrib-contract-remote-"));
    rmSync(bareDir, { recursive: true, force: true });
    spawnSync("git", ["init", "-b", "main"], { cwd: tempDir });
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: tempDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
    });
    writeFileSync(join(tempDir, "README.md"), "# Test\n");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    spawnSync("git", ["clone", "--bare", tempDir, bareDir]);
    const githubUrl = "https://github.com/test-org/contract-test-repo.git";
    spawnSync("git", ["remote", "add", "origin", githubUrl], { cwd: tempDir });
    const localTools = (
      createOpenContribMcpServer({
        worktreeManager: new LocalFetchWorktreeManager(bareDir),
      }) as any
    )._registeredTools;
    const createResult = await localTools["contrib_create_run"].handler({
      repoFullName: "test-org/contract-test-repo",
      issueNumber: 42,
      issueTitle: "Contract test bug",
    });
    const res = JSON.parse(createResult.content[0].text);
    const manifest = res.manifest;

    const wsResult = await localTools["contrib_prepare_workspace"].handler({
      repoFullName: "test-org/contract-test-repo",
      issueOrTaskId: 42,
      localRepoPath: tempDir,
      runId: manifest.runId,
    });
    expect(wsResult.isError).toBeUndefined();
    const wsData = JSON.parse(wsResult.content[0].text);
    expect(wsData.status).toBe("success");

    try {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }

    // Advance to RED_CAPTURED using the canonical writer
    const { saveCanonicalArtifact } =
      await import("../../core/src/run/canonical-writer.js");
    const { buildContributionRunManager } = await import("@opencontrib/core");
    const testRunManager = buildContributionRunManager();
    saveCanonicalArtifact(
      testRunManager,
      manifest.runId,
      "evidence_red",
      {
        command: "bun test",
        observedOutputSnippet: "failed",
        exitCode: 1,
        sourceTreeSha256: "a".repeat(64),
        capturedAt: new Date().toISOString(),
        assertionMatched: true,
      } as any,
      "RED_CAPTURED",
    );

    // Save the phase-bound patch; the server derives PATCH_DRAFTED.
    const saveResult = await localTools["contrib_save_artifact"].handler({
      runId: manifest.runId,
      artifactType: "patch",
      content: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
    });
    expect(saveResult.isError).toBeUndefined();
    const saved = JSON.parse(saveResult.content[0].text).saved;
    expect(saved.artifactType).toBe("patch");

    // Get run summary
    const getResult = await localTools["contrib_get_run"].handler({
      runId: manifest.runId,
    });
    const summary = JSON.parse(getResult.content[0].text).run;
    expect(summary.manifest.currentPhase).toBe("PATCH_DRAFTED");
    expect(summary.events).toBeArray();
    expect(summary.events.length).toBeGreaterThanOrEqual(2);

    // Resume run
    const resumeResult = await localTools["contrib_resume_run"].handler({
      runId: manifest.runId,
    });
    const resume = JSON.parse(resumeResult.content[0].text).resume;
    expect(resume.currentPhase).toBe("PATCH_DRAFTED");
    expect(resume.suggestedNextAction).toBe("verify_green");
  });

  it("contract test: WORKSPACE_PREPARED -> PATCH_DRAFTED must fail without a RED baseline artifact", async () => {
    const createResult = await tools["contrib_create_run"].handler({
      repoFullName: "test-org/contract-negative-repo",
      issueNumber: 43,
      issueTitle: "Negative contract test",
    });
    const manifest = JSON.parse(createResult.content[0].text).manifest;

    // Attempt to save a phase-bound patch without evidence_red.
    const saveResult = await tools["contrib_save_artifact"].handler({
      runId: manifest.runId,
      artifactType: "patch",
      content: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
    });
    expect(saveResult.isError).toBe(true);

    // The run must still be in INITIALIZED — the failed advance was rejected.
    const getResult = await tools["contrib_get_run"].handler({
      runId: manifest.runId,
    });
    const summary = JSON.parse(getResult.content[0].text).run;
    expect(summary.manifest.currentPhase).toBe("INITIALIZED");
  });

  it("contract test: contrib_prepare_workspace passes runId and saves workspace artifact with run-isolated branch", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "opencontrib-test-repo-"));
    const bareDir = mkdtempSync(join(tmpdir(), "opencontrib-test-remote-"));
    rmSync(bareDir, { recursive: true, force: true });
    spawnSync("git", ["init", "-b", "main"], { cwd: tempDir });
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: tempDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
    });
    writeFileSync(join(tempDir, "README.md"), "# Test\n");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: tempDir });
    spawnSync("git", ["clone", "--bare", tempDir, bareDir]);
    const githubUrl = "https://github.com/test-org/test-repo.git";
    spawnSync("git", ["remote", "add", "origin", githubUrl], { cwd: tempDir });
    const localTools = (
      createOpenContribMcpServer({
        worktreeManager: new LocalFetchWorktreeManager(bareDir),
      }) as any
    )._registeredTools;

    const runResult = await localTools["contrib_create_run"].handler({
      repoFullName: "test-org/test-repo",
      issueNumber: 101,
    });
    const runId = JSON.parse(runResult.content[0].text).manifest.runId;

    const wsResult = await localTools["contrib_prepare_workspace"].handler({
      repoFullName: "test-org/test-repo",
      issueOrTaskId: 101,
      localRepoPath: tempDir,
      runId,
    });

    expect(wsResult.isError).toBeUndefined();
    const ws = JSON.parse(wsResult.content[0].text);
    expect(ws.status).toBe("success");
    expect(ws.branchName).toMatch(/opencontrib\/(fix-101|run-)/);
    expect(ws.baseCommitSha).toBeDefined();
    expect(ws.persistence?.saved).toBe(true);

    // Verify evidence boundary auto-resolution from runId
    const evResult = await localTools["contrib_collect_evidence"].handler({
      cwd: ws.workspacePath,
      testCommand: 'echo "test pass"',
      runId,
    });
    expect(evResult.isError).toBeUndefined();
    const ev = JSON.parse(evResult.content[0].text);
    expect(ev.status).toBe("PARTIAL_SUCCESS");
    expect(ev.persistence?.saved).toBe(false);
    expect(ev.persistence?.error).toContain(
      "Diagnostic evidence is not authoritative",
    );

    try {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(bareDir, { recursive: true, force: true });
    } catch {
      // Best-effort temp dir cleanup
    }
  });

  it("contract test: MCP resources (doctor, memory, runs) and prompt opencontrib_workflow_guide are registered", () => {
    expect(resources["opencontrib://doctor"]).toBeDefined();
    expect(resources["opencontrib://memory"]).toBeDefined();
    expect(resources["opencontrib://runs"]).toBeDefined();
    expect(prompts["opencontrib_workflow_guide"]).toBeDefined();
  });

  // ---- P0-01: prompt derives from canonical PROTOCOL_CONTRACT_PHASES ----
  it("P0-01: prompt opencontrib_workflow_guide derives steps from canonical PROTOCOL_CONTRACT_PHASES", async () => {
    const result = await prompts["opencontrib_workflow_guide"].callback({
      repoFullName: "x/y",
      issueNumber: "42",
    });
    const text = result.messages[0].content.text as string;
    // Session init MUST appear before any discovery step
    const createRunIdx = text.indexOf("contrib_create_run");
    const scoutIdx = text.indexOf("contrib_scout");
    expect(createRunIdx).toBeGreaterThan(-1);
    expect(scoutIdx).toBeGreaterThan(-1);
    expect(createRunIdx).toBeLessThan(scoutIdx);
  });

  it("P0-01: prompt enforces capture_red before verify_green ordering", async () => {
    const result = await prompts["opencontrib_workflow_guide"].callback({});
    const text = result.messages[0].content.text as string;
    const captureRedIdx = text.indexOf("contrib_capture_red");
    const verifyGreenIdx = text.indexOf("contrib_verify_green");
    expect(captureRedIdx).toBeGreaterThan(-1);
    expect(verifyGreenIdx).toBeGreaterThan(-1);
    expect(captureRedIdx).toBeLessThan(verifyGreenIdx);
  });

  it("P0-01: prompt orders PR drafting before governance audit", async () => {
    const result = await prompts["opencontrib_workflow_guide"].callback({});
    const text = result.messages[0].content.text as string;
    const renderTemplateIdx = text.indexOf("contrib_render_pr_template");
    const auditGovernanceIdx = text.indexOf("contrib_audit_governance");
    expect(renderTemplateIdx).toBeGreaterThan(-1);
    expect(auditGovernanceIdx).toBeGreaterThan(-1);
    expect(renderTemplateIdx).toBeLessThan(auditGovernanceIdx);
  });

  it("P0-01: prompt requires SubmissionPort-only submission via contrib_submit_pr", async () => {
    const result = await prompts["opencontrib_workflow_guide"].callback({});
    const text = result.messages[0].content.text as string;
    expect(text).toContain("contrib_request_approval");
    expect(text).toContain("contrib_submit_pr");
    expect(text).toContain("SubmissionPort");
    expect(text).not.toContain("contrib_collect_evidence");
    expect(text).not.toContain("preFixAssertionProbe");
    expect(text).toContain("allowed from `WORKSPACE_PREPARED`");
    // Must prohibit, rather than prescribe, direct GitHub API writes.
    expect(text).toContain("DO NOT call GitHub create_pull_request directly.");
    expect(text).toContain("DO NOT call GitHub MCP or GitHub API");
    const directWriteInstruction = text
      .split("\n")
      .filter((line) =>
        /(?:run|execute|use|call|invoke).*\b(?:gh\s+pr\s+create|create_pull_request|POST\s+\/repos\/.*\/pulls)\b/i.test(
          line,
        ),
      )
      .filter(
        (line) => !/\b(?:do not|never|prohibit(?:ed|ion)?)\b/i.test(line),
      );
    expect(directWriteInstruction).toEqual([]);
  });

  // ---- P0-02: contrib_save_artifact schema restricts authoritative types ----
  it("P0-02: contrib_save_artifact input schema excludes authoritative artifact types", () => {
    const schema = tools["contrib_save_artifact"].inputSchema;
    for (const type of AUTHORITATIVE_ARTIFACT_TYPES) {
      expect(
        schema.safeParse({
          runId: "run_test_foo",
          artifactType: type,
          content: "{}",
        }).success,
      ).toBe(false);
    }
    for (const type of DRAFT_ARTIFACT_TYPES) {
      expect(
        schema.safeParse({
          runId: "run_test_foo",
          artifactType: type,
          content: "{}",
        }).success,
      ).toBe(true);
    }
  });

  it("P0-02: contrib_save_artifact rejects authoritative artifact types at runtime", async () => {
    for (const type of AUTHORITATIVE_ARTIFACT_TYPES) {
      const result = await tools["contrib_save_artifact"].handler({
        runId: "run_test_foo",
        artifactType: type as any,
        content: "{}",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("authoritative");
    }
  });

  it("P0-02: contrib_save_artifact accepts all non-authoritative draft types (fails at run-not-found, not schema)", async () => {
    for (const type of DRAFT_ARTIFACT_TYPES) {
      const result = await tools["contrib_save_artifact"].handler({
        runId: "run_test_foo",
        artifactType: type,
        content: "{}",
      });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).not.toContain("authoritative");
      expect(result.content[0].text).toContain("does not exist");
    }
  });
});
