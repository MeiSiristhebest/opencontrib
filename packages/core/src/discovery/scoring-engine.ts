/**
 * Backward-compatible shim. The pure candidate-scoring logic now lives in the
 * dependency-free `domain/` layer (Task 8). This file re-exports it so existing
 * call sites keep importing from the original path.
 *
 * The domain functions require an explicit `now` (Clock) parameter so the
 * domain layer never reaches for the wall clock directly. To preserve
 * backward compatibility with callers that don't thread a Clock, this shim
 * supplies thin wrappers that default `now` to `Date.now()` — the wall-clock
 * read lives here in the infrastructure layer, where it belongs.
 */

export type {
  ScoreCandidateInput,
  IssueScoringResult,
  ScoreBreakdown,
} from '../domain/scoring.js';
export {
  getSearchAliasQuery,
  matchesProfileTerm,
  applyDiversityReranking,
} from '../domain/scoring.js';

import {
  scoreCandidateIssue as scoreCandidateIssueDomain,
  computeActivityFreshnessModifier as computeActivityFreshnessModifierDomain,
  calculateLatestActivityTimestamp as calculateLatestActivityTimestampDomain,
} from '../domain/scoring.js';
import type { ScoreCandidateInput, IssueScoringResult } from '../domain/scoring.js';

/**
 * Backward-compatible wrapper: supplies `now` from the wall clock when the
 * caller omits it. Callers that want deterministic tests should pass `now`
 * explicitly (or call the domain function directly).
 */
export function scoreCandidateIssue(
  input: Omit<ScoreCandidateInput, 'now'> & { now?: number },
): IssueScoringResult {
  const now = input.now ?? Date.now();
  return scoreCandidateIssueDomain({ ...input, now });
}

/**
 * Backward-compatible wrapper: defaults `now` to the wall clock.
 */
export function computeActivityFreshnessModifier(
  activityTimestampMs: number,
  now: number = Date.now(),
): number {
  return computeActivityFreshnessModifierDomain(activityTimestampMs, now);
}

/**
 * Backward-compatible wrapper: defaults `now` to the wall clock.
 */
export function calculateLatestActivityTimestamp(
  issue: {
    createdAt: string;
    updatedAt?: string;
    latestCommentAt?: string;
    commentDates?: string[];
  },
  now: number = Date.now(),
): number {
  return calculateLatestActivityTimestampDomain(issue, now);
}
