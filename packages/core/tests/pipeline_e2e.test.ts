/**
 * End-to-end pipeline test for the refactored `AgentOrchestrator`.
 *
 * The orchestrator used to be a 530-line god method. It is now a driver over
 * 14 `PipelineStep`s. Because every collaborator is injected through
 * `PipelineDeps` (DIP), we can run the *entire* pipeline offline with test
 * doubles — something the old design made impossible. This lock the
 * step-by-step behavior so future refactors can't silently drift.
 */
import { EvidenceService } from "../src/evidence/evidence-service.js";
import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { FixedClock } from "../src/ports/clock.port.js";
import { MockLLMProvider } from "../src/testkit/mock-llm.js";
import { LLMService } from "../src/llm/llm-service.js";
import { ContributionStateMachine } from "../src/orchestration/state-machine.js";
import { ContextAssembler } from "../src/discovery/context-assembler.js";
import { ContributionRunManager } from "../src/run/run-manager.js";
import { ActiveSessionManager } from "../src/run/active-session.js";
import type { PipelineDeps } from "../src/orchestration/pipeline/types.js";
import {
  ContextAssemblyStep,
  ImplementValidateLoopStep,
  WorkspaceAllocationStep,
  buildReproductionDesignPrompt,
  deriveTargetedReproductionTestCommand,
  resolveGreenVerificationTestCommand,
  selectVerificationCommand,
} from "../src/orchestration/pipeline/steps.js";

describe("Pipeline RED command selection", () => {
  it("scopes a recursive Go test command to generated test-file packages", () => {
    expect(
      deriveTargetedReproductionTestCommand("go test ./...", [
        "internal/worker/worker_test.go",
        "pkg/parser/parser_test.go",
      ]),
    ).toBe("go test ./internal/worker ./pkg/parser");
    expect(
      deriveTargetedReproductionTestCommand("go test ./...", ["worker_test.go"]),
    ).toBe("go test .");
    expect(
      deriveTargetedReproductionTestCommand("go test ./...", ["worker_TEST.GO"]),
    ).toBeUndefined();
    expect(
      deriveTargetedReproductionTestCommand("go test ./...", ["pkg/parser.go"]),
    ).toBeUndefined();
    expect(
      deriveTargetedReproductionTestCommand("go test ./...", ["../outside_test.go"]),
    ).toBeUndefined();
    expect(
      deriveTargetedReproductionTestCommand("go test ./...", [
        "internal/.../worker_test.go",
      ]),
    ).toBeUndefined();
  });

  it("tells Node RED designs how to return a scoped test command", () => {
    const prompt = buildReproductionDesignPrompt("base prompt", "npm test");

    expect(prompt).toContain('npm and pnpm use " -- <files>"');
    expect(prompt).toContain('"npm test" with "src/parser.test.ts" becomes "npm test -- src/parser.test.ts"');
    expect(buildReproductionDesignPrompt("base prompt", "cargo test")).toContain(
      "select integration test targets under tests/",
    );
  });

  it("matches Bun guidance to the derived scoped command", () => {
    const prompt = buildReproductionDesignPrompt("base prompt", "bun run test");

    expect(prompt).toContain(
      '"bun run test" becomes "bun run test ./src/parser.test.ts"',
    );
    expect(
      deriveTargetedReproductionTestCommand("bun run test", ["src/parser.test.ts"]),
    ).toBe("bun run test ./src/parser.test.ts");
  });

  it("reports the scoped command that was verified", () => {
    expect(
      selectVerificationCommand({
        evidenceReport: { status: "passed" } as any,
        repositoryTestCmd: "go test ./...",
        testCmd: "go test ./pkg/parser",
      }),
    ).toBe("go test ./pkg/parser");
    expect(
      selectVerificationCommand({
        evidenceReport: undefined,
        repositoryTestCmd: "go test ./...",
        testCmd: "go test ./pkg/parser",
      }),
    ).toBe("");
  });

  it("does not schedule RED execution for documentation-only opportunities", async () => {
    const ctx: any = {
      selectedOpp: {
        repoFullName: "owner/repo",
        issueNumber: 1,
        title: "Fix README typo",
        body: "",
        primaryLanguage: "Go",
        feasibility: { scope: "docs_only" },
      },
      workspace: { workspacePath: "/tmp/workspace" },
      runId: "run_docs_only",
    };
    const deps: any = {
      stateMachine: { transition: () => {} },
      contextAssembler: {
        assemble: async () => ({
          repoContext: {
            runnableCommands: { testCommand: "go test ./..." },
            testCommandHint: "go test ./...",
          },
        }),
        formatContextPrompt: () => "prompt",
      },
      runManager: {
        getRun: () => ({ runId: "run_docs_only", artifacts: {} }),
        saveArtifact: () => {},
      },
    };

    await new ContextAssemblyStep().execute(ctx, deps);

    expect(ctx.testCmd).toBeUndefined();
  });

  it("keeps the repository test command separate from scoped RED", async () => {
    const ctx: any = {
      selectedOpp: {
        repoFullName: "owner/repo",
        issueNumber: 2,
        title: "Fix parser regression",
        body: "",
        primaryLanguage: "Go",
        feasibility: { scope: "logic" },
      },
      workspace: { workspacePath: "/tmp/workspace" },
      runId: "run_parser_fix",
    };
    const deps: any = {
      stateMachine: { transition: () => {} },
      contextAssembler: {
        assemble: async () => ({
          repoContext: {
            runnableCommands: { testCommand: "go test ./..." },
            testCommandHint: "go test ./...",
          },
        }),
        formatContextPrompt: () => "prompt",
      },
      runManager: {
        getRun: () => ({ runId: "run_parser_fix", artifacts: {} }),
        saveArtifact: () => {},
      },
    };

    await new ContextAssemblyStep().execute(ctx, deps);
    ctx.testCmd = deriveTargetedReproductionTestCommand("go test ./...", [
      "pkg/parser/parser_test.go",
    ]);

    expect(ctx.testCmd).toBe("go test ./pkg/parser");
    expect(ctx.repositoryTestCmd).toBe("go test ./...");
    expect(
      resolveGreenVerificationTestCommand(ctx.testCmd, ctx.repositoryTestCmd),
    ).toBe(ctx.testCmd);
  });

  it("uses the private run identifier instead of a public issue number for workspace allocation", async () => {
    const root = mkdtempSync(join(tmpdir(), "oc-private-pipeline-workspace-"));
    const previousHome = process.env.OPENCONTRIB_HOME;
    process.env.OPENCONTRIB_HOME = join(root, "home");
    try {
      const runManager = new ContributionRunManager({
        baseDir: join(root, "runs"),
        activeSession: new ActiveSessionManager(join(root, "active_session.json")),
      });
      const runId = runManager.createRun({ repoFullName: "owner/repo" }).runId;
      let allocatedTarget: string | number | undefined;
      const ctx: any = {
        runId,
        selectedOpp: {
          repoFullName: "owner/repo",
          issueNumber: 42,
          title: "Security report",
          body: "",
        },
      };
      const deps: any = {
        runManager,
        stateMachine: { transition: () => {}, setWorkspace: () => {} },
        worktreeManager: {
          createIsolatedWorkspace: (input: { issueOrTaskId: string | number }) => {
            allocatedTarget = input.issueOrTaskId;
            return {
              workspacePath: join(root, "workspace"),
              branchName: "opencontrib/run-private",
              isWorktree: true,
              baseRepoPath: join(root, "repo"),
              baseCommitSha: "a".repeat(40),
              baseBranch: "main",
            };
          },
          runGit: () => ({ success: true, stdout: "", stderr: "" }),
          cleanupWorkspace: () => {},
        },
      };

      await new WorkspaceAllocationStep().execute(ctx, deps);

      expect(allocatedTarget).toBe(runId);
      expect(runManager.getRun(runId)?.manifest.issueNumber).toBeUndefined();
    } finally {
      if (previousHome === undefined) delete process.env.OPENCONTRIB_HOME;
      else process.env.OPENCONTRIB_HOME = previousHome;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("omits public issue numbers when assembling context for a private disclosure run", async () => {
    const privateGate = {
      sourceCommitSha: "a".repeat(40),
      policy: {
        hasGatingRules: false,
        requiresIssueApprovalBeforePr: false,
        autoClosesNewIssues: false,
        hasLgtmApprovalProtocol: false,
        restrictedTriageHours: false,
        privateVulnerabilityDisclosure: true,
        reasons: [],
        suggestedContributorAction: "Use the private security channel.",
        matchedKeywords: [],
      },
    };
    let assembledInput: Record<string, unknown> | undefined;
    const ctx: any = {
      runId: "run_private_context",
      selectedOpp: {
        repoFullName: "owner/repo",
        issueNumber: 42,
        title: "Security report",
        body: "Report details",
        primaryLanguage: "Go",
      },
      workspace: { workspacePath: "/private/workspace" },
    };
    const deps: any = {
      stateMachine: { transition: () => {} },
      contextAssembler: {
        assemble: async (input: Record<string, unknown>) => {
          assembledInput = input;
          return {
            repoContext: {
              runnableCommands: { testCommand: "go test ./..." },
              testCommandHint: "go test ./...",
            },
          };
        },
        formatContextPrompt: () => "prompt",
      },
      worktreeManager: { runGit: () => ({ success: true, stdout: "", stderr: "" }) },
      runManager: {
        getRun: () => ({
          artifacts: { workspace: { communityGate: privateGate } },
        }),
        saveArtifact: () => {},
      },
    };

    await new ContextAssemblyStep().execute(ctx, deps);

    expect(assembledInput?.issueNumber).toBeUndefined();
  });
});

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

describe("Pipeline command review regressions", () => {
  it.each([
    ["npm test", "npm test -- tests/parser.test.ts"],
    ["pnpm test", "pnpm test -- tests/parser.test.ts"],
    ["yarn test", "yarn test tests/parser.test.ts"],
    ["bun test", "bun test ./tests/parser.test.ts"],
  ])("scopes root command %s", (command, expected) => {
    expect(deriveTargetedReproductionTestCommand(command, ["tests/parser.test.ts"])).toBe(expected);
    expect(deriveTargetedReproductionTestCommand(command, [])).toBeUndefined();
    expect(deriveTargetedReproductionTestCommand(command, ["../parser.test.ts"])).toBeUndefined();
    expect(deriveTargetedReproductionTestCommand(command, ["tests/parser.test.ts; echo bad"])).toBeUndefined();
    expect(deriveTargetedReproductionTestCommand(command, ["-parser.test.ts"])).toBeUndefined();
  });

  it("preserves a command already scoped to a test file", () => {
    expect(deriveTargetedReproductionTestCommand("bun test ./tests/parser.test.ts", ["tests/parser.test.ts"]))
      .toBe("bun test ./tests/parser.test.ts");
    expect(deriveTargetedReproductionTestCommand("bun test ./tests/a.test.ts", ["tests/b.test.ts"]))
      .toBeUndefined();
    expect(deriveTargetedReproductionTestCommand("bun run test", ["tests/parser.test.ts"]))
      .toBe("bun run test ./tests/parser.test.ts");
    expect(deriveTargetedReproductionTestCommand("bun run test ./tests/parser.test.ts", ["tests/parser.test.ts"]))
      .toBe("bun run test ./tests/parser.test.ts");
  });

  it("replaces existing Node runner operands with the selected RED test files", () => {
    expect(
      deriveTargetedReproductionTestCommand("npm exec --no -- mocha", ["test/parser.test.js"]),
    ).toBe("npm exec --no -- mocha test/parser.test.js");
    expect(
      deriveTargetedReproductionTestCommand("node --test", ["test/parser.test.js"]),
    ).toBe("node --test test/parser.test.js");
    expect(
      deriveTargetedReproductionTestCommand("yarn exec mocha", ["test/parser.test.js"]),
    ).toBe("yarn exec mocha test/parser.test.js");
    expect(
      deriveTargetedReproductionTestCommand("npm exec --no -- mocha --config .mocharc.json", ["test/parser.test.js"]),
    ).toBe("npm exec --no -- mocha --config .mocharc.json test/parser.test.js");
    expect(
      deriveTargetedReproductionTestCommand("yarn exec mocha --config .mocharc.json", ["test/parser.test.js"]),
    ).toBe("yarn exec mocha --config .mocharc.json test/parser.test.js");
    expect(
      deriveTargetedReproductionTestCommand("npm exec --no -- mocha --config ../outside.json", ["test/parser.test.js"]),
    ).toBeUndefined();
  });

  it("retains safe Bun config options when appending scoped RED test files", () => {
    expect(
      deriveTargetedReproductionTestCommand("bun test --config ./bunfig.toml", ["tests/parser.test.ts"]),
    ).toBe("bun test --config ./bunfig.toml tests/parser.test.ts");
    expect(
      deriveTargetedReproductionTestCommand("bun test -c bunfig.toml", ["tests/parser.test.ts"]),
    ).toBe("bun test -c bunfig.toml tests/parser.test.ts");
    expect(
      deriveTargetedReproductionTestCommand("bun test --config=./bunfig.toml", ["tests/parser.test.ts"]),
    ).toBe("bun test --config=./bunfig.toml tests/parser.test.ts");

    expect(
      deriveTargetedReproductionTestCommand("bun test --config ../outside.toml", ["tests/parser.test.ts"]),
    ).toBeUndefined();
    expect(
      deriveTargetedReproductionTestCommand("bun test --config /tmp/bunfig.toml", ["tests/parser.test.ts"]),
    ).toBeUndefined();
    expect(
      deriveTargetedReproductionTestCommand("bun test --watch", ["tests/parser.test.ts"]),
    ).toBeUndefined();
  });

  it("scopes supported compiled-language commands to selected test targets", () => {
    expect(deriveTargetedReproductionTestCommand("cargo test", ["tests/parser.rs"]))
      .toBe("cargo test --test parser");
    expect(deriveTargetedReproductionTestCommand("cargo test", ["crates/cli/tests/parser.rs"]))
      .toBe("cargo test --manifest-path crates/cli/Cargo.toml --test parser");
    expect(deriveTargetedReproductionTestCommand("cargo test", ["src/parser.rs"]))
      .toBeUndefined();
    expect(deriveTargetedReproductionTestCommand("./gradlew test", ["src/test/kotlin/com/example/ParserTest.kt"]))
      .toBe("./gradlew test --tests com.example.ParserTest");
    expect(
      deriveTargetedReproductionTestCommand("mvn test", [
        "src/test/java/com/example/ParserTest.java",
      ]),
    )
      .toBe("mvn test -Dtest=com.example.ParserTest");
    expect(
      deriveTargetedReproductionTestCommand("mvn test", [
        "module-a/src/test/java/com/example/ParserTest.java",
      ]),
    )
      .toBe(
        "mvn -pl module-a -am test -Dtest=com.example.ParserTest -Dsurefire.failIfNoSpecifiedTests=false",
      );
    expect(
      deriveTargetedReproductionTestCommand("mvn test", [
        "module-a/src/test/java/com/example/ParserTest.java",
        "module-b/src/test/java/com/example/OtherTest.java",
      ]),
    ).toBe(
      "mvn -pl module-a,module-b -am test -Dtest=com.example.OtherTest,com.example.ParserTest -Dsurefire.failIfNoSpecifiedTests=false",
    );
    expect(
      deriveTargetedReproductionTestCommand("mvn test", [
        "src/test/java/com/example/ParserTest.java",
        "module-a/src/test/java/com/example/OtherTest.java",
      ]),
    ).toBeUndefined();
    expect(deriveTargetedReproductionTestCommand("dotnet test", ["tests/ParserTests.cs"]))
      .toBe("dotnet test --filter FullyQualifiedName~ParserTests");
    expect(deriveTargetedReproductionTestCommand("swift test", ["Tests/ParserTests.swift"]))
      .toBe("swift test --filter ParserTests");
    expect(
      deriveTargetedReproductionTestCommand("./vendor/bin/phpunit", ["tests/ParserTest.php"]),
    ).toBe("./vendor/bin/phpunit tests/ParserTest.php");
    expect(
      deriveTargetedReproductionTestCommand(".\\vendor\\bin\\phpunit", ["tests/ParserTest.php"]),
    ).toBe("./vendor/bin/phpunit tests/ParserTest.php");
    expect(
      deriveTargetedReproductionTestCommand("./vendor/bin/phpunit", ["../ParserTest.php"]),
    ).toBeUndefined();
  });

  it("sends the scoped RED command to canonical GREEN verification", async () => {
    const verify = spyOn(EvidenceService.prototype, "verifyGreen").mockResolvedValue({
      stressLoopPassed: true, passedUnitTestsCount: 1, failedUnitTestsCount: 0, exitCode: 0,
    } as any);
    try {
      const context: any = {
        workspace: { workspacePath: "fixture" }, prompt: "prompt", runId: "run_fixture",
        activePatch: { files: [] }, testCmd: "go test ./pkg/parser",
        repositoryTestCmd: "go test ./...", preFixReproductionCaptured: true,
      };
      await new ImplementValidateLoopStep().execute(context, {
        runManager: {}, stateMachine: { transition: () => {}, setReproductionCaptured: () => {} },
        worktreeManager: { applySurgicalFilesSafely: () => ({ appliedFiles: [], errors: [] }) },
      } as any);
      expect(verify).toHaveBeenCalledWith(expect.objectContaining({ testCommand: "go test ./pkg/parser" }));
      expect(context.validationStatus).toBe("VALIDATED");
    } finally {
      verify.mockRestore();
    }
  });

});
