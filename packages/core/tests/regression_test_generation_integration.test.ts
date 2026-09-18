import { describe, expect, it } from "bun:test";
import { EvidenceService } from "../src/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import { buildRunTransferBundle } from "../src/run/run-transfer.js";
import { TrustedRunMaterializer } from "../src/run/trusted-run-host.js";

describe("Autonomous Regression-Test Generation & Transfer Host Integration", () => {
  it("transfers reproduction files and reproduces RED->GREEN on trusted host", async () => {
    const agentWorkspace = mkdtempSync(join(tmpdir(), "oc-agent-ws-"));
    const agentRuns = mkdtempSync(join(tmpdir(), "oc-agent-runs-"));
    const hostRuns = mkdtempSync(join(tmpdir(), "oc-host-runs-"));

    try {
      // 1. Initialize clean upstream git repo
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

      const { ContributionRunManager } =
        await import("../src/run/run-manager.js");
      const agentRunManager = new ContributionRunManager({
        baseDir: agentRuns,
      });
      const manifest = agentRunManager.createRun({
        repoFullName: "test-org/math-repo",
        issueNumber: 42,
      });
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
          createdAt: new Date().toISOString(),
        },
        "WORKSPACE_PREPARED",
      );

      // 2. Agent authoring a brand new regression test
      const reproTestFile = {
        path: "math.test.js",
        operation: "CREATE" as const,
        content:
          "import { mul } from './math.js'; if (mul(3, 4) !== 12) { console.error('ASSERTION_MUL_FAIL'); process.exit(1); }\n",
        explanation: "regression test for multiplication",
      };
      writeFileSync(
        join(agentWorkspace, reproTestFile.path),
        reproTestFile.content,
      );

      const testCmd = "bun math.test.js";
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
        "PATCH_DRAFTED",
      );
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

      // 4. Trusted Host receives transfer proposal and reproduces in independent store
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
            workspacePath: agentWorkspace,
            branchName: `opencontrib/run-${manifest.runId}`,
            isWorktree: false,
            baseRepoPath: agentWorkspace,
            baseBranch: "main",
            baseCommitSha,
          };
        }
      }
      const materializer = new TrustedRunMaterializer(
        hostRunManager,
        new TestWorktreeManager(),
      );
      const hostRun = await materializer.materialize(transferBundle);

      expect(hostRun.manifest.currentPhase).toBe("GOVERNANCE_AUDITED");
      const hostValidatedPatch = hostRun.artifacts.validatedPatch as any;
      expect(hostValidatedPatch).toBeDefined();
      expect(hostValidatedPatch.files.map((f: any) => f.path)).toContain(
        "math.test.js",
      );
      expect(hostValidatedPatch.files.map((f: any) => f.path)).toContain(
        "math.js",
      );
      expect(hostValidatedPatch.changedLines).toBeGreaterThan(0);
    } finally {
      rmSync(agentWorkspace, { recursive: true, force: true });
      rmSync(agentRuns, { recursive: true, force: true });
      rmSync(hostRuns, { recursive: true, force: true });
    }
  });
});
