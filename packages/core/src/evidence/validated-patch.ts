import { createHash } from "node:crypto";
import type { ValidatedPatchArtifact } from "../contracts/schemas.js";

/** Hash the immutable validated-patch payload without its self-referential digest. */
export function hashValidatedPatchArtifact(
  artifact:
    Omit<ValidatedPatchArtifact, "artifactSha256"> | ValidatedPatchArtifact,
): string {
  const value = artifact as ValidatedPatchArtifact;
  const payload = {
    runId: value.runId,
    patchSha256: value.patchSha256,
    actualDeltaSha256: value.actualDeltaSha256,
    baseCommitSha: value.baseCommitSha,
    redTreeSha256: value.redTreeSha256,
    greenTreeSha256: value.greenTreeSha256,
    // changedLines is a required, hash-bound field of every canonical
    // ValidatedPatchArtifact (the authoritative producer always computes it
    // from the git diff engine); there is no default that would let a
    // missing field and a real zero-line diff share one hash payload.
    changedLines: value.changedLines,
    files: value.files.map((file) => ({
      path: file.path,
      mode: file.mode,
      operation: file.operation,
      contentSha256: file.contentSha256,
    })),
    validatedAt: value.validatedAt,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
