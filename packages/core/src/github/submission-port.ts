import type { SubmissionArtifact } from "../contracts/schemas.js";
import type { RemoteCompletionAttestation } from "../run/completion-attestation.js";

/**
 * Result of an agent-facing submission request. The artifact is the verified
 * provider record; the completion attestation is the trusted host's canonical
 * completion receipt (present only when the host completed the run).
 */
export interface SubmissionPortResult {
  submissionArtifact: SubmissionArtifact;
  completionAttestation?: RemoteCompletionAttestation;
}

/**
 * Agent-facing submission boundary. Implementations may request a trusted host
 * operation, but they must not accept provider credentials or arbitrary PR
 * payloads from the agent.
 */
export interface SubmissionPort {
  submit(
    runId: string,
    expectedIntentSha256?: string,
  ): Promise<SubmissionPortResult>;
}
