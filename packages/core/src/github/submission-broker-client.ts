import {
  SubmissionArtifactSchema,
  type SubmissionArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import type { ApprovalChallenge } from "../governance/approval-service.js";
import {
  buildRunTransferBundle,
  type RunTransferBundle,
} from "../run/run-transfer.js";
import type {
  SubmissionPort,
  SubmissionPortResult,
} from "./submission-port.js";
import {
  RemoteCompletionAttestationSchema,
  type RemoteCompletionAttestation,
} from "../run/completion-attestation.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RemoteSubmissionBrokerOptions {
  /** Exact broker endpoint; no GitHub credential is accepted or stored here. */
  endpoint?: string;
  fetchImpl?: FetchLike;
  /** Local proposal source used only to let the trusted host re-materialize a run. */
  runManager?: ContributionRunManager;
  /** Explicit bundle provider for transports that do not use a local manager. */
  bundleProvider?: (runId: string) => RunTransferBundle;
}

/** Backward-compatible alias; the canonical shape is `SubmissionPortResult`. */
export type RemoteSubmissionBrokerResult = SubmissionPortResult;

export class SubmissionBrokerApprovalRequiredError extends Error {
  readonly approvalChallenge?: ApprovalChallenge;

  constructor(message: string, approvalChallenge?: ApprovalChallenge) {
    super(message);
    this.name = "SubmissionBrokerApprovalRequiredError";
    this.approvalChallenge = approvalChallenge;
  }
}

/** The only submission surface exposed to an agent-facing CLI/MCP client. */
export class RemoteSubmissionBrokerClient implements SubmissionPort {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;
  private readonly runManager?: ContributionRunManager;
  private readonly bundleProvider?: (runId: string) => RunTransferBundle;

  constructor(options: RemoteSubmissionBrokerOptions = {}) {
    const endpoint =
      options.endpoint || process.env.OPENCONTRIB_SUBMISSION_BROKER_URL;
    if (!endpoint) {
      throw new Error(
        "SubmissionBrokerRequiredError: agent-facing submission requires an external trusted submission broker. Set OPENCONTRIB_SUBMISSION_BROKER_URL.",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error(
        "SubmissionBrokerConfigurationError: broker endpoint must be a valid URL.",
      );
    }
    if (
      parsed.protocol !== "https:" &&
      parsed.hostname !== "localhost" &&
      parsed.hostname !== "127.0.0.1"
    ) {
      throw new Error(
        "SubmissionBrokerConfigurationError: broker endpoint must use HTTPS except for loopback development.",
      );
    }
    this.endpoint = parsed.toString();
    this.fetchImpl = options.fetchImpl || fetch;
    this.runManager = options.runManager;
    this.bundleProvider = options.bundleProvider;
  }

  async submit(
    runId: string,
    expectedIntentSha256?: string,
  ): Promise<SubmissionPortResult> {
    if (!runId.trim()) {
      throw new Error("SubmissionBrokerRequestError: runId is required.");
    }
    let runBundle: RunTransferBundle | undefined;
    if (this.bundleProvider) runBundle = this.bundleProvider(runId);
    else if (this.runManager)
      runBundle = buildRunTransferBundle(this.runManager, runId);

    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // A local expected intent belongs to the agent proposal and must not be
      // used to bind a separately materialized host run. The host returns its
      // own intent hash in the approval challenge.
      body: JSON.stringify({
        runId,
        expectedIntentSha256: runBundle ? undefined : expectedIntentSha256,
        runBundle,
      }),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `SubmissionBrokerProtocolError: broker returned a non-JSON response (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `HTTP ${response.status}`;
      const code =
        typeof payload === "object" && payload !== null && "code" in payload
          ? String((payload as { code?: unknown }).code)
          : "";
      if (code === "APPROVAL_REQUIRED") {
        const challenge =
          typeof payload === "object" &&
          payload !== null &&
          "approvalChallenge" in payload
            ? ((payload as { approvalChallenge?: unknown })
                .approvalChallenge as ApprovalChallenge)
            : undefined;
        throw new SubmissionBrokerApprovalRequiredError(message, challenge);
      }
      throw new Error(`SubmissionBrokerRejectedError: ${message}`);
    }

    const result = SubmissionArtifactSchema.safeParse(
      typeof payload === "object" &&
        payload !== null &&
        "submissionArtifact" in payload
        ? (payload as { submissionArtifact?: unknown }).submissionArtifact
        : payload,
    );
    if (!result.success) {
      throw new Error(
        "SubmissionBrokerProtocolError: trusted broker response did not contain a valid verified SubmissionArtifact.",
      );
    }
    const submissionArtifact = result.data as SubmissionArtifact;
    if (submissionArtifact.runId !== runId) {
      throw new Error(
        "SubmissionBrokerProtocolError: trusted broker returned a SubmissionArtifact for a different run.",
      );
    }
    if (
      expectedIntentSha256 !== undefined &&
      submissionArtifact.intentSha256 !== expectedIntentSha256
    ) {
      throw new Error(
        "SubmissionBrokerProtocolError: trusted broker returned a SubmissionArtifact for a different approved intent.",
      );
    }

    const hasAttestation =
      typeof payload === "object" &&
      payload !== null &&
      "completionAttestation" in payload;
    if (!hasAttestation) {
      throw new Error(
        "SubmissionBrokerProtocolError: trusted broker response is missing the required completionAttestation.",
      );
    }
    const attestationResult = RemoteCompletionAttestationSchema.safeParse(
      (payload as { completionAttestation?: unknown }).completionAttestation,
    );
    // Fail closed: a missing or invalid attestation is a protocol violation,
    // not optional noise. Silently accepting it would let a PR-shaped response
    // masquerade as a completed canonical run.
    if (!attestationResult.success) {
      throw new Error(
        `SubmissionBrokerProtocolError: trusted broker returned an invalid completionAttestation: ${attestationResult.error.issues
          .map((i) => i.message)
          .join("; ")}`,
      );
    }
    const completionAttestation = attestationResult.data;
    if (
      completionAttestation.runId !== runId ||
      completionAttestation.hostIntentSha256 !==
        submissionArtifact.intentSha256 ||
      completionAttestation.prNumber !== submissionArtifact.prNumber ||
      completionAttestation.prUrl !== submissionArtifact.prUrl ||
      completionAttestation.headSha !== submissionArtifact.headSha ||
      completionAttestation.submissionArtifact.runId !== runId ||
      completionAttestation.submissionArtifact.intentSha256 !==
        submissionArtifact.intentSha256
    ) {
      throw new Error(
        "SubmissionBrokerProtocolError: completion attestation is not bound to the returned verified submission.",
      );
    }

    return { submissionArtifact, completionAttestation };
  }
}
