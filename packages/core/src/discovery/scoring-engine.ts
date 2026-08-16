import type { FeasibilityAssessment } from '../contracts/schemas.js';
import { TechnologyMatcher } from './technology-matcher.js';

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
export function calculateLatestActivityTimestamp(issue: {
  createdAt: string;
  updatedAt?: string;
  latestCommentAt?: string;
  commentDates?: string[];
}): number {
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

  return timestamps.length > 0 ? Math.max(...timestamps) : (isNaN(createdTime) ? Date.now() : createdTime);
}

/**
 * Calibrated Freshness Modifier based on latest meaningful activity in days.
 * Bounded between -20 and +6 points.
 */
export function computeActivityFreshnessModifier(activityTimestampMs: number): number {
  const now = Date.now();
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

  // 2. Domain & Label Heuristics (Base 25, Max 60)
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

  // Deep-Water Bugs & Cross-Platform Invariants Heuristics (+15 Bonus)
  const deepWaterRegex = /\b(nan|\+inf|-inf|deadlock|race condition|data race|goroutine leak|memory leak|handle leak|crlf|path traversal|fail-closed|overflow|timeout hang|process hang|panic|segfault)\b/i;
  let deepWaterBonus = 0;
  if (deepWaterRegex.test(fullText)) {
    deepWaterBonus = 15;
    matchedLabels.push('deep-water-bug');
  }

  // Low-SNR & Anti-Farming Filter (-35 Penalty)
  const lowSnrRegex = /\b(typo|misspelling|spelling mistake|awesome list|awesome-list|fix typo|readme typo)\b/i;
  let lowSnrPenalty = 0;
  if (lowSnrRegex.test(fullText) && !deepWaterRegex.test(fullText)) {
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
  const latestActivityMs = calculateLatestActivityTimestamp(issue);
  const freshnessModifier = computeActivityFreshnessModifier(latestActivityMs);

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
