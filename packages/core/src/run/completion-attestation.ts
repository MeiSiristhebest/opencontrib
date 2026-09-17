import { z } from "zod";
import {
  SubmissionArtifactSchema,
  ResultArtifactSchema,
} from "../contracts/schemas.js";

/**
 * Attestation issued by the Trusted Run Host upon completing provider submission,
 * authoritative Result creation, and Host-side Flywheel recording.
 */
export const RemoteCompletionAttestationSchema = z.object({
  runId: z.string(),
  hostIntentSha256: z.string(),
  prNumber: z.number(),
  prUrl: z.string(),
  headSha: z.string(),
  resultSha256: z.string(),
  verified: z.literal(true),
  completedAt: z.string(),
  submissionArtifact: SubmissionArtifactSchema,
  resultArtifact: ResultArtifactSchema,
});

export type RemoteCompletionAttestation = z.infer<
  typeof RemoteCompletionAttestationSchema
>;
