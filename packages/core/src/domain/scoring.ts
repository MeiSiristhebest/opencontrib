/**
 * Candidate opportunity scoring — pure, dependency-free domain logic.
 *
 * Relocated into the `domain/` layer (Task 8). Contains no I/O: it performs only
 * deterministic string/regex/arithmetic transformations over its inputs. The
 * architecture guard forbids the filesystem, subprocess, or process-environment
 * modules here.
 */

import type { FeasibilityAssessment } from '../contracts/schemas.js';
import { TechnologyMatcher } from './matcher.js';

export interface ScoreCandidateInput {
  profile: {
    techStack: string[];
    focusAreas: string[];
    proficiency?: 'beginner' | 'intermediate' | 'expert' | 'advanced';
    minMatchScore?: number;
  };
  issue: {
    title: string;
    body?: string;
    labels?: string[];
    createdAt: string;
    updatedAt?: string;
    latestCommentAt?: string;
    commentDates?: string[];
    repoStars?: number;
  };
  feasibility: FeasibilityAssessment;
  /**
   * Required clock for the freshness modifier. Production callers obtain this
   * from the `Clock` port (infrastructure); tests pass a fixed timestamp for
   * deterministic assertions. Required so the domain layer never reaches for
   * the wall clock directly.
   */
  now: number;
}

export interface ScoreBreakdown {
  profileKeywordScore: number;
  domainMatchScore: number;
  feasibilityScore: number;
  freshnessModifier: number;
  actionabilityModifier: number;
  repoPopularityBonus: number;
}

export interface MatchedSignals {
  techStack: string[];
  focusAreas: string[];
  labels: string[];
  freshnessModifier: number;
  actionabilityModifier: number;
}

export interface IssueScoringResult {
  rawScore: number;
  adjustedScore: number;
  breakdown: ScoreBreakdown;
  matchedSignals: MatchedSignals;
}

/**
 * Robust term matcher with word-boundary awareness and canonical alias handling.
 * Delegates to TechnologyMatcher.
 */
export function matchesProfileTerm(text: string, term: string): boolean {
  return TechnologyMatcher.matches(text, term);
}

/**
 * Builds GitHub Search aliases for a technical term without stripping crucial characters.
 */
export function getSearchAliasQuery(term: string): string {
  return TechnologyMatcher.getSearchAliasQuery(term);
}

/**
 * Calculates the exact latest activity timestamp (ms) across all dates.
 * Strictly implements Math.max(createdAt, updatedAt, latestCommentAt, ...commentDates).
 */
export function calculateLatestActivityTimestamp(
  issue: {
    createdAt: string;
    updatedAt?: string;
    latestCommentAt?: string;
    commentDates?: string[];
  },
  now: number,
): number {
  const timestamps: number[] = [];

  const createdTime = Date.parse(issue.createdAt);
  if (!isNaN(createdTime) && createdTime > 0) timestamps.push(createdTime);

  if (issue.updatedAt) {
    const updatedTime = Date.parse(issue.updatedAt);
    if (!isNaN(updatedTime) && updatedTime > 0) timestamps.push(updatedTime);
  }

  if (issue.latestCommentAt) {
    const commentTime = Date.parse(issue.latestCommentAt);
    if (!isNaN(commentTime) && commentTime > 0) timestamps.push(commentTime);
  }

  if (issue.commentDates && Array.isArray(issue.commentDates)) {
    for (const d of issue.commentDates) {
      const t = Date.parse(d);
      if (!isNaN(t) && t > 0) timestamps.push(t);
    }
  }

  // Fallback when no parseable timestamp is present: fall back to createdAt if
  // it parsed, otherwise the injected clock value. `now` is required so the
  // domain layer never reaches for the wall clock directly.
  if (timestamps.length > 0) return Math.max(...timestamps);
  return isNaN(createdTime) ? now : createdTime;
}

/**
 * Calibrated Freshness Modifier based on latest meaningful activity in days.
 * Bounded between -20 and +6 points.
 *
 * The `now` parameter makes the time source injectable: production callers omit
 * it (defaulting to the wall clock), while tests pass a fixed timestamp for
 * deterministic assertions. This keeps the domain layer free of hidden,
 * non-injectable global state.
 */
export function computeActivityFreshnessModifier(
  activityTimestampMs: number,
  now: number,
): number {
  const ageDays = (now - activityTimestampMs) / (1000 * 60 * 60 * 24);

  if (ageDays < 30) return 6;    // Fresh (< 1 month)
  if (ageDays < 90) return 2;    // Active (< 3 months)
  if (ageDays < 180) return -6;  // Stale (> 3 months)
  if (ageDays < 365) return -12; // Very stale (> 6 months)
  return -20;                    // Dormant (> 1 year)
}

/**
 * Calibrated Actionability Modifier based on code blocks, reproduction steps, error traces.
 * Bounded between -6 and +6 points.
 */
export function computeActionabilityModifier(body?: string): number {
  if (!body || body.trim().length < 50) return -6; // Too brief / vague

  let modifier = 0;
  // Code block or stack trace
  if (/```|`[^`]+`|\bat\s+[\w$./]+\s*\(/i.test(body)) modifier += 3;
  // Reproduction steps or expected vs actual
  if (/reproduce|reproduction|steps to|expected|actual behavior|to reproduce/i.test(body)) modifier += 3;
  // Clear error message or assertion
  if (/error:|exception:|assertion|panic:|traceback/i.test(body)) modifier += 2;

  return Math.min(6, modifier);
}

export const DEEP_WATER_ARCHETYPES = [
  {
    id: 'protocol_serialization',
    name: 'Protocol & Serialization Contract Drift',
    regex: /\b(falsy value|zero-value|omitempty|serialization drift|http2 case|chunked truncation|sse keepalive|unmarshal|deserialization)\b/i,
  },
  {
    id: 'lifecycle_resource_leak',
    name: 'Lifecycle, Watcher & Resource Leaks',
    regex: /\b(goroutine leak|memory leak|handle leak|fd leak|unclosed fd|lsof|watcher leak|listener leak|context cancel|zombie process|dispose leak)\b/i,
  },
  {
    id: 'distributed_cache_consistency',
    name: 'Distributed Cache & Invalidation Hazards',
    regex: /\b(cache stampede|cache dogpile|falsy cache|cache penetration|cache breakdown|idempotency|monotonicity break|dirty read)\b/i,
  },
  {
    id: 'memory_tensor_abi',
    name: 'Memory Layout & Tensor Contiguity',
    regex: /\b(non-contiguous|strided tensor|tensor contiguity|segfault|cgo pointer|dangling pointer|memory alignment|cuda kernel crash)\b/i,
  },
  {
    id: 'perf_redos_storm',
    name: 'ReDoS, Retry Storms & Backpressure Collapse',
    regex: /\b(redos|catastrophic backtracking|thundering herd|retry storm|exponential backoff|full jitter|backpressure collapse)\b/i,
  },
  {
    id: 'chrono_time_monotonicity',
    name: 'Time Monotonicity & Chrono Hazards',
    regex: /\b(monotonic clock|wall clock|time rollback|ntp drift|dst jump|leap second|time inversion)\b/i,
  },
  {
    id: 'compiler_escape_optimization',
    name: 'Compiler / JIT Escape Analysis Violations',
    regex: /\b(escape analysis|stack allocation|heap escape|inline failure|gc pressure|stw spike|branch prediction)\b/i,
  },
  {
    id: 'numerical_crossplatform_bounds',
    name: 'Numerical Bounds & Cross-Platform Invariants',
    regex: /\b(nan|\+inf|-inf|deadlock|race condition|data race|crlf|path traversal|filepath\.toslash|fail-closed|overflow|timeout hang|process hang|panic)\b/i,
  },
] as const;

/**
 * Single Source of Truth for Candidate Opportunity Scoring.
 * Mathematically calibrated to prevent score saturation:
 * - 0 profile hits: score ~35-48 (< default threshold 70)
 * - 1 profile hit: score ~60-70
 * - 2 profile hits: score ~78-88
 * - 3+ strong hits: score ~90-98
 */
export function scoreCandidateIssue(input: ScoreCandidateInput): IssueScoringResult {
  const { profile, issue, feasibility } = input;
  const fullText = `${issue.title} ${issue.body || ''}`;
  const normalizedLabels = (issue.labels || []).map((l) => l.toLowerCase());

  // 1. Profile Keyword & Domain Focus Area Matching (Using TechnologyMatcher)
  const matchedTech: string[] = [];
  for (const tech of profile.techStack) {
    if (matchesProfileTerm(fullText, tech)) {
      matchedTech.push(tech.toLowerCase());
    }
  }

  const matchedAreas: string[] = [];
  for (const area of profile.focusAreas) {
    if (matchesProfileTerm(fullText, area)) {
      matchedAreas.push(area.toLowerCase());
    }
  }

  const totalHits = matchedTech.length + matchedAreas.length;
  // Calibrated Profile Relevance Score (0 to 100)
  let profileKeywordScore = 15; // Baseline when completely irrelevant
  if (totalHits === 1) {
    profileKeywordScore = 45;
  } else if (totalHits === 2) {
    profileKeywordScore = 75;
  } else if (totalHits >= 3) {
    profileKeywordScore = Math.min(100, 75 + (totalHits - 2) * 10);
  }

  // 2. Domain & Label Heuristics with 8-Dimensional Deep-Water Defect Detection
  let domainMatchScore = 25;
  const matchedLabels: string[] = [];

  if (normalizedLabels.some((l) => /good first issue|starter|easy/i.test(l))) {
    domainMatchScore += 15;
    matchedLabels.push('good-first-issue');
  }
  if (normalizedLabels.some((l) => /help wanted/i.test(l))) {
    domainMatchScore += 10;
    matchedLabels.push('help-wanted');
  }
  if (normalizedLabels.some((l) => /bug|fix|defect|regression/i.test(l)) || /fix|bug|defect|regression/i.test(issue.title)) {
    domainMatchScore += 10;
    matchedLabels.push('bugfix');
  }

  // Evaluate against the 8 Deep-Water Archetypes
  const matchedDeepWaterArchetypes: string[] = [];
  for (const archetype of DEEP_WATER_ARCHETYPES) {
    if (archetype.regex.test(fullText)) {
      matchedDeepWaterArchetypes.push(archetype.id);
      matchedLabels.push(`deep-water:${archetype.id}`);
    }
  }

  let deepWaterBonus = 0;
  if (matchedDeepWaterArchetypes.length > 0) {
    deepWaterBonus = Math.min(25, 15 + (matchedDeepWaterArchetypes.length - 1) * 5);
  }

  // Low-SNR & Anti-Farming Filter (-35 Penalty)
  const lowSnrRegex = /\b(typo|misspelling|spelling mistake|awesome list|awesome-list|fix typo|readme typo)\b/i;
  let lowSnrPenalty = 0;
  if (lowSnrRegex.test(fullText) && matchedDeepWaterArchetypes.length === 0) {
    lowSnrPenalty = 35;
    matchedLabels.push('low-snr-warning');
  }

  // 3. Repository Popularity Signal (Stars: +3 to +6)
  let repoPopularityBonus = 0;
  const stars = issue.repoStars ?? 0;
  if (stars >= 5000) {
    repoPopularityBonus = 6;
  } else if (stars >= 50) {
    repoPopularityBonus = 3;
  }

  // 4. Activity Freshness: strictly Math.max across createdAt, updatedAt, and comments
  const latestActivityMs = calculateLatestActivityTimestamp(issue, input.now);
  const freshnessModifier = computeActivityFreshnessModifier(latestActivityMs, input.now);

  // 5. Actionability Modifier (-6 to +6)
  const actionabilityModifier = computeActionabilityModifier(issue.body);

  // 6. Feasibility Score (Single Penalty Application)
  const penalty = Math.max(0, feasibility.scorePenalty || 0);
  const feasibilityScore = Math.max(0, 100 - penalty);

  // 7. Weighted Score Formula: Profile relevance dominates (50%), Domain & Deep Water (30%), Feasibility (20%)
  const baseWeightedScore =
    0.50 * profileKeywordScore +
    0.30 * (domainMatchScore + repoPopularityBonus + deepWaterBonus - lowSnrPenalty) +
    0.20 * feasibilityScore;

  const rawScore = Math.max(0, Math.min(100, Math.round(baseWeightedScore + freshnessModifier + actionabilityModifier)));
  const adjustedScore = rawScore;

  return {
    rawScore,
    adjustedScore,
    breakdown: {
      profileKeywordScore,
      domainMatchScore: domainMatchScore + deepWaterBonus - lowSnrPenalty,
      feasibilityScore,
      freshnessModifier,
      actionabilityModifier,
      repoPopularityBonus,
    },
    matchedSignals: {
      techStack: matchedTech,
      focusAreas: matchedAreas,
      labels: matchedLabels,
      freshnessModifier,
      actionabilityModifier,
    },
  };
}

/**
 * 2-Stage Diversity Reranking Pipeline.
 * Stage 1: Sort by rawScore descending.
 * Stage 2: Apply per-repo appearance frequency decay to prevent repository monopoly in Top N.
 */
export function applyDiversityReranking<T extends { repoFullName: string; rawScore: number }>(
  items: T[],
  decayPerAppearance = 4,
): Array<{ item: T; rankScore: number; diversityPenalty: number }> {
  // Stage 1: Pure Relevance Order
  const sorted = [...items].sort((a, b) => b.rawScore - a.rawScore);

  // Stage 2: Diversified Decay
  const repoSeenCount = new Map<string, number>();
  return sorted
    .map((item) => {
      const seen = repoSeenCount.get(item.repoFullName) || 0;
      repoSeenCount.set(item.repoFullName, seen + 1);
      const diversityPenalty = seen * decayPerAppearance;
      const rankScore = Math.max(0, item.rawScore - diversityPenalty);
      return {
        item,
        rankScore,
        diversityPenalty,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}
