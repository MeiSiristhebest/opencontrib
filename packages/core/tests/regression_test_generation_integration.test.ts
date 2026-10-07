import { describe, expect, it } from "bun:test";
import { EvidenceService, hashCommunityGateSnapshot } from "../src/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import { buildRunTransferBundle } from "../src/run/run-transfer.js";
import {
  DevelopmentUnsafeExecutionPort,
  TrustedRunMaterializer,
} from "../src/run/trusted-run-host.js";
import type {
  PreflightLintExecutionJob,
  RawPreflightLintExecutionResult,
} from "../src/run/trusted-execution.port.js";
import { IssueBindingService } from "../src/github/issue-binding-service.js";

describe("Autonomous Regression-Test Generation & Transfer Host Integration", () => {
  it("transfers reproduction files and reproduces RED->GREEN on trusted host", async () => {
    const agentWorkspace = mkdtempSync(join(tmpdir(), "oc-agent-ws-"));
    const hostWorkspace = mkdtempSync(join(tmpdir(), "oc-host-ws-"));
    const agentRuns = mkdtempSync(join(tmpdir(), "oc-agent-runs-"));
    const hostRuns = mkdtempSync(join(tmpdir(), "oc-host-runs-"));

    try {
      // 1. Initialize clean upstream git repo in agentWorkspace
      execFileSync("git", ["init", "-b", "main"], {
        cwd: agentWorkspace,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Tester"], {
        cwd: agentWorkspace,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: agentWorkspace,
        stdio: "ignore",
      });
      writeFileSync(
        join(agentWorkspace, "math.js"),
        "export function mul(a, b) { return 0; }\n",
      );
      // If this repository-controlled script ever executes in the trusted host
      // process instead of through the injected worker, materialization fails.
      writeFileSync(
        join(agentWorkspace, "package.json"),
        JSON.stringify(
          {
            packageManager: "npm@10.8.2",
            scripts: { lint: 'node -e "process.exit(42)"' },
          },
          null,
          2,
        ) + "\n",
      );
      execFileSync("git", ["add", "."], {
        cwd: agentWorkspace,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "initial baseline"], {
        cwd: agentWorkspace,
        stdio: "ignore",
      });
      const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: agentWorkspace,
        encoding: "utf8",
      }).trim();

      // Clone a completely fresh copy for the Host (contains NO math.test.js initially!)
      execFileSync("git", ["clone", agentWorkspace, hostWorkspace], {
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Tester"], {
        cwd: hostWorkspace,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: hostWorkspace,
        stdio: "ignore",
      });

      const { ContributionRunManager } =
        await import("../src/run/run-manager.js");
      const agentRunManager = new ContributionRunManager({
        baseDir: agentRuns,
      });
      const manifest = agentRunManager.createRun({
        repoFullName: "test-org/math-repo",
        issueNumber: 42,
      });
      const issueProvider = {
        getIssue: async () => ({
          status: "OK" as const,
          data: {
            number: 42,
            title: "mul always returns 0",
            state: "open" as const,
            htmlUrl: "https://github.com/test-org/math-repo/issues/42",
            body: "Provider issue body.",
            labels: [],
          },
        }),
      };
      let failFirstHostLookup = true;
      let hostIssueLookupCount = 0;
      const hostIssueProvider = {
        getIssue: async () => {
          hostIssueLookupCount += 1;
          if (failFirstHostLookup) {
            failFirstHostLookup = false;
            return { status: "RATE_LIMITED" as const, data: null as never };
          }
          return {
            status: "OK" as const,
            data: {
              number: 42,
              title: "mul always returns 0",
              state: "open" as const,
              htmlUrl: "https://github.com/test-org/math-repo/issues/42",
              body: "Provider issue body.",
              labels: [],
            },
          };
        },
      };
      const communityGate = {
        sourceCommitSha: baseCommitSha,
        policy: {
          hasGatingRules: false,
          requiresIssueApprovalBeforePr: false,
          autoClosesNewIssues: false,
          hasLgtmApprovalProtocol: false,
          restrictedTriageHours: false,
          privateVulnerabilityDisclosure: false,
          reasons: [],
          suggestedContributorAction: "Follow the repository contribution policy.",
          matchedKeywords: [],
        },
      };
      saveCanonicalArtifact(
        agentRunManager,
        manifest.runId,
        "workspace",
        {
          workspacePath: agentWorkspace,
          branchName: "opencontrib/run-42",
          baseCommitSha,
          baseRepoPath: agentWorkspace,
          baseBranch: "main",
          repoFullName: "test-org/math-repo",
          communityGate,
          communityGateSha256: hashCommunityGateSnapshot(communityGate),
          createdAt: new Date().toISOString(),
        },
        "WORKSPACE_PREPARED",
      );
      await new IssueBindingService(agentRunManager, issueProvider).bind({
        runId: manifest.runId,
        repoFullName: "test-org/math-repo",
        issueNumber: 42,
      });

      // 2. Agent authoring a brand new regression test
      const reproTestFile = {
        path: "math.test.js",
        operation: "CREATE" as const,
        content:
          "import { expect, test } from 'bun:test'; import { mul } from './math.js'; test('multiplication regression', () => expect(mul(3, 4), 'ASSERTION_MUL_FAIL').toBe(12));\n",
        explanation: "regression test for multiplication",
      };
      writeFileSync(
        join(agentWorkspace, reproTestFile.path),
        reproTestFile.content,
      );

      const testCmd = "bun test math.test.js";
      const agentEvidence = new EvidenceService(agentRunManager);
      const red = agentEvidence.captureRed({
        runId: manifest.runId,
        testCommand: testCmd,
        expectedAssertion: "ASSERTION_MUL_FAIL",
        testFile: "math.test.js",
      });
      expect(red.assertionMatched).toBe(true);

      // Fix implementation
      const fixFile = {
        path: "math.js",
        operation: "MODIFY" as const,
        content: "export function mul(a, b) { return a * b; }\n",
        explanation: "implement correct multiplication",
      };
      writeFileSync(join(agentWorkspace, fixFile.path), fixFile.content);

      const fullPatch = {
        title: "fix: multiplication logic",
        summary: "Fix mul function logic",
        rationale: "Return product instead of 0",
        targetFiles: [
          { path: reproTestFile.path, reason: "Regression test" },
          { path: fixFile.path, reason: "Fix" },
        ],
        files: [reproTestFile, fixFile],
        implementationSteps: ["Add math.test.js", "Fix math.js"],
        regressionTestPlan: [testCmd],
        estimatedDiffLines: 6,
      };

      agentRunManager.saveArtifact(
        manifest.runId,
        "patch",
        JSON.stringify(fullPatch),
      );
      const agentGreen = await agentEvidence.verifyGreen({
        runId: manifest.runId,
        cwd: agentWorkspace,
        testCommand: testCmd,
        stressLoopCount: 1,
        concurrencyWorkers: 1,
      });
      expect(agentGreen.reproductionVerified).toBe(true);
      expect(agentGreen.passedUnitTestsCount).toBe(1);
      agentRunManager.saveArtifact(
        manifest.runId,
        "pr_draft",
        "PR description body",
      );

      // 3. Build RunTransferBundle from Agent Run
      // Reset workspace math.js back to return 0 before transfer materialization
      writeFileSync(
        join(agentWorkspace, fixFile.path),
        "export function mul(a, b) { return 0; }\n",
      );

      const transferBundle = buildRunTransferBundle(
        agentRunManager,
        manifest.runId,
      );
      expect(transferBundle.reproductionPatch).toBeDefined();
      expect(transferBundle.reproductionPatch?.map((f) => f.path)).toContain(
        "math.test.js",
      );

      // 4. Trusted Host receives transfer proposal and reproduces in independent store & workspace
      const hostRunManager = new (
        await import("../src/run/run-manager.js")
      ).ContributionRunManager({
        baseDir: hostRuns,
      });
      const { WorktreeManager } =
        await import("../src/workspace/worktree-manager.js");
      class TestWorktreeManager extends WorktreeManager {
        override createIsolatedWorkspace(_options: any) {
          return {
            workspacePath: hostWorkspace,
            branchName: `opencontrib/run-${manifest.runId}`,
            isWorktree: false,
            baseRepoPath: hostWorkspace,
            baseBranch: "main",
            baseCommitSha,
          };
        }
      }
      class RecordingExecutionPort extends DevelopmentUnsafeExecutionPort {
        readonly preflightLintJobs: PreflightLintExecutionJob[] = [];

        override runPreflightLint(
          job: PreflightLintExecutionJob,
        ): Promise<RawPreflightLintExecutionResult> {
          this.preflightLintJobs.push(job);
          return Promise.resolve({
            command: job.command,
            exitCode: 0,
            output: "isolated lint passed",
            passed: true,
          });
        }
      }
      const executionPort = new RecordingExecutionPort();
      const materializer = new TrustedRunMaterializer(
        hostRunManager,
        new TestWorktreeManager(),
        executionPort,
        undefined,
        hostIssueProvider,
      );
      await expect(materializer.materialize(transferBundle)).rejects.toThrow(
        /RATE_LIMITED/,
      );
      const retryableRun = hostRunManager.getRun(manifest.runId);
      expect(retryableRun?.manifest.currentPhase).toBe("GOVERNANCE_AUDITED");
      expect(retryableRun?.artifacts.issueBinding).toBeUndefined();
      expect(retryableRun?.artifacts.submissionIntent).toBeUndefined();

      const hostRun = await materializer.materialize(transferBundle);
      expect(hostIssueLookupCount).toBe(2);
      expect(hostRun.artifacts.issueBinding).toBeDefined();
      expect(hostRun.artifacts.submissionIntent).toBeDefined();
      expect(hostRun.manifest.currentPhase).toBe("GOVERNANCE_AUDITED");
      expect(hostRun.artifacts.evidenceRed?.baselineCheckStatus).toBe("PASS");
      expect(hostRun.artifacts.evidence?.baselineTestedAt).toBe(hostRun.artifacts.evidenceRed?.baselineTestedAt);
      const hostValidatedPatch = hostRun.artifacts.validatedPatch as any;
      expect(hostValidatedPatch).toBeDefined();
      expect(hostValidatedPatch.files.map((f: any) => f.path)).toContain(
        "math.test.js",
      );
      expect(hostValidatedPatch.files.map((f: any) => f.path)).toContain(
        "math.js",
      );
      expect(hostValidatedPatch.changedLines).toBeGreaterThan(0);
      expect(executionPort.preflightLintJobs).toHaveLength(1);
      expect(executionPort.preflightLintJobs[0]?.command).toContain("lint");
      expect(executionPort.preflightLintJobs[0]?.workspace.workspacePath).toBe(
        hostWorkspace,
      );
    } finally {
      rmSync(agentWorkspace, { recursive: true, force: true });
      rmSync(hostWorkspace, { recursive: true, force: true });
      rmSync(agentRuns, { recursive: true, force: true });
      rmSync(hostRuns, { recursive: true, force: true });
    }
  }, 30_000);
});
