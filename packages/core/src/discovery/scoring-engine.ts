import type { FeasibilityAssessment } from '../contracts/schemas.js';

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

export function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Robust term matcher with word-boundary awareness and canonical alias handling
 * for special language identifiers (C#, C++, .NET, F#, Go, JS).
 */
export function matchesProfileTerm(text: string, term: string): boolean {
  if (!text || !term) return false;
  const t = term.trim().toLowerCase();

  // Special canonical aliases
  if (t === 'c#' || t === 'csharp') {
    return /(?:^|[^\w])(?:c#|csharp)(?:[^\w]|$)/i.test(text);
  }
  if (t === 'c++' || t === 'cpp') {
    return /(?:^|[^\w])(?:c\+\+|cpp)(?:[^\w]|$)/i.test(text);
  }
  if (t === '.net' || t === 'dotnet') {
    return /(?:^|[^\w])(?:\.net|dotnet)(?:[^\w]|$)/i.test(text);
  }
  if (t === 'f#' || t === 'fsharp') {
    return /(?:^|[^\w])(?:f#|fsharp)(?:[^\w]|$)/i.test(text);
  }

  // Standard token word-boundary matching
  const escaped = escapeRegex(t);
  const regex = new RegExp(`\\b${escaped}\\b`, 'i');
  return regex.test(text);
}

/**
 * Builds GitHub Search aliases for a technical term without stripping crucial characters.
 */
export function getSearchAliasQuery(term: string): string {
  const t = term.trim().toLowerCase();
  if (t === 'c#' || t === 'csharp') {
    return '("c#" OR "csharp")';
  }
  if (t === 'c++' || t === 'cpp') {
    return '("c++" OR "cpp")';
  }
  if (t === '.net' || t === 'dotnet') {
    return '(".net" OR "dotnet")';
  }
  if (t === 'f#' || t === 'fsharp') {
    return '("f#" OR "fsharp")';
  }
  // Remove disrupting shell characters but preserve valid alphanumeric and dots
  const clean = term.replace(/[^\w\s.+-]/g, '').trim();
  return clean ? `"${clean}"` : '';
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
 * Calculates freshness modifier based on latest meaningful activity in days.
 */
export function computeActivityFreshnessModifier(activityTimestampMs: number): number {
  const now = Date.now();
  const ageDays = (now - activityTimestampMs) / (1000 * 60 * 60 * 24);

  if (ageDays < 30) return 12;   // Very fresh (< 1 month)
  if (ageDays < 90) return 4;    // Active (< 3 months)
  if (ageDays < 180) return -12; // Moderate stale (> 3 months)
  if (ageDays < 365) return -25; // Stale (> 6 months)
  return -35;                    // Dormant (> 1 year)
}

/**
 * Calculates actionability modifier based on code blocks, reproduction steps, error traces.
 */
export function computeActionabilityModifier(body?: string): number {
  if (!body || body.trim().length < 50) return -10; // Too brief / vague

  let modifier = 0;
  // Code block or stack trace
  if (/```|`[^`]+`|\bat\s+[\w$./]+\s*\(/i.test(body)) modifier += 6;
  // Reproduction steps or expected vs actual
  if (/reproduce|reproduction|steps to|expected|actual behavior|to reproduce/i.test(body)) modifier += 6;
  // Clear error message or assertion
  if (/error:|exception:|assertion|panic:|traceback/i.test(body)) modifier += 4;

  return Math.min(14, modifier);
}

/**
 * Single Source of Truth for Candidate Opportunity Scoring.
 * Used across Scout, MultiSignalHeuristicRanker, and Orchestrator.
 */
export function scoreCandidateIssue(input: ScoreCandidateInput): IssueScoringResult {
  const { profile, issue, feasibility } = input;
  const fullText = `${issue.title} ${issue.body || ''}`;
  const normalizedLabels = (issue.labels || []).map((l) => l.toLowerCase());

  // 1. Profile Keyword & Domain Focus Area Matching (Token/Word-Boundary aware)
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
  const profileKeywordScore = Math.min(100, 50 + totalHits * 12);

  // 2. Domain & Label Heuristics
  let domainMatchScore = 60;
  const matchedLabels: string[] = [];

  if (normalizedLabels.some((l) => /good first issue|starter|easy/i.test(l))) {
    domainMatchScore += 14;
    matchedLabels.push('good-first-issue');
  }
  if (normalizedLabels.some((l) => /help wanted/i.test(l))) {
    domainMatchScore += 9;
    matchedLabels.push('help-wanted');
  }
  if (normalizedLabels.some((l) => /bug|fix|defect|regression/i.test(l)) || /fix|bug|defect|regression/i.test(issue.title)) {
    domainMatchScore += 10;
    matchedLabels.push('bugfix');
  }

  // 3. Repository Popularity & Visibility Signal (Stars)
  let repoPopularityBonus = 0;
  const stars = issue.repoStars ?? 0;
  if (stars >= 5000) {
    repoPopularityBonus = 6;
  } else if (stars >= 50) {
    repoPopularityBonus = 4;
  }

  // 4. Activity Freshness: strictly Math.max across createdAt, updatedAt, and comments
  const latestActivityMs = calculateLatestActivityTimestamp(issue);
  const freshnessModifier = computeActivityFreshnessModifier(latestActivityMs);

  // 5. Actionability Modifier
  const actionabilityModifier = computeActionabilityModifier(issue.body);

  // 6. Feasibility Score (Single Penalty Application)
  const penalty = Math.max(0, feasibility.scorePenalty || 0);
  const feasibilityScore = Math.max(0, 100 - penalty);

  // Weighted Score Formula: feasibility is weighted at 30% without double deduction
  const rawCalculated =
    0.35 * profileKeywordScore +
    0.35 * (domainMatchScore + repoPopularityBonus) +
    0.30 * feasibilityScore +
    freshnessModifier +
    actionabilityModifier;

  const rawScore = Math.max(0, Math.min(100, Math.round(rawCalculated)));
  // P0 Fix: adjustedScore is strictly rawScore, preserving 30% feasibility weighting
  const adjustedScore = rawScore;

  return {
    rawScore,
    adjustedScore,
    breakdown: {
      profileKeywordScore,
      domainMatchScore,
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
): Array<{ item: T; rankScore: number; diversityPenalty: number }> {
  // Stage 1: Pure Relevance Order
  const sorted = [...items].sort((a, b) => b.rawScore - a.rawScore);

  // Stage 2: Diversified Decay
  const repoSeenCount = new Map<string, number>();
  return sorted
    .map((item) => {
      const seen = repoSeenCount.get(item.repoFullName) || 0;
      repoSeenCount.set(item.repoFullName, seen + 1);
      const diversityPenalty = seen * 4;
      const rankScore = Math.max(0, item.rawScore - diversityPenalty);
      return {
        item,
        rankScore,
        diversityPenalty,
      };
    })
    .sort((a, b) => b.rankScore - a.rankScore);
}
