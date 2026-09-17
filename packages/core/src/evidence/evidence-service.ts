import { existsSync, readFileSync } from "fs";
import { resolve } from "path";
import { createHash } from "crypto";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import type { EvidenceReport, RedEvidence } from "../contracts/schemas.js";
import {
  captureRedEvidence,
  verifyGreenEvidence,
  collectEvidence,
} from "./evidence-collector.js";
import { isSafeRepositoryPath } from "../submission/submission-intent-service.js";

export interface CaptureRedInput {
  runId: string;
  cwd?: string;
  testCommand: string;
  expectedAssertion?: string;
  testFile?: string;
  testFileSha256?: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
}

export interface VerifyGreenInput {
  runId: string;
  cwd?: string;
  testCommand: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
}

export class EvidenceService {
  constructor(private readonly runManager: ContributionRunManager) {}

  /**
   * Capture authoritative RED baseline.
   * Only EvidenceService can write `evidence_red`.
   */
  captureRed(input: CaptureRedInput): RedEvidence {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }
    const ws = run.artifacts.workspace;
    if (!ws?.workspacePath) {
      throw new Error(
        `EvidenceWorkspaceRequiredError: run ${input.runId} has no canonical workspace artifact. Prepare workspace first.`,
      );
    }
    // Lock workspaceRoot and targetCwd strictly from the canonical WorkspaceArtifact
    const targetCwd = String(ws.workspacePath);
    const resolvedWorkspaceRoot = String(ws.workspacePath);
    const baselineCommitSha = typeof ws.baseCommitSha === "string" ? ws.baseCommitSha : input.baselineCommitSha;

    const red = captureRedEvidence({
      cwd: targetCwd,
      testCommand: input.testCommand,
      workspaceRoot: resolvedWorkspaceRoot,
      expectedAssertion: input.expectedAssertion,
      testFileSha256: input.testFileSha256,
      baselineCommitSha,
      testFile: input.testFile,
    });

    // Only seal authoritative evidence_red when RED actually reproduced a valid failure (exitCode !== 0)
    // If test passed unexpectedly or assertion failed, do not seal immutable evidence_red.
    if (red.exitCode === 0) {
      throw new Error(
        `RedReproductionFailedError: test command exited with code 0 (expected failure). Evidence_red not saved so run is not permanently bricked. Output snippet: ${red.observedOutputSnippet.slice(0, 200)}`,
      );
    }
    if (input.expectedAssertion && !red.assertionMatched) {
      throw new Error(
        `RedAssertionMismatchError: expected assertion "${input.expectedAssertion}" was not observed in test output. Evidence_red not saved. Output snippet: ${red.observedOutputSnippet.slice(0, 200)}`,
      );
    }

    // Save authoritative evidence_red artifact only after passing verification
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "evidence_red",
      red as any,
    );

    // Also update partial evidence report for convenience (does not advance phase)
    saveCanonicalArtifact(this.runManager, input.runId, "evidence", {
      baselineTestedAt: red.capturedAt,
      baselineFlakyTests: [],
      stressLoopRuns: 0,
      stressLoopPassed: false,
      handleLeakCheckPassed: true,
      passedUnitTestsCount: 0,
      redEvidence: red,
      reproductionVerified: false,
      allTestsPassing: false,
    });

    return red;
  }

  /**
   * Verify GREEN and bind it to the captured RED baseline.
   * Reads RED strictly from the trusted `evidence_red` artifact or `evidence.redEvidence`.
   * Also verifies that the stored patch artifact was actually applied to the workspace.
   * On verified reproduction, advances run phase to EVIDENCE_COLLECTED.
   */
  async verifyGreen(input: VerifyGreenInput): Promise<EvidenceReport> {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }

    // Load trusted RED evidence from evidence_red or evidence artifact
    const redEvidence = (run.artifacts?.evidenceRed ||
      run.artifacts?.evidence?.redEvidence) as RedEvidence | undefined;

    if (!redEvidence || !redEvidence.sourceTreeSha256) {
      throw new Error(
        `No authoritative RED baseline found for run ${input.runId}. Call EvidenceService.captureRed() first.`,
      );
    }

    const ws = run.artifacts.workspace;
    if (!ws?.workspacePath) {
      throw new Error(
        `EvidenceWorkspaceRequiredError: run ${input.runId} has no canonical workspace artifact. Prepare workspace first.`,
      );
    }
    // Lock workspaceRoot and targetCwd strictly from canonical WorkspaceArtifact
    const targetCwd = String(ws.workspacePath);
    const resolvedWorkspaceRoot = String(ws.workspacePath);
    const baselineCommitSha = typeof ws.baseCommitSha === "string" ? ws.baseCommitSha : input.baselineCommitSha;

    // Verify patch artifact provenance: mandatory and write-once
    const patchRaw = run.artifacts.patch;
    if (!patchRaw) {
      throw new Error(
        `PatchRequiredForGreenVerificationError: run ${input.runId} has no patch artifact. Draft patch before verifying GREEN.`,
      );
    }
    const patchContent = typeof patchRaw === "string" ? patchRaw : JSON.stringify(patchRaw);
    const appliedPatchSha256 = createHash("sha256").update(patchContent).digest("hex");

    let parsedPatch: any;
    try {
      parsedPatch = typeof patchRaw === "string" ? JSON.parse(patchRaw) : patchRaw;
    } catch {
      parsedPatch = null;
    }

    if (!parsedPatch || !Array.isArray(parsedPatch.files) || parsedPatch.files.length === 0) {
      throw new Error(
        `EvidencePatchProvenanceError: patch artifact for run ${input.runId} contains no concrete files.`,
      );
    }

    const patchFilePaths = new Set<string>();
    for (const file of parsedPatch.files) {
      const filePath = String(file.path || "");
      if (!isSafeRepositoryPath(filePath)) {
        throw new Error(`EvidencePatchProvenanceError: unsafe patch path '${filePath}' in patch artifact.`);
      }
      patchFilePaths.add(filePath);
      const fullPath = resolve(targetCwd, filePath);
      const op = String(file.operation || "MODIFY").toUpperCase();

      if (op === "DELETE") {
        if (existsSync(fullPath)) {
          throw new Error(
            `EvidencePatchProvenanceError: patch specifies DELETE for '${filePath}', but file still exists on disk in workspace.`,
          );
        }
      } else {
        // CREATE or MODIFY
        if (!existsSync(fullPath)) {
          throw new Error(
            `EvidencePatchProvenanceError: patch specifies file '${filePath}', but file does not exist on disk in workspace.`,
          );
        }
        const onDiskContent = readFileSync(fullPath, "utf-8");
        const expectedContent = String(file.content ?? "");
        if (onDiskContent !== expectedContent) {
          throw new Error(
            `EvidencePatchProvenanceError: on-disk content for '${filePath}' does not match the patch artifact content.`,
          );
        }
      }
    }

    // Exact delta check: git status --porcelain in targetCwd
    // If targetCwd is a git worktree/repo, any untracked or modified files on disk must belong to patch.files
    try {
      const { execSync } = await import("child_process");
      const gitStatusOut = execSync("git status --porcelain --untracked-files=all", {
        cwd: targetCwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const lines = gitStatusOut.split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) {
        // line is like " M src/index.ts" or "?? new.ts" or "D  del.ts"
        const rel = line.slice(3).trim();
        // Ignore test execution artifacts or temp logs if any, but any repo file change must be in patch
        if (rel && !rel.startsWith(".git") && !rel.startsWith(".opencontrib")) {
          const normRel = rel.replace(/\\/g, "/");
          if (!patchFilePaths.has(normRel)) {
            throw new Error(
              `EvidencePatchProvenanceError: workspace contains uncommitted/untracked file '${normRel}' that is NOT declared in the patch artifact. Actual delta must equal patch.`,
            );
          }
        }
      }
    } catch (err: any) {
      if (err.message?.includes("EvidencePatchProvenanceError")) {
        throw err;
      }
      // If git status fails (e.g. non-git testing dir in some synthetic unit tests), proceed with file-level checks
    }

    const green = verifyGreenEvidence({
      cwd: targetCwd,
      testCommand: input.testCommand,
      workspaceRoot: resolvedWorkspaceRoot,
      redEvidence,
      stressLoopCount: input.stressLoopCount ?? 1,
      concurrencyWorkers: input.concurrencyWorkers ?? 1,
    });

    const full = await collectEvidence({
      cwd: targetCwd,
      workspaceRoot: resolvedWorkspaceRoot,
      baselineCommitSha,
      testCommand: input.testCommand,
      stressLoopCount: input.stressLoopCount ?? 1,
      concurrencyWorkers: input.concurrencyWorkers ?? 1,
    });

    const greenEvidenceWithPatch = {
      ...green.greenEvidence,
      appliedPatchSha256,
    };

    const report: EvidenceReport = {
      ...full,
      redEvidence,
      greenEvidence: greenEvidenceWithPatch,
      reproductionVerified:
        green.reproductionVerified && Boolean(full.allTestsPassing),
      allTestsPassing: Boolean(full.allTestsPassing),
    };

    if (report.reproductionVerified === true) {
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        report as any,
        "EVIDENCE_COLLECTED",
      );
    } else {
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        report as any,
      );
    }

    return report;
  }
}
