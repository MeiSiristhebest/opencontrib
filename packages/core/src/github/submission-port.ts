import type { SubmissionArtifact } from "../contracts/schemas.js";

/**
 * Agent-facing submission boundary. Implementations may request a trusted host
 * operation, but they must not accept provider credentials or arbitrary PR
 * payloads from the agent.
 */
export interface SubmissionPort {
 submit(
  runId: string,
  expectedIntentSha256?: string,
 ): Promise<SubmissionArtifact>;
}
