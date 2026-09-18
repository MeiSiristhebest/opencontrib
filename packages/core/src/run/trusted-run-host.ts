import { PatchDraftSchema, type PatchDraft } from "../contracts/llm-schemas.js";
import { GovernanceService } from "../governance/governance-service.js";
import { SubmissionIntentService } from "../submission/submission-intent-service.js";
import { EvidenceService } from "../evidence/evidence-service.js";
import { WorktreeManager } from "../workspace/worktree-manager.js";
import type { ContributionRunManager } from "./run-manager.js";
import { hydrateCanonicalRun } from "./canonical-writer.js";
import type { TrustedExecutionPort } from "./trusted-execution.port.js";
import {
  RunTransferBundleSchema,
  transferManifestToRunManifest,
  type RunTransferBundle,
} from "./run-transfer.js";

export class TrustedRunMaterializationError extends Error {
  constructor(message: string) {
    super(`TrustedRunMaterializationError: ${message}`);
    this.name = "TrustedRunMaterializationError";
  }
}

/**
 * In-process fallback execution adapter implementing TrustedExecutionPort.
 * For development/test use only. Production deployments must inject a containerized
 * or out-of-process worker (e.g. DockerExecutionWorker).
 */
export class DevelopmentUnsafeExecutionPort implements TrustedExecutionPort {
  async captureRed(
    job: import("./trusted-execution.port.js").RedExecutionJob,
  ): Promise<import("./trusted-execution.port.js").RawRedExecutionResult> {
    const { captureRedEvidence } =
      await import("../evidence/evidence-collector.js");
    const red = captureRedEvidence({
      cwd: job.workspace.workspacePath,
      testCommand: job.testCommand,
      expectedAssertion: job.expectedAssertion,
      testFile: job.testFiles,
    });
    return {
      command: red.command,
      exitCode: red.exitCode,
      stdout: red.observedOutputSnippet,
      stderr: "",
      outputSnippet: red.observedOutputSnippet,
      assertionMatched: red.assertionMatched,
      capturedAt: red.capturedAt,
      sourceTreeSha256: red.sourceTreeSha256,
      testIdentity: red.testIdentity,
    };
  }

  async verifyGreen(
    job: import("./trusted-execution.port.js").GreenExecutionJob,
  ): Promise<import("./trusted-execution.port.js").RawGreenExecutionResult> {
    const { verifyGreenEvidence, getProcessHandleCount } =
      await import("../evidence/evidence-collector.js");
    const initialHandles = getProcessHandleCount();
    const green = await verifyGreenEvidence({
      cwd: job.workspace.workspacePath,
      testCommand: job.testCommand,
      redEvidence: job.redEvidence,
      stressLoopCount: job.stressLoopCount ?? 1,
      concurrencyWorkers: job.concurrencyWorkers ?? 1,
    });
    const finalHandles = getProcessHandleCount();
    let handleLeakCheckPassed: "PASS" | "FAIL" | "UNAVAILABLE" = "UNAVAILABLE";
    if (initialHandles !== null && finalHandles !== null) {
      handleLeakCheckPassed =
        finalHandles - initialHandles < 15 ? "PASS" : "FAIL";
    }

    return {
      command: green.greenEvidence.command,
      exitCode: green.greenEvidence.exitCode,
      outputSnippet: green.greenEvidence.outputSnippet,
      passed: green.greenEvidence.passed,
      sourceTreeSha256: green.greenEvidence.sourceTreeSha256,
      capturedAt: green.greenEvidence.capturedAt,
      executionCount: green.stressResult.executionCount,
      maxConcurrentObserved: green.stressResult.maxConcurrentObserved,
      concurrencyWorkers: green.stressResult.concurrencyWorkers,
      concurrencyStampedePassed: green.stressResult.concurrencyStampedePassed,
      raceCollisionsDetected: green.stressResult.raceCollisionsDetected,
      latencyJitterMs: green.stressResult.latencyJitterMs,
      testIdentity: green.greenEvidence.testIdentity,
      passedUnitTestsCount: green.greenEvidence.passed ? 1 : 0,
      failedUnitTestsCount: green.greenEvidence.passed ? 0 : 1,
      handleLeakCheckPassed,
      initialDescriptorCount: initialHandles ?? undefined,
      finalDescriptorCount: finalHandles ?? undefined,
    };
  }
}

export interface EvidenceExecutionPolicy {
  stressLoopCount: number;
  concurrencyWorkers: number;
}

/**
 * Materializes an agent proposal into a host-owned run.
 *
 * The incoming bundle deliberately contains only a patch, PR draft, and RED
 * recipe. The host discards all agent evidence/governance/approval claims,
 * allocates its own workspace, reruns RED/GREEN, and appends fresh canonical
 * artifacts to its protected RunManager.
 */
export class TrustedRunMaterializer {
  private readonly executionPort: TrustedExecutionPort;
  private readonly executionPolicy: EvidenceExecutionPolicy;

  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly worktreeManager: WorktreeManager = new WorktreeManager(),
    executionPort?: TrustedExecutionPort,
    executionPolicy?: Partial<EvidenceExecutionPolicy>,
  ) {
    this.executionPort = executionPort ?? new DevelopmentUnsafeExecutionPort();
    this.executionPolicy = {
      stressLoopCount: executionPolicy?.stressLoopCount ?? 3,
      concurrencyWorkers: executionPolicy?.concurrencyWorkers ?? 2,
    };
  }

  async materialize(input: RunTransferBundle) {
    const bundle = RunTransferBundleSchema.parse(input);
    const existing = this.runManager.getRun(bundle.manifest.runId);
    if (existing) {
      if (
        existing.manifest.repoFullName.toLowerCase() !==
          bundle.manifest.repoFullName.toLowerCase() ||
        existing.manifest.issueNumber !== bundle.manifest.issueNumber
      ) {
        throw new TrustedRunMaterializationError(
          `run ${bundle.manifest.runId} is already bound to another repository or issue.`,
        );
      }
      if (
        existing.manifest.currentPhase === "GOVERNANCE_AUDITED" ||
        existing.manifest.currentPhase === "PR_SUBMITTED" ||
        existing.manifest.currentPhase === "COMPLETED"
      ) {
        return existing;
      }
      throw new TrustedRunMaterializationError(
        `run ${bundle.manifest.runId} has an incomplete host materialization at phase ${existing.manifest.currentPhase}; refusing replay.`,
      );
    }

    hydrateCanonicalRun(
      this.runManager,
      transferManifestToRunManifest(bundle.manifest),
    );

    const workspace = new (
      await import("../workspace/workspace-service.js")
    ).WorkspaceService(this.runManager, this.worktreeManager).prepare({
      runId: bundle.manifest.runId,
      issueOrTaskId: bundle.manifest.issueNumber ?? "transfer",
      repoFullName: bundle.manifest.repoFullName,
    });

    const patch = this.parsePatch(bundle.patch);
    // Patch and PR draft are proposals. They are stored only so host-side
    // Evidence/Governance services can verify and bind them.
    this.runManager.saveArtifact(
      bundle.manifest.runId,
      "patch",
      JSON.stringify(patch),
    );

    // If a reproduction patch is supplied, apply it to the clean workspace BEFORE capturing RED
    if (bundle.reproductionPatch && bundle.reproductionPatch.length > 0) {
      const reproApply = this.worktreeManager.applySurgicalFilesSafely(
        workspace.context.workspacePath,
        bundle.reproductionPatch.map((file) => ({
          path: file.path,
          operation: file.operation,
          content: file.content,
          mode: file.mode,
        })),
      );
      if (reproApply.errors.length > 0) {
        throw new TrustedRunMaterializationError(
          `host rejected reproduction patch application: ${reproApply.errors.join("; ")}`,
        );
      }
    }

    const rawRed = await this.executionPort.captureRed({
      runId: bundle.manifest.runId,
      workspace: {
        repoFullName: bundle.manifest.repoFullName,
        baseCommitSha: workspace.artifact.baseCommitSha,
        workspacePath: workspace.context.workspacePath,
      },
      testCommand: bundle.redRecipe.command,
      expectedAssertion: bundle.redRecipe.expectedAssertion,
      testFiles: bundle.redRecipe.testFiles,
    });
    const evidenceService = new EvidenceService(this.runManager);
    const red = evidenceService.recordRedExecution(
      bundle.manifest.runId,
      rawRed,
      bundle.redRecipe.expectedAssertion,
    );

    this.runManager.saveArtifact(
      bundle.manifest.runId,
      "patch",
      JSON.stringify(patch),
      "PATCH_DRAFTED",
    );

    const applied = this.worktreeManager.applySurgicalFilesSafely(
      workspace.context.workspacePath,
      patch.files.map((file) => ({
        path: file.path,
        operation: file.operation,
        content: file.content,
        mode: file.mode,
      })),
    );
    if (applied.errors.length > 0) {
      throw new TrustedRunMaterializationError(
        `host rejected patch application: ${applied.errors.join("; ")}`,
      );
    }

    const rawGreen = await this.executionPort.verifyGreen({
      runId: bundle.manifest.runId,
      workspace: {
        repoFullName: bundle.manifest.repoFullName,
        baseCommitSha: workspace.artifact.baseCommitSha,
        workspacePath: workspace.context.workspacePath,
      },
      testCommand: bundle.redRecipe.command,
      redEvidence: red,
      stressLoopCount: this.executionPolicy.stressLoopCount,
      concurrencyWorkers: this.executionPolicy.concurrencyWorkers,
    });
    await evidenceService.recordGreenExecution(bundle.manifest.runId, rawGreen);

    this.runManager.saveArtifact(
      bundle.manifest.runId,
      "pr_draft",
      bundle.prDraft,
    );
    const title =
      patch.title || bundle.manifest.issueTitle || "chore: contribution";
    new GovernanceService(this.runManager).audit(bundle.manifest.runId, {
      prTitle: title,
      prBody: bundle.prDraft,
    });

    const [owner, repo] = bundle.manifest.repoFullName.split("/");
    new SubmissionIntentService(this.runManager).createIntent({
      runId: bundle.manifest.runId,
      upstreamOwner: owner,
      upstreamRepo: repo,
      title,
      body: bundle.prDraft,
      baseBranch: workspace.artifact.baseBranch,
      branchName: workspace.artifact.branchName,
      commitMessage: title,
      isDraft: true,
    });

    const result = this.runManager.getRun(bundle.manifest.runId);
    if (!result || result.manifest.currentPhase !== "GOVERNANCE_AUDITED") {
      throw new TrustedRunMaterializationError(
        "host materialization did not produce a governance-ready canonical run.",
      );
    }
    return result;
  }

  private parsePatch(raw: RunTransferBundle["patch"]): PatchDraft {
    let value: unknown = raw;
    if (typeof raw === "string") {
      try {
        value = JSON.parse(raw);
      } catch {
        throw new TrustedRunMaterializationError(
          "transferred patch is not valid JSON.",
        );
      }
    }
    const parsed = PatchDraftSchema.safeParse(value);
    if (!parsed.success || parsed.data.files.length === 0) {
      throw new TrustedRunMaterializationError(
        "transferred patch does not contain a valid non-empty PatchDraft.",
      );
    }
    return parsed.data;
  }
}
