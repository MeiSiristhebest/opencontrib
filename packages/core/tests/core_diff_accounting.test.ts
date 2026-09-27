import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import {
  ValidatedPatchArtifactSchema,
  type ValidatedPatchArtifact,
} from "../src/contracts/schemas.js";
import { computeSourceTreeHash } from "../src/evidence/evidence-collector.js";
import { hashValidatedPatchArtifact } from "../src/evidence/validated-patch.js";
import { QualityRubricStep } from "../src/orchestration/pipeline/steps.js";
import type {
  PipelineContext,
  PipelineDeps,
} from "../src/orchestration/pipeline/types.js";

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Canonical core diff accounting", () => {
  it("measures only core lines from the patch-bound validated artifact", async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), "oc-core-diff-pipeline-"));
    try {
      const baseSource = "const baseline = true;\n";
      const updatedSource = `${baseSource}export const fix = true;\n`;
      const documentation =
        Array.from({ length: 150 }, (_, index) => `Documentation ${index}`).join(
          "\n",
        ) + "\n";
      const testSource =
        Array.from({ length: 150 }, (_, index) => `test case ${index}`).join(
          "\n",
        ) + "\n";

      writeFileSync(join(workspacePath, "src.ts"), baseSource);
      execFileSync("git", ["init"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.email", "test@example.com"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["config", "user.name", "OpenContrib Test"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      execFileSync("git", ["commit", "-m", "baseline"], {
        cwd: workspacePath,
        stdio: "ignore",
      });
      const baseCommitSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: workspacePath,
        encoding: "utf8",
      }).trim();

      mkdirSync(join(workspacePath, "tests"), { recursive: true });
      writeFileSync(join(workspacePath, "src.ts"), updatedSource);
      writeFileSync(join(workspacePath, "README.md"), documentation);
      writeFileSync(join(workspacePath, "tests", "core.test.ts"), testSource);

      const runId = "run-core-diff-test";
      const patch = {
        title: "test(core): account for supporting changes",
        summary: "Exercise canonical core diff measurement.",
        rationale: "Verify supporting files do not inflate core complexity.",
        targetFiles: [],
        implementationSteps: [],
        regressionTestPlan: [],
        estimatedDiffLines: 301,
        files: [
          { path: "src.ts", operation: "MODIFY", content: updatedSource },
          { path: "README.md", operation: "CREATE", content: documentation },
          {
            path: "tests/core.test.ts",
            operation: "CREATE",
            content: testSource,
          },
        ],
      };
      const patchSha256 = sha256(JSON.stringify(patch));
      const validatedPatchPayload: Omit<
        ValidatedPatchArtifact,
        "artifactSha256"
      > = {
        runId,
        patchSha256,
        actualDeltaSha256: "a".repeat(64),
        baseCommitSha,
        redTreeSha256: "b".repeat(64),
        greenTreeSha256: computeSourceTreeHash(workspacePath),
        changedLines: 301,
        files: [
          {
            path: "src.ts",
            mode: "100644",
            operation: "MODIFY",
            contentSha256: sha256(updatedSource),
          },
          {
            path: "README.md",
            mode: "100644",
            operation: "CREATE",
            contentSha256: sha256(documentation),
          },
          {
            path: "tests/core.test.ts",
            mode: "100644",
            operation: "CREATE",
            contentSha256: sha256(testSource),
          },
        ],
        validatedAt: "2026-09-27T00:00:00.000Z",
      };
      const validatedPatch = ValidatedPatchArtifactSchema.parse({
        ...validatedPatchPayload,
        artifactSha256: hashValidatedPatchArtifact(validatedPatchPayload),
      });
      const run = {
        artifacts: {
          patch,
          validatedPatch,
          workspace: { workspacePath, baseCommitSha },
        },
      };
      const deps = {
        runManager: { getRun: () => run },
        stateMachine: { setConfidenceScore: () => undefined },
      } as unknown as PipelineDeps;
      const ctx = {
        runId,
        activePatch: patch,
        validationStatus: "VALIDATED",
        evidenceReport: { passedUnitTestsCount: 1 },
        subagentReview: { status: "UNAVAILABLE" },
      } as unknown as PipelineContext;

      await new QualityRubricStep().execute(ctx, deps);

      expect(ctx.coreDiffLines).toBe(1);
      expect(ctx.coreFilesCount).toBe(1);

      const tamperedRun = {
        artifacts: {
          ...run.artifacts,
          validatedPatch: {
            ...validatedPatch,
            artifactSha256: "0".repeat(64),
          },
        },
      };
      const fallbackDeps = {
        ...deps,
        runManager: { getRun: () => tamperedRun },
      };
      const fallbackCtx = {
        runId,
        activePatch: patch,
        validationStatus: "VALIDATED",
        evidenceReport: { passedUnitTestsCount: 1 },
        subagentReview: { status: "UNAVAILABLE" },
      } as unknown as PipelineContext;
      await new QualityRubricStep().execute(
        fallbackCtx,
        fallbackDeps as unknown as PipelineDeps,
      );

      expect(fallbackCtx.coreDiffLines).toBeUndefined();
      expect(fallbackCtx.coreFilesCount).toBe(1);

      writeFileSync(
        join(workspacePath, "src.ts"),
        `${updatedSource}export const changedAfterGreen = true;\n`,
      );
      const staleTreeCtx = {
        runId,
        activePatch: patch,
        validationStatus: "VALIDATED",
        evidenceReport: { passedUnitTestsCount: 1 },
        subagentReview: { status: "UNAVAILABLE" },
      } as unknown as PipelineContext;
      await new QualityRubricStep().execute(staleTreeCtx, deps);

      expect(staleTreeCtx.coreDiffLines).toBeUndefined();
      expect(staleTreeCtx.coreFilesCount).toBe(1);
    } finally {
      rmSync(workspacePath, { recursive: true, force: true });
    }
  });
});
