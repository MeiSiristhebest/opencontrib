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
  runId: z.string().min(1),
  hostIntentSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  prNumber: z.number().finite().int().positive(),
  prUrl: z.string().url(),
  headSha: z.string().min(1),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/i),
  verified: z.literal(true),
  completedAt: z.string().min(1),
  submissionArtifact: SubmissionArtifactSchema,
  resultArtifact: ResultArtifactSchema,
});

export type RemoteCompletionAttestation = z.infer<
  typeof RemoteCompletionAttestationSchema
>;
