import { createHash } from "node:crypto";
import {
  ApprovalArtifactSchema,
  SubmissionIntentArtifactSchema,
  type SubmissionArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { ApprovalService } from "../governance/approval-service.js";
import { ProfileFlywheel } from "../flywheel/profile-sync.js";
import type { RemoteCompletionAttestation } from "../run/completion-attestation.js";
import { TrustedRunMaterializer } from "../run/trusted-run-host.js";
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
    const approval = ApprovalArtifactSchema.safeParse(run?.artifacts.approval);
    if (!approval.success) {
      const challenge = new ApprovalService(this.runManager).requestApproval(
        request.runId,
      );
      throw new SubmissionApprovalRequiredError(challenge);
    }

    const result = await this.submissionService.submit(request.runId);
    if (result.submissionArtifact.intentSha256 !== intent.data.intentSha256) {
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
    const flywheel = new ProfileFlywheel();
    flywheel.syncFromRun(this.runManager, runId);
    const run = this.runManager.getRun(runId);
    const resultArtifact = run?.artifacts.result;
    const resultSha256 = createHash("sha256")
      .update(JSON.stringify(resultArtifact || ""))
      .digest("hex");
    return {
      runId,
      hostIntentSha256: submission.intentSha256,
      prNumber: submission.prNumber,
      prUrl: submission.prUrl,
      headSha: submission.headSha,
      resultSha256,
      verified: true,
      completedAt: submission.submittedAt,
      submissionArtifact: submission,
      resultArtifact: resultArtifact as any,
    };
  }
}
