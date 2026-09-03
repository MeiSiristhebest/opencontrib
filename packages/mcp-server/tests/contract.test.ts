import { describe, expect, it } from "bun:test";
import { spawnSync } from "child_process";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createOpenContribMcpServer } from "../src/server.js";

describe("OpenContrib MCP Contract Tests & Schema Invariants", () => {
  const server = createOpenContribMcpServer();
  const tools = (server as any)._registeredTools;
  const resources = (server as any)._registeredResources;
  const prompts = (server as any)._registeredPrompts;

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
    const createResult = await tools["contrib_create_run"].handler({
      repoFullName: "test-org/contract-test-repo",
      issueNumber: 42,
      issueTitle: "Contract test bug",
    });

    expect(createResult.isError).toBeUndefined();
    const res = JSON.parse(createResult.content[0].text);
    const manifest = res.manifest;
    expect(manifest.schemaVersion).toBe("1.0.0");
    expect(manifest.runId).toStartWith("run_");
    expect(manifest.currentPhase).toBe("INITIALIZED");

    // Save artifact and advance phase
    const saveResult = await tools["contrib_save_artifact"].handler({
      runId: manifest.runId,
      artifactType: "patch",
      content: "--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new",
      autoAdvancePhase: "PATCH_DRAFTED",
    });
    expect(saveResult.isError).toBeUndefined();
    const saved = JSON.parse(saveResult.content[0].text).saved;
    expect(saved.artifactType).toBe("patch");

    // Get run summary
    const getResult = await tools["contrib_get_run"].handler({
      runId: manifest.runId,
    });
    const summary = JSON.parse(getResult.content[0].text).run;
    expect(summary.manifest.currentPhase).toBe("PATCH_DRAFTED");
    expect(summary.events).toBeArray();
    expect(summary.events.length).toBeGreaterThanOrEqual(2);

    // Resume run
    const resumeResult = await tools["contrib_resume_run"].handler({
      runId: manifest.runId,
    });
    const resume = JSON.parse(resumeResult.content[0].text).resume;
    expect(resume.currentPhase).toBe("PATCH_DRAFTED");
    expect(resume.suggestedNextAction).toBe("collect_evidence");
  });

  it("contract test: contrib_prepare_workspace passes runId and saves workspace artifact with run-isolated branch", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "opencontrib-test-repo-"));
    spawnSync("git", ["init", "-b", "main"], { cwd: tempDir });
    spawnSync("git", ["config", "user.name", "Tester"], { cwd: tempDir });
    spawnSync("git", ["config", "user.email", "test@example.com"], {
      cwd: tempDir,
    });
    writeFileSync(join(tempDir, "README.md"), "# Test\n");
    spawnSync("git", ["add", "."], { cwd: tempDir });
    spawnSync("git", ["commit", "-m", "initial"], { cwd: tempDir });

    const runResult = await tools["contrib_create_run"].handler({
      repoFullName: "test-org/test-repo",
      issueNumber: 101,
    });
    const runId = JSON.parse(runResult.content[0].text).manifest.runId;

    const wsResult = await tools["contrib_prepare_workspace"].handler({
      repoFullName: "test-org/test-repo",
      issueOrTaskId: 101,
      localRepoPath: tempDir,
      runId,
    });

    expect(wsResult.isError).toBeUndefined();
    const ws = JSON.parse(wsResult.content[0].text);
    expect(ws.status).toBe("success");
    expect(ws.branchName).toContain("opencontrib/fix-101");
    expect(ws.baseCommitSha).toBeDefined();
    expect(ws.persistence?.saved).toBe(true);

    // Verify evidence boundary auto-resolution from runId
    const evResult = await tools["contrib_collect_evidence"].handler({
      cwd: ws.workspacePath,
      testCommand: 'echo "test pass"',
      runId,
    });
    expect(evResult.isError).toBeUndefined();
    const ev = JSON.parse(evResult.content[0].text);
    expect(ev.status).toBe("success");
    expect(ev.persistence?.saved).toBe(true);

    try {
      rmSync(tempDir, { recursive: true, force: true });
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
});
