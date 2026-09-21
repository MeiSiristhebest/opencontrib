import { createHash } from "node:crypto";
import {
  ApprovalArtifactSchema,
  ResultArtifactSchema,
  SubmissionArtifactSchema,
  SubmissionIntentArtifactSchema,
  type SubmissionArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { ApprovalService } from "../governance/approval-service.js";
import { ProfileFlywheel } from "../flywheel/profile-sync.js";
import {
  RemoteCompletionAttestationSchema,
  type RemoteCompletionAttestation,
} from "../run/completion-attestation.js";
import { TrustedRunMaterializer } from "../run/trusted-run-host.js";
import {
  markCanonicalRunFailed,
  recordCanonicalRunFailure,
} from "../run/canonical-writer.js";
import {
  RunTransferBundleSchema,
  type RunTransferBundle,
} from "../run/run-transfer.js";
import { GitHubSubmissionService } from "./submission-service.js";

export interface TrustedSubmissionRequest {
  runId: string;
  expectedIntentSha256?: string;
  /** Optional untrusted proposal; the host re-materializes it in its own store. */
  runBundle?: RunTransferBundle;
}

export class SubmissionApprovalRequiredError extends Error {
  readonly approvalChallenge: ReturnType<ApprovalService["requestApproval"]>;

  constructor(challenge: ReturnType<ApprovalService["requestApproval"]>) {
    super(
      `ApprovalRequiredError: trusted host has prepared the run and is awaiting approval for intent ${challenge.intentSha256}.`,
    );
    this.name = "SubmissionApprovalRequiredError";
    this.approvalChallenge = challenge;
  }
}

/**
 * Host-side broker facade for the provider-write operation.
 *
 * The agent-facing CLI/MCP client talks to this facade through a separately
 * deployed transport. The facade intentionally accepts only a run ID and
 * re-reads canonical artifacts; callers cannot supply provider options or a
 * GitHub credential.
 */
function isRetryableProviderFailure(message: string): boolean {
  return /\b5\d\d\b|transient|temporar(?:y|ily)|rate[- ]?limit|timeout/i.test(
    message,
  );
}

export class TrustedSubmissionBroker {
  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly submissionService: GitHubSubmissionService,
    private readonly materializer?: TrustedRunMaterializer,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ message: "Only POST is supported." }),
        { status: 405, headers: { "content-type": "application/json" } },
      );
    }
    try {
      const payload = (await request.json()) as Record<string, unknown>;
      if (typeof payload.runId !== "string") {
        throw new Error("SubmissionBrokerRequestError: runId is required.");
      }
      let runBundle: RunTransferBundle | undefined;
      if (payload.runBundle !== undefined) {
        const parsedBundle = RunTransferBundleSchema.safeParse(
          payload.runBundle,
        );
        if (!parsedBundle.success) {
          throw new Error(
            "SubmissionBrokerRequestError: runBundle failed the trusted transfer schema.",
          );
        }
        if (parsedBundle.data.manifest.runId !== payload.runId) {
          throw new Error(
            "SubmissionBrokerRequestError: runBundle runId does not match request runId.",
          );
        }
        runBundle = parsedBundle.data;
      }
      const artifact = await this.submit({
        runId: payload.runId,
        expectedIntentSha256:
          typeof payload.expectedIntentSha256 === "string"
            ? payload.expectedIntentSha256
            : undefined,
        runBundle,
      });
      const completion = this.completeRun(payload.runId, artifact);
      return new Response(
        JSON.stringify({
          submissionArtifact: artifact,
          completionAttestation: completion,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Broker request rejected.";
      const approval =
        error instanceof SubmissionApprovalRequiredError
          ? error.approvalChallenge
          : undefined;
      const code = approval ? "APPROVAL_REQUIRED" : undefined;
      const status = message.includes("RequestError") ? 400 : 409;
      return new Response(
        JSON.stringify({ message, code, approvalChallenge: approval }),
        {
          status,
          headers: { "content-type": "application/json" },
        },
      );
    }
  }

  async submit(request: TrustedSubmissionRequest): Promise<SubmissionArtifact> {
    if (!request.runId.trim()) {
      throw new Error("SubmissionBrokerRequestError: runId is required.");
    }
    let run = this.runManager.getRun(request.runId);
    if (!run && request.runBundle) {
      if (!this.materializer) {
        throw new Error(
          "SubmissionBrokerConfigurationError: trusted run materializer is not configured.",
        );
      }
      run = await this.materializer.materialize(request.runBundle);
    }
    const intent = SubmissionIntentArtifactSchema.safeParse(
      run?.artifacts.submissionIntent,
    );
    if (!intent.success) {
      throw new Error(
        "SubmissionBrokerRejectedError: canonical SubmissionIntentArtifact is missing or invalid.",
      );
    }
    if (
      request.expectedIntentSha256 !== undefined &&
      request.expectedIntentSha256 !== intent.data.intentSha256
    ) {
      throw new Error(
        "SubmissionIntentMismatchError: requested intent does not match the canonical run.",
      );
    }
    // A provider write may have succeeded just before a response, cleanup, or
    // completion failure. Reconcile the canonical verified artifact instead of
    // attempting a second provider write or rolling the lifecycle backward.
    if (
      run &&
      (run.manifest.currentPhase === "PR_SUBMITTED" ||
        run.manifest.currentPhase === "COMPLETED")
    ) {
      const existingSubmission = SubmissionArtifactSchema.safeParse(
        run.artifacts.submission,
      );
      if (
        !existingSubmission.success ||
        existingSubmission.data.runId !== request.runId ||
        existingSubmission.data.intentSha256 !== intent.data.intentSha256
      ) {
        throw new Error(
          "SubmissionBrokerIntegrityError: terminal submission phase lacks a matching verified SubmissionArtifact.",
        );
      }
      this.submissionService.authorizeSubmission(request.runId);
      return existingSubmission.data;
    }
    const approval = ApprovalArtifactSchema.safeParse(run?.artifacts.approval);
    if (!approval.success) {
      const challenge = new ApprovalService(this.runManager).requestApproval(
        request.runId,
      );
      throw new SubmissionApprovalRequiredError(challenge);
    }

    let result: Awaited<ReturnType<GitHubSubmissionService["submit"]>>;
    try {
      result = await this.submissionService.submit(request.runId);
    } catch (error) {
      // Preserve the approved phase for explicitly retryable provider
      // outages. A retry is still re-authorized from canonical artifacts; no
      // lifecycle rollback or automatic PR deletion is attempted. Non-retryable
      // verification/provider failures remain terminally FAILED for
      // reconciliation.
      try {
        const reason = error instanceof Error ? error.message : String(error);
        if (isRetryableProviderFailure(reason)) {
          recordCanonicalRunFailure(
            this.runManager,
            request.runId,
            reason,
            true,
            true,
          );
        } else {
          markCanonicalRunFailed(
            this.runManager,
            request.runId,
            reason,
            false,
            true,
          );
        }
      } catch {
        // Preserve the provider error if the failure marker cannot be sealed.
      }
      throw error;
    }
    if (
      result.submissionArtifact.runId !== request.runId ||
      result.submissionArtifact.intentSha256 !== intent.data.intentSha256 ||
      result.submissionArtifact.verified !== true
    ) {
      throw new Error(
        "SubmissionBrokerIntegrityError: provider result is not bound to the canonical intent.",
      );
    }
    return result.submissionArtifact;
  }

  /**
   * Host-side canonical completion: seals ResultArtifact, syncs host Flywheel,
   * advances to COMPLETED, and issues a RemoteCompletionAttestation.
   */
  completeRun(
    runId: string,
    submission: SubmissionArtifact,
  ): RemoteCompletionAttestation {
    const parsedSubmission = SubmissionArtifactSchema.safeParse(submission);
    if (
      !parsedSubmission.success ||
      parsedSubmission.data.runId !== runId ||
      parsedSubmission.data.verified !== true
    ) {
      throw new Error(
        "SubmissionBrokerIntegrityError: completion requires a verified canonical SubmissionArtifact for the requested run.",
      );
    }
    const flywheel = new ProfileFlywheel();
    flywheel.syncFromRun(this.runManager, runId);
    const run = this.runManager.getRun(runId);
    const resultResult = ResultArtifactSchema.safeParse(run?.artifacts.result);
    if (!resultResult.success) {
      throw new Error(
        "SubmissionBrokerIntegrityError: host did not persist a verified ResultArtifact before issuing completion.",
      );
    }
    const resultArtifact = resultResult.data;
    const resultSha256 = createHash("sha256")
      .update(JSON.stringify(resultArtifact))
      .digest("hex");
    const attestation = {
      runId,
      hostIntentSha256: parsedSubmission.data.intentSha256,
      prNumber: parsedSubmission.data.prNumber,
      prUrl: parsedSubmission.data.prUrl,
      headSha: parsedSubmission.data.headSha,
      resultSha256,
      verified: true as const,
      completedAt: parsedSubmission.data.submittedAt,
      submissionArtifact: parsedSubmission.data,
      resultArtifact,
    };
    return RemoteCompletionAttestationSchema.parse(attestation);
  }
}
