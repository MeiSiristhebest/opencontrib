import type {
  ContributionPrService,
  PrSubmissionOptions,
  PrSubmissionResult,
} from "./contribution-pr-service.js";
import type { GitHubClient } from "../discovery/github-client.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import {
  ApprovalArtifactSchema,
  SubmissionArtifactSchema,
  SubmissionIntentArtifactSchema,
  type SubmissionArtifact,
  type SubmissionIntentArtifact,
} from "../contracts/schemas.js";
import { ApprovalService } from "../governance/approval-service.js";

export class SubmissionVerificationError extends Error {
  constructor(message: string) {
    super(`SubmissionVerificationError: ${message}`);
    this.name = "SubmissionVerificationError";
  }
}

export interface SubmissionPermit {
  runId: string;
  issuedAt: string;
  owner: string;
  repo: string;
  baseBranch: string;
  branchName: string;
  title: string;
  body: string;
  commitMessage: string;
  isDraft: boolean;
  files: PrSubmissionOptions["files"];
  intentSha256: string;
  patchSha256: string;
  evidenceSha256: string;
  governanceSha256: string;
  prBodySha256: string;
  approvalMode: "explicit_human" | "policy_waived";
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export class GitHubSubmissionService {
  private readonly approvalService: ApprovalService;

  constructor(
    private readonly prService: ContributionPrService,
    private readonly client: GitHubClient,
    private readonly runManager: ContributionRunManager,
  ) {
    this.approvalService = new ApprovalService(runManager);
  }

  /**
   * Re-read and verify every approval/intent hash immediately before any
   * provider side effect. Owner/repo arguments are inspection-only and can
   * never override the stored intent.
   */
  authorizeSubmission(
    runId: string,
    owner?: string,
    repo?: string,
  ): SubmissionPermit {
    const run = this.runManager.getRun(runId);
    if (!run) {
      throw new SubmissionVerificationError(`Contribution run ${runId} does not exist`);
    }
    if (run.manifest.currentPhase !== "GOVERNANCE_AUDITED") {
      throw new SubmissionVerificationError(
        `Cannot authorize submission: run is in phase "${run.manifest.currentPhase}", expected "GOVERNANCE_AUDITED".`,
      );
    }

    const intentResult = SubmissionIntentArtifactSchema.safeParse(
      run.artifacts.submissionIntent,
    );
    const approvalResult = ApprovalArtifactSchema.safeParse(run.artifacts.approval);
    if (!intentResult.success) {
      throw new SubmissionVerificationError(
        "Cannot authorize submission: missing or invalid SubmissionIntentArtifact.",
      );
    }
    if (!approvalResult.success) {
      throw new SubmissionVerificationError(
        "Cannot authorize submission: missing or invalid ApprovalArtifact from a trusted authority.",
      );
    }
    const intent = intentResult.data;
    const approval = approvalResult.data;

    if (owner && owner.toLowerCase() !== intent.upstreamOwner.toLowerCase()) {
      throw new SubmissionVerificationError(
        `Cannot authorize submission: requested owner does not match the approved intent.`,
      );
    }
    if (repo && repo.toLowerCase() !== intent.upstreamRepo.toLowerCase()) {
      throw new SubmissionVerificationError(
        `Cannot authorize submission: requested repo does not match the approved intent.`,
      );
    }

    const integrity = this.approvalService.verifyApprovalIntegrity(runId);
    if (!integrity.valid) {
      throw new SubmissionVerificationError(
        `Cannot authorize submission: ${integrity.reason || "Approval integrity check failed."}`,
      );
    }

    return this.permitFromIntent(intent, approval);
  }

  async submit(runId: string): Promise<{
    submissionResult: PrSubmissionResult;
    submissionArtifact: SubmissionArtifact;
  }> {
    const permit = this.authorizeSubmission(runId);
    return this.submitAndVerifyPullRequest({ runId, permit });
  }

  async submitAndVerifyPullRequest(options: {
    runId: string;
    permit: SubmissionPermit;
    /**
     * Deprecated compatibility input. If present it must be byte-for-byte
     * equivalent to the approved intent; it can never override it.
     */
    submissionOptions?: Partial<PrSubmissionOptions>;
  }): Promise<{
    submissionResult: PrSubmissionResult;
    submissionArtifact: SubmissionArtifact;
  }> {
    if (!options.permit || options.permit.runId !== options.runId) {
      throw new SubmissionVerificationError(
        "Invalid or missing SubmissionPermit. authorizeSubmission must succeed before submitting.",
      );
    }

    // Re-authorize from disk so a forged/stale permit cannot authorize a TOCTOU
    // race. Only the fresh, stored intent is used for the provider call.
    const permit = this.authorizeSubmission(options.runId);
    if (options.permit.intentSha256 !== permit.intentSha256) {
      throw new SubmissionVerificationError(
        "SubmissionPermitMismatchError: permit does not match the current approved intent.",
      );
    }
    if (options.submissionOptions) {
      const supplied = options.submissionOptions as Record<string, unknown>;
      const approved = this.optionsFromPermit(permit);
      for (const key of [
        "upstreamOwner",
        "upstreamRepo",
        "baseBranch",
        "title",
        "body",
        "branchName",
        "commitMessage",
        "isDraft",
        "files",
      ]) {
        if (supplied[key] !== undefined && !sameJson(supplied[key], (approved as any)[key])) {
          throw new SubmissionVerificationError(
            `SubmissionIntentMismatchError: caller-supplied '${key}' differs from the approved intent.`,
          );
        }
      }
    }

    const effectiveOptions = this.optionsFromPermit(permit);
    let result: PrSubmissionResult;
    try {
      result = await this.prService.submitPullRequest(effectiveOptions);
    } catch (err: any) {
      throw new SubmissionVerificationError(`Provider submission failed: ${err.message}`);
    }

    const octokit = (this.client as any).octokit;
    if (!octokit?.rest?.pulls?.get) {
      throw new SubmissionVerificationError(
        "GitHub octokit client is unavailable; cannot verify submitted PR with provider.",
      );
    }

    let headSha = "";
    try {
      const pr = await octokit.rest.pulls.get({
        owner: effectiveOptions.upstreamOwner,
        repo: effectiveOptions.upstreamRepo,
        pull_number: result.prNumber,
      });
      headSha = String(pr?.data?.head?.sha || "");
      if (!headSha) {
        throw new SubmissionVerificationError(
          `Provider did not return head.sha for PR #${result.prNumber}`,
        );
      }
      if (result.commitSha && headSha !== result.commitSha) {
        throw new SubmissionVerificationError(
          `Provider attestation mismatch: PR head SHA "${headSha}" does not match produced commit SHA "${result.commitSha}".`,
        );
      }
    } catch (err: any) {
      if (err instanceof SubmissionVerificationError) throw err;
      throw new SubmissionVerificationError(
        `GitHub provider verification failed for PR #${result.prNumber}: ${err.message}`,
      );
    }

    const expectedUrl = new RegExp(
      `^https://github\\.com/${escapeRegExp(effectiveOptions.upstreamOwner)}/${escapeRegExp(effectiveOptions.upstreamRepo)}/pull/${result.prNumber}$`,
      "i",
    );
    if (!expectedUrl.test(result.prUrl)) {
      throw new SubmissionVerificationError(
        "Provider returned a PR URL that does not match the approved target and number.",
      );
    }

    const artifact: SubmissionArtifact = {
      runId: options.runId,
      provider: "github",
      owner: effectiveOptions.upstreamOwner,
      repo: effectiveOptions.upstreamRepo,
      baseBranch: effectiveOptions.baseBranch || "main",
      branchName: effectiveOptions.branchName,
      intentSha256: permit.intentSha256,
      patchSha256: permit.patchSha256,
      evidenceSha256: permit.evidenceSha256,
      governanceSha256: permit.governanceSha256,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      headSha,
      submittedAt: new Date().toISOString(),
      verified: true,
    };
    SubmissionArtifactSchema.parse(artifact);

    saveCanonicalArtifact(
      this.runManager,
      options.runId,
      "submission",
      artifact as any,
      "PR_SUBMITTED",
    );
    return { submissionResult: result, submissionArtifact: artifact };
  }

  private permitFromIntent(
    intent: SubmissionIntentArtifact,
    approval: typeof ApprovalArtifactSchema._type,
  ): SubmissionPermit {
    return {
      runId: intent.runId,
      issuedAt: new Date().toISOString(),
      owner: intent.upstreamOwner,
      repo: intent.upstreamRepo,
      baseBranch: intent.baseBranch,
      branchName: intent.branchName,
      title: intent.title,
      body: intent.body,
      commitMessage: intent.commitMessage,
      isDraft: intent.isDraft,
      files: intent.files,
      intentSha256: intent.intentSha256,
      patchSha256: approval.patchSha256,
      evidenceSha256: approval.evidenceSha256,
      governanceSha256: approval.governanceSha256,
      prBodySha256: approval.prBodySha256,
      approvalMode: approval.approvalMode,
    };
  }

  private optionsFromPermit(permit: SubmissionPermit): PrSubmissionOptions {
    return {
      upstreamOwner: permit.owner,
      upstreamRepo: permit.repo,
      baseBranch: permit.baseBranch,
      title: permit.title,
      body: permit.body,
      branchName: permit.branchName,
      files: permit.files,
      commitMessage: permit.commitMessage,
      isDraft: permit.isDraft,
    };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
