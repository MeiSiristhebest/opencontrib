import type { FeasibilityAssessment, UserProfile } from '../contracts/schemas.js';

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
  repoQualityBonus: number;
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

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Calculates freshness modifier based on latest meaningful activity in days.
 * Prefers max(updated_at, latest_comment_at, created_at) over pure creation time.
 */
export function computeActivityFreshnessModifier(activityDateStr: string): number {
  try {
    const activityTime = new Date(activityDateStr).getTime();
    if (isNaN(activityTime)) return 0;
    const now = Date.now();
    const ageDays = (now - activityTime) / (1000 * 60 * 60 * 24);

    if (ageDays < 30) return 12;   // Very fresh (< 1 month)
    if (ageDays < 90) return 4;    // Active (< 3 months)
    if (ageDays < 180) return -12; // Moderate stale (> 3 months)
    if (ageDays < 365) return -25; // Stale (> 6 months)
    return -35;                    // Dormant (> 1 year)
  } catch {
    return 0;
  }
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
 * Used by Scout, MultiSignalHeuristicRanker, and Orchestrator.
 */
export function scoreCandidateIssue(input: ScoreCandidateInput): IssueScoringResult {
  const { profile, issue, feasibility } = input;
  const fullText = `${issue.title} ${issue.body || ''}`.toLowerCase();
  const normalizedLabels = (issue.labels || []).map((l) => l.toLowerCase());

  // 1. Tokenized / Word-Boundary Keyword Matching
  const matchedTech: string[] = [];
  for (const tech of profile.techStack) {
    if (!tech) continue;
    const escaped = escapeRegex(tech.toLowerCase());
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(fullText)) {
      matchedTech.push(tech.toLowerCase());
    }
  }

  const matchedAreas: string[] = [];
  for (const area of profile.focusAreas) {
    if (!area) continue;
    const escaped = escapeRegex(area.toLowerCase());
    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
    if (regex.test(fullText)) {
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

  // 3. Repository Quality & Maintenance Signal
  let repoQualityBonus = 0;
  const stars = issue.repoStars ?? 0;
  if (stars >= 5000) {
    repoQualityBonus = 6;
  } else if (stars >= 50) {
    repoQualityBonus = 4;
  }

  // 4. Activity Freshness (Latest meaningful activity)
  const activityDate = issue.latestCommentAt || issue.updatedAt || issue.createdAt;
  const freshnessModifier = computeActivityFreshnessModifier(activityDate);

  // 5. Actionability Modifier
  const actionabilityModifier = computeActionabilityModifier(issue.body);

  // 6. Feasibility Score
  const feasibilityScore = Math.max(0, 100 - (feasibility.scorePenalty || 0));

  // Weighted Score Formula
  const rawCalculated =
    0.35 * profileKeywordScore +
    0.35 * (domainMatchScore + repoQualityBonus) +
    0.30 * feasibilityScore +
    freshnessModifier +
    actionabilityModifier;

  const rawScore = Math.max(0, Math.min(100, Math.round(rawCalculated)));
  const adjustedScore = Math.max(0, rawScore - (feasibility.scorePenalty || 0));

  return {
    rawScore,
    adjustedScore,
    breakdown: {
      profileKeywordScore,
      domainMatchScore,
      feasibilityScore,
      freshnessModifier,
      actionabilityModifier,
      repoQualityBonus,
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
 * Stage 2: Apply per-repo appearance frequency decay to prevent repo monopoly in Top N.
 */
export function applyDiversityReranking<T extends { repoFullName: string; rawScore: number }>(
  items: T[],
): Array<{ item: T; finalScore: number }> {
  // Stage 1: Pure Relevance Order
  const sorted = [...items].sort((a, b) => b.rawScore - a.rawScore);

  // Stage 2: Diversified Decay
  const repoSeenCount = new Map<string, number>();
  return sorted
    .map((item) => {
      const seen = repoSeenCount.get(item.repoFullName) || 0;
      repoSeenCount.set(item.repoFullName, seen + 1);
      const diversityPenalty = seen * 4;
      const finalScore = Math.max(0, item.rawScore - diversityPenalty);
      return {
        item,
        finalScore,
      };
    })
    .sort((a, b) => b.finalScore - a.finalScore);
}
