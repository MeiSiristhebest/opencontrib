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
 * In low-trust/development mode, delegates to EvidenceService. In production,
 * an out-of-process containerized execution worker should be injected instead.
 */
class LocalEvidenceServiceExecutionAdapter implements TrustedExecutionPort {
  constructor(private readonly runManager: ContributionRunManager) {}

  async captureRed(job: import("./trusted-execution.port.js").RedExecutionJob) {
    return new EvidenceService(this.runManager).captureRed({
      runId: job.runId,
      cwd: job.cwd,
      testCommand: job.testCommand,
      expectedAssertion: job.expectedAssertion,
      testFile: job.testFiles,
    });
  }

  async verifyGreen(
    job: import("./trusted-execution.port.js").GreenExecutionJob,
  ) {
    return new EvidenceService(this.runManager).verifyGreen({
      runId: job.runId,
      cwd: job.cwd,
      testCommand: job.testCommand,
      stressLoopCount: job.stressLoopCount ?? 1,
      concurrencyWorkers: job.concurrencyWorkers ?? 1,
    });
  }
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

  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly worktreeManager: WorktreeManager = new WorktreeManager(),
    executionPort?: TrustedExecutionPort,
  ) {
    this.executionPort =
      executionPort ??
      new LocalEvidenceServiceExecutionAdapter(this.runManager);
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

    await this.executionPort.captureRed({
      runId: bundle.manifest.runId,
      cwd: workspace.context.workspacePath,
      testCommand: bundle.redRecipe.command,
      expectedAssertion: bundle.redRecipe.expectedAssertion,
      testFiles: bundle.redRecipe.testFiles,
    });

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

    await this.executionPort.verifyGreen({
      runId: bundle.manifest.runId,
      cwd: workspace.context.workspacePath,
      testCommand: bundle.redRecipe.command,
      stressLoopCount: 1,
      concurrencyWorkers: 1,
    });

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
