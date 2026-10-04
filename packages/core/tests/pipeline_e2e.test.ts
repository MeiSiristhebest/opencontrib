/**
 * End-to-end pipeline test for the refactored `AgentOrchestrator`.
 *
 * The orchestrator used to be a 530-line god method. It is now a driver over
 * 14 `PipelineStep`s. Because every collaborator is injected through
 * `PipelineDeps` (DIP), we can run the *entire* pipeline offline with test
 * doubles — something the old design made impossible. This lock the
 * step-by-step behavior so future refactors can't silently drift.
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FixedClock } from "../src/ports/clock.port.js";
import { MockLLMProvider } from "../src/testkit/mock-llm.js";
import { LLMService } from "../src/llm/llm-service.js";
import { ContributionStateMachine } from "../src/orchestration/state-machine.js";
import { ContextAssembler } from "../src/discovery/context-assembler.js";
import type { PipelineDeps } from "../src/orchestration/pipeline/types.js";

function buildDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps {
  const workspacePath = mkdtempSync(join(tmpdir(), "oc-e2e-"));
  const llmService = new LLMService(new MockLLMProvider());
  const stateMachine = new ContributionStateMachine({
    mode: "dry_run",
    allowRealPr: false,
    autoPurgeSandboxOnFinish: true,
  });

  const base: PipelineDeps = {
    client: {
      searchIssues: async () => ({
        items: [
          {
            number: 42,
            title: "Memory leak in listener",
            body: "There is a memory leak in the event listener.",
            labels: [],
            repository_url: "https://api.github.com/repos/octocat/hello-world",
            html_url: "https://github.com/octocat/hello-world/issues/42",
            assignee: null,
            assignees: [],
            pull_request: undefined,
            locked: false,
            state: "open",
            created_at: new FixedClock().nowIso(),
            user: { login: "alice" },
          },
        ],
        status: "COMPLETE" as const,
        pagesFetched: 1,
        pagesRequested: 1,
      }),
      listRepoIssues: async () => ({ status: "OK" as const, data: [] }),
      getRepoDetails: async () => ({
        status: "OK" as const,
        data: {
          stars: 120,
          defaultBranch: "main",
          isFork: false,
          isArchived: false,
          description: "Offline pipeline fixture",
        },
      }),
      getRepoDirectoryContentsResult: async () => ({
        status: "OK" as const,
        data: [],
      }),
      getRepoTextFileResult: async () => ({
        status: "OK" as const,
        data: null,
      }),
      getRepoTextFile: async () => null,
      getIssueComments: async () => ({ status: "OK" as const, data: [] }),
      getIssueLinkedPrsCount: async () => ({ status: "OK" as const, data: 0 }),
    } as any,
    llmService,
    memory: { recordSuccess: () => {} } as any,
    flywheel: { saveRecord: () => {} } as any,
    worktreeManager: {
      // The canonical workspace snapshot now inspects repository policy at the
      // verified base commit. This offline double represents a clean baseline
      // with no community-policy files.
      runGit: () => ({ success: true, stdout: "", stderr: "" }),
      createIsolatedWorkspace: () => ({
        workspacePath,
        branchName: "fix/branch",
        isWorktree: false,
        baseRepoPath: workspacePath,
        baseCommitSha: "a".repeat(40),
      }),
      applySurgicalFilesSafely: () => ({
        appliedFiles: [{ path: "src/index.ts", operation: "create" }],
        errors: [],
      }),
      cleanupWorkspace: () => {},
    } as any,
    prService: {
      submitPullRequest: async () => ({
        prUrl: "https://github.com/x/y/pull/1",
        prNumber: 1,
        branchUrl: "",
        isDraft: true,
        status: "SUCCESS",
      }),
    } as any,
    // No testCommand → exercises the NO_TEST_AVAILABLE validation branch offline.
    contextAssembler: {
      assemble: async () => ({
        repoContext: {
          runnableCommands: { testCommand: undefined },
          testCommandHint: undefined,
        },
      }),
      formatContextPrompt: () => "PROMPT",
    } as any,
    stateMachine,
    clock: new FixedClock(),
  };

  return { ...base, ...overrides };
}

function profile() {
  return {
    techStack: ["typescript", "react"],
    proficiency: "intermediate",
    focusAreas: ["tooling", "dx"],
    minMatchScore: 50,
  } as any;
}

describe("AgentOrchestrator pipeline (injected, offline)", () => {
  it("runs the full pipeline to DRY_RUN_COMPLETED", async () => {
    const { AgentOrchestrator } =
      await import("../src/orchestration/agent-orchestrator.js");
    const orchestrator = new AgentOrchestrator({ deps: buildDeps() });

    const result = await orchestrator.runPipeline({ profile: profile(), targetRepo: "octocat/hello-world" });

    expect(result.status).toBe("DRY_RUN_COMPLETED");
    expect(result.stage).toBe("COMPLETED");
    expect(result.selectedOpportunity?.repoFullName).toBe(
      "octocat/hello-world",
    );
    expect(result.patchDraft).toBeDefined();
    expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(result.reportSummary).toContain("Dry run completed");
  });

  it("passes workspace history and language into context assembly", async () => {
    const contextAssembler = new ContextAssembler({ getMemory: () => null } as any);
    let assembledContext: ReturnType<typeof contextAssembler.assemble> | undefined;
    const assemble = contextAssembler.assemble.bind(contextAssembler);
    contextAssembler.assemble = (input) => {
      const context = assemble(input);
      assembledContext = context;
      return context;
    };
    const deps = buildDeps({ contextAssembler });
    const gitCalls: string[][] = [];
    let createdWorkspacePath: string | undefined;
    (deps.client as any).getRepoDetails = async () => ({
      status: "OK",
      data: {
        stars: 120,
        defaultBranch: "main",
        isFork: false,
        isArchived: false,
        description: "Offline pipeline fixture",
        primaryLanguage: "Go",
      },
    });
    const createWorkspace = (deps.worktreeManager as any).createIsolatedWorkspace;
    (deps.worktreeManager as any).createIsolatedWorkspace = (...args: any[]) => {
      const result = createWorkspace(...args);
      createdWorkspacePath = result.workspacePath;
      return result;
    };
    (deps.worktreeManager as any).runGit = (args: string[]) => {
      gitCalls.push(args);
      return {
        success: true,
        stdout: args.includes("--format=%B---COMMIT_SEP---")
          ? "[Go] Fix sample---COMMIT_SEP---"
          : "",
        stderr: "",
      };
    };

    const { AgentOrchestrator } =
      await import("../src/orchestration/agent-orchestrator.js");
    const orchestrator = new AgentOrchestrator({ deps });
    const result = await orchestrator.runPipeline({
      profile: profile(),
      targetRepo: "octocat/hello-world",
    });

    expect(result.status).toBe("DRY_RUN_COMPLETED");
    const workspacePath = createdWorkspacePath;
    if (!workspacePath) {
      throw new Error("Workspace allocation did not produce a path");
    }
    expect(gitCalls).toContainEqual([
      "-C",
      workspacePath,
      "log",
      "-n",
      "20",
      "--no-merges",
      "--format=%B---COMMIT_SEP---",
    ]);
    expect(result.selectedOpportunity?.primaryLanguage).toBe("Go");
    expect(
      assembledContext?.repoContext.engineeringFingerprint?.commitStyle.primaryConvention,
    ).toBe("bracketed_component");
    expect(
      assembledContext?.repoContext.engineeringFingerprint?.commitStyle.sampleRecentCommits,
    ).toContain("[Go] Fix sample");
  }, 15000);

  it("halts at HUMAN_GATE in interactive mode when not approved", async () => {
    const { AgentOrchestrator } =
      await import("../src/orchestration/agent-orchestrator.js");
    const deps = buildDeps({
      stateMachine: new ContributionStateMachine({
        mode: "interactive",
        allowRealPr: false,
        autoPurgeSandboxOnFinish: true,
      }),
    });
    const orchestrator = new AgentOrchestrator({ deps });

    const result = await orchestrator.runPipeline({ profile: profile(), targetRepo: "octocat/hello-world" });

    expect(result.status).toBe("HUMAN_APPROVAL_REQUIRED");
    expect(result.stage).toBe("HUMAN_GATE");
    expect(result.reportSummary).toContain("Awaiting human");
  });

  it("blocks at PATCH_DESIGN when no LLM provider is configured", async () => {
    const { AgentOrchestrator } =
      await import("../src/orchestration/agent-orchestrator.js");
    const deps = buildDeps({ llmService: undefined });
    const orchestrator = new AgentOrchestrator({ deps });

    const result = await orchestrator.runPipeline({ profile: profile(), targetRepo: "octocat/hello-world" });

    expect(result.status).toBe("BLOCKED");
    expect(result.stage).toBe("PATCH_DESIGN");
    expect(result.reportSummary).toContain("Pipeline halted");
  });
});
