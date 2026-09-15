import type {
  ContributionPrService,
  PrSubmissionOptions,
  PrSubmissionResult,
} from "./contribution-pr-service.js";
import type { GitHubClient } from "../discovery/github-client.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import {
  SubmissionArtifactSchema,
  type SubmissionArtifact,
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
  patchSha256: string;
  approvalMode: "explicit_human" | "policy_waived";
}

export interface SubmitRunPrOptions {
  runId: string;
  permit: SubmissionPermit;
  submissionOptions: PrSubmissionOptions;
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
   * Authorize a submission prior to initiating any external side effects (e.g. creating a GitHub PR).
   * Validates:
   * 1. Run exists and current phase is GOVERNANCE_AUDITED
   * 2. Evidence and governance artifacts exist
   * 3. ApprovalArtifact exists and passes cryptographic integrity verification (no TOCTOU mutation of patch/evidence/governance/prBody)
   * Returns a SubmissionPermit required for submitAndVerifyPullRequest.
   */
  authorizeSubmission(
    runId: string,
    owner: string,
    repo: string,
  ): SubmissionPermit {
    const run = this.runManager.getRun(runId);
    if (!run) {
      throw new SubmissionVerificationError(
        `Contribution run ${runId} does not exist`,
      );
    }

    if (run.manifest.currentPhase !== "GOVERNANCE_AUDITED") {
      throw new SubmissionVerificationError(
        `Cannot authorize submission: run is in phase "${run.manifest.currentPhase}", expected "GOVERNANCE_AUDITED".`,
      );
    }

    if (!run.artifacts.evidence) {
      throw new SubmissionVerificationError(
        "Cannot authorize submission: missing required evidence artifact.",
      );
    }

    if (!run.artifacts.governance) {
      throw new SubmissionVerificationError(
        "Cannot authorize submission: missing required governance artifact.",
      );
    }

    const approval = run.artifacts.approval as any;
    if (!approval) {
      throw new SubmissionVerificationError(
        "Cannot authorize submission: missing required ApprovalArtifact. Run approval service or record approval before submitting.",
      );
    }

    const integrity = this.approvalService.verifyApprovalIntegrity(runId);
    if (!integrity.valid) {
      throw new SubmissionVerificationError(
        `Cannot authorize submission: ${integrity.reason || "ApprovalArtifact integrity check failed."}`,
      );
    }

    return {
      runId,
      issuedAt: new Date().toISOString(),
      owner,
      repo,
      patchSha256: approval.patchSha256,
      approvalMode: approval.approvalMode,
    };
  }

  async submitAndVerifyPullRequest(options: SubmitRunPrOptions): Promise<{
    submissionResult: PrSubmissionResult;
    submissionArtifact: SubmissionArtifact;
  }> {
    const { runId, permit, submissionOptions } = options;
    if (!permit || permit.runId !== runId) {
      throw new SubmissionVerificationError(
        "Invalid or missing SubmissionPermit. authorizeSubmission must be called and succeed before submitting PR.",
      );
    }

    // Re-verify integrity immediately before side effects
    const integrity = this.approvalService.verifyApprovalIntegrity(runId);
    if (!integrity.valid) {
      throw new SubmissionVerificationError(
        `Cannot submit PR: ${integrity.reason || "Approval integrity violated before submission."}`,
      );
    }

    // 1. Submit PR via real ContributionPrService (side effect only after permit verification)
    const result = await this.prService.submitPullRequest(submissionOptions);

    // 2. Fetch/verify PR details from provider to ensure genuineness - fail-closed!
    const octokit = (this.client as any).octokit;
    if (!octokit) {
      throw new SubmissionVerificationError(
        "GitHub octokit client is unavailable; cannot verify submitted PR with provider.",
      );
    }

    let headSha = "";
    try {
      const pr = await octokit.rest.pulls.get({
        owner: submissionOptions.upstreamOwner,
        repo: submissionOptions.upstreamRepo,
        pull_number: result.prNumber,
      });
      if (!pr?.data?.head?.sha) {
        throw new SubmissionVerificationError(
          `Provider did not return head.sha for PR #${result.prNumber}`,
        );
      }
      headSha = pr.data.head.sha;
    } catch (err: any) {
      if (err instanceof SubmissionVerificationError) throw err;
      throw new SubmissionVerificationError(
        `GitHub provider verification failed for PR #${result.prNumber}: ${err.message}`,
      );
    }

    const artifact: SubmissionArtifact = {
      runId,
      provider: "github",
      owner: submissionOptions.upstreamOwner,
      repo: submissionOptions.upstreamRepo,
      prNumber: result.prNumber,
      prUrl: result.prUrl,
      headSha,
      submittedAt: new Date().toISOString(),
      verified: true,
    };

    SubmissionArtifactSchema.parse(artifact);

    // Save submission artifact trusted and advance phase to PR_SUBMITTED
    this.runManager.saveArtifactTrusted(
      runId,
      "submission",
      artifact,
      "PR_SUBMITTED",
    );

    return {
      submissionResult: result,
      submissionArtifact: artifact,
    };
  }
}
