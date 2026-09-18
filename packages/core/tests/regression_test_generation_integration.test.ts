import { describe, expect, it } from "bun:test";
import { buildContributionRunManager, EvidenceService } from "../src/index.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";

describe("Autonomous Regression-Test Generation & ValidatedPatch Integration", () => {
  it("includes reproduction test files in the final ValidatedPatchArtifact", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "oc-repro-test-"));
    const baseDir = mkdtempSync(join(tmpdir(), "oc-repro-runs-"));
    try {
      // 1. Initialize git repo as baseline
      execFileSync("git", ["init", "-b", "main"], {
        cwd: tempDir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "Tester"], {
        cwd: tempDir,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: tempDir,
        stdio: "ignore",
      });
      writeFileSync(
        join(tempDir, "calc.js"),
        "export function add(a, b) { return 0; }\n",
      );
      execFileSync("git", ["add", "."], { cwd: tempDir, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "initial baseline"], {
        cwd: tempDir,
        stdio: "ignore",
      });
      const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: tempDir,
        encoding: "utf8",
      }).trim();

      const runManager = buildContributionRunManager();
      const manifest = runManager.createRun({
        repoFullName: "test-org/calc-repo",
        issueNumber: 1,
      });
      saveCanonicalArtifact(
        runManager,
        manifest.runId,
        "workspace",
        {
          workspacePath: tempDir,
          branchName: "fixture-branch",
          baseCommitSha,
          baseRepoPath: tempDir,
          baseBranch: "main",
          repoFullName: "test-org/calc-repo",
          createdAt: new Date().toISOString(),
        },
        "WORKSPACE_PREPARED",
      );

      // 2. Simulated ReproductionDesign with a brand new regression test file
      const reproductionTestFile = {
        path: "calc.test.js",
        operation: "CREATE" as const,
        content:
          "import { add } from './calc.js'; if (add(2, 3) !== 5) { console.error('ASSERTION_FAIL'); process.exit(1); }\n",
      };
      writeFileSync(
        join(tempDir, reproductionTestFile.path),
        reproductionTestFile.content,
      );

      // Capture RED with this newly applied test
      const testCmd = "bun calc.test.js";
      const evidenceService = new EvidenceService(runManager);
      const red = evidenceService.captureRed({
        runId: manifest.runId,
        testCommand: testCmd,
        expectedAssertion: "ASSERTION_FAIL",
        testFile: "calc.test.js",
      });
      expect(red.assertionMatched).toBe(true);
      expect(red.exitCode).toBe(1);

      // 3. Simulated fix implementation
      const fixFile = {
        path: "calc.js",
        operation: "MODIFY" as const,
        content: "export function add(a, b) { return a + b; }\n",
      };
      writeFileSync(join(tempDir, fixFile.path), fixFile.content);

      // 4. Draft patch containing BOTH regression test + implementation fix
      const fullPatch = {
        title: "fix: correct add function",
        summary: "Fix math addition logic",
        rationale: "Fix return 0 bug",
        targetFiles: [
          { path: reproductionTestFile.path, reason: "Regression test" },
          { path: fixFile.path, reason: "Fix logic" },
        ],
        files: [reproductionTestFile, fixFile],
        implementationSteps: ["Add regression test", "Fix addition logic"],
        regressionTestPlan: [testCmd],
        estimatedDiffLines: 5,
      };

      runManager.saveArtifact(
        manifest.runId,
        "patch",
        JSON.stringify(fullPatch),
        "PATCH_DRAFTED",
      );

      // 5. Verify GREEN: exact delta MUST match both test and implementation!
      const report = await evidenceService.verifyGreen({
        runId: manifest.runId,
        testCommand: testCmd,
      });

      expect(report.allTestsPassing).toBe(true);
      expect(report.reproductionVerified).toBe(true);

      const run = runManager.getRun(manifest.runId);
      const validatedPatch = run?.artifacts.validatedPatch as any;
      expect(validatedPatch).toBeDefined();
      expect(validatedPatch.files.map((f: any) => f.path)).toContain(
        "calc.test.js",
      );
      expect(validatedPatch.files.map((f: any) => f.path)).toContain("calc.js");
      expect(validatedPatch.changedLines).toBeGreaterThan(0);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(baseDir, { recursive: true, force: true });
    }
  });
});
