/**
 * Backward-compatible shim. The pure issue-qualification logic now lives in the
 * dependency-free `domain/` layer (Task 8). This file re-exports it so existing
 * call sites keep importing from the original path.
 *
 * The domain `qualifyIssue` requires an explicit `now` (Clock) parameter so the
 * domain layer never reaches for the wall clock directly. To preserve backward
 * compatibility with callers that don't thread a Clock, this shim supplies a
 * thin wrapper that defaults `now` to `Date.now()` — the wall-clock read lives
 * here in the infrastructure layer, where it belongs.
 */

export type {
 QualifyIssueInput,
 QualificationTrack,
 IssueCommentItem,
} from "../domain/qualification.js";
export type { QualificationResult } from "../contracts/schemas.js";
export { ACTION_BLOCKING_LABELS } from "../domain/qualification.js";

import { qualifyIssue as qualifyIssueDomain } from "../domain/qualification.js";
import type {
 QualifyIssueInput,
 QualificationResult,
} from "../domain/qualification.js";

/**
 * Backward-compatible wrapper: supplies `now` from the wall clock when the
 * caller omits it. Callers that want deterministic tests should pass `now`
 * explicitly (or call the domain function directly).
 */
export function qualifyIssue(
 input: Omit<QualifyIssueInput, "now"> & { now?: number },
): QualificationResult {
 const now = input.now ?? Date.now();
 return qualifyIssueDomain({ ...input, now });
}
