import { calculateOsFeasibility } from './feasibility.js';
import { qualifyIssue } from './qualification.js';

export interface DeveloperProfile {
  techStack: string[];
  focusAreas: string[];
  proficiency: 'beginner' | 'intermediate' | 'expert';
  os: 'windows' | 'linux' | 'macos' | 'wsl2';
  hasDocker: boolean;
  hasWsl?: boolean;
}

export interface RawIssueInput {
  number: number;
  title: string;
  body: string;
  htmlUrl: string;
  labels: Array<{ name: string }>;
  assignee: any;
  commentsCount: number;
  comments?: Array<{ author: string; body: string; createdAt: string }>;
  existingLinkedPrsCount?: number;
  createdAt: string;
}

export interface HybridRankedOpportunity {
  issueNumber: number;
  title: string;
  url: string;
  finalScore: number;
  breakdown: {
    domainMatchScore: number;
    profileKeywordScore: number;
    feasibilityScore: number;
    qualificationScore: number;
    freshnessModifier: number;
    actionabilityModifier: number;
  };
  matchedKeywords: string[];
  isQualified: boolean;
  qualificationReason: string;
  track: 'FAST_TRACK' | 'STANDARD_TRACK';
}

/**
 * Calculates freshness modifier based on issue age in days.
 */
export function computeFreshnessModifier(createdAtStr: string): number {
  try {
    const created = new Date(createdAtStr).getTime();
    const now = Date.now();
    const ageDays = (now - created) / (1000 * 60 * 60 * 24);

    if (ageDays < 30) return 12; // Fresh (<1 mo)
    if (ageDays < 90) return 4;
    if (ageDays < 180) return -12; // Stale (>3 mo)
    if (ageDays < 365) return -25; // Stale (>6 mo)
    return -35; // Stale (>1 yr)
  } catch {
    return 0;
  }
}

/**
 * Calculates actionable body score based on presence of reproduction steps, code blocks, stack traces.
 */
export function computeActionabilityModifier(body: string): number {
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
 * MultiSignalHeuristicRanker
 * Calibrated deterministic opportunity ranking incorporating profile match,
 * OS feasibility, community qualification, freshness decay, and 2-stage diversity reranking.
 */
export class MultiSignalHeuristicRanker {
  private profile: DeveloperProfile;

  constructor(profile: DeveloperProfile) {
    this.profile = profile;
  }

  rankIssues(issues: RawIssueInput[], repoFullName: string): HybridRankedOpportunity[] {
    const scoredList: HybridRankedOpportunity[] = [];

    for (const issue of issues) {
      const fullText = `${issue.title} ${issue.body}`.toLowerCase();

      // 1. Profile Keyword Matching
      const matchedKeywords: string[] = [];
      let keywordHits = 0;
      for (const tech of this.profile.techStack) {
        const t = tech.toLowerCase();
        if (fullText.includes(t)) {
          matchedKeywords.push(t);
          keywordHits++;
        }
      }
      for (const area of this.profile.focusAreas) {
        const a = area.toLowerCase();
        if (fullText.includes(a)) {
          matchedKeywords.push(a);
          keywordHits++;
        }
      }
      const profileKeywordScore = Math.min(100, 50 + keywordHits * 12);

      // 2. Feasibility Evaluation
      const feasibility = calculateOsFeasibility(
        {
          os: this.profile.os,
          hasDocker: this.profile.hasDocker,
          hasWsl: this.profile.hasWsl || this.profile.os === 'wsl2',
        },
        issue.labels.map((l) => l.name),
        fullText,
      );

      // 3. Qualification Check with Real Linked PRs & Timeline analysis
      const qualification = qualifyIssue({
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body,
        labels: issue.labels.map((l) => l.name),
        isOpen: true,
        assignees: issue.assignee ? [issue.assignee] : [],
        createdAt: issue.createdAt,
        comments: (issue.comments as any) || [],
        existingLinkedPrsCount: issue.existingLinkedPrsCount ?? 0,
      });

      // Disqualifying labels
      if (issue.labels.some((l) => /wontfix|duplicate|invalid|stale/i.test(l.name))) {
        qualification.isQualified = false;
        qualification.reason = 'Disqualified due to blocking label (wontfix/duplicate/invalid)';
      }

      // 4. Domain & Structured Heuristics
      let domainMatchScore = 70;
      if (issue.labels.some((l) => /good first issue|starter|easy/i.test(l.name))) {
        domainMatchScore += 14;
      }
      if (issue.labels.some((l) => /help wanted/i.test(l.name))) {
        domainMatchScore += 9;
      }
      if (issue.labels.some((l) => /bug|fix|defect|regression/i.test(l.name))) {
        domainMatchScore += 10;
      }

      // 5. Freshness & Actionability Modifiers
      const freshnessModifier = computeFreshnessModifier(issue.createdAt);
      const actionabilityModifier = computeActionabilityModifier(issue.body);

      const qualificationScore = qualification.isQualified ? 100 : 0;

      const rawBase =
        0.35 * profileKeywordScore +
        0.35 * domainMatchScore +
        0.30 * feasibility.feasibilityScore +
        freshnessModifier +
        actionabilityModifier;

      const finalScore = qualification.isQualified
        ? Math.max(0, Math.min(100, Math.round(rawBase)))
        : 0;

      scoredList.push({
        issueNumber: issue.number,
        title: issue.title,
        url: issue.htmlUrl,
        finalScore,
        breakdown: {
          domainMatchScore,
          profileKeywordScore,
          feasibilityScore: feasibility.feasibilityScore,
          qualificationScore,
          freshnessModifier,
          actionabilityModifier,
        },
        matchedKeywords,
        isQualified: qualification.isQualified,
        qualificationReason: qualification.reason,
        track: qualification.track,
      });
    }

    return scoredList.sort((a, b) => b.finalScore - a.finalScore);
  }

  /**
   * 2-Stage Opportunity Ranking & Diversified Reranking
   * Stage 1: Computes raw multi-signal score without position bias.
   * Stage 2: Applies diversity reranking based on repository distribution.
   */
  rankOpportunities(opportunities: Array<{
    issueNumber: number;
    title: string;
    body?: string;
    repoFullName: string;
    matchScore: number;
    createdAt?: string;
    labels?: string[];
    [key: string]: any;
  }>): Array<{ opportunity: any; finalScore: number }> {
    // Stage 1: Pure Relevance Scoring
    const rawScored = opportunities.map((opp) => {
      const fullText = `${opp.title} ${opp.body || ''}`.toLowerCase();
      let keywordHits = 0;
      for (const tech of this.profile.techStack) {
        if (fullText.includes(tech.toLowerCase())) keywordHits++;
      }
      for (const area of this.profile.focusAreas) {
        if (fullText.includes(area.toLowerCase())) keywordHits++;
      }
      const profileKeywordScore = Math.min(100, 50 + keywordHits * 12);
      const feasibility = calculateOsFeasibility(
        {
          os: this.profile.os,
          hasDocker: this.profile.hasDocker,
          hasWsl: this.profile.hasWsl || this.profile.os === 'wsl2',
        },
        opp.labels || [],
        fullText,
      );

      let domainMatchScore = opp.matchScore || 80;
      if (opp.labels && opp.labels.some((l: string) => /good first issue|starter/i.test(l))) {
        domainMatchScore += 14;
      }

      const freshness = opp.createdAt ? computeFreshnessModifier(opp.createdAt) : 5;
      const actionability = computeActionabilityModifier(opp.body || '');

      const rawScore =
        0.35 * profileKeywordScore +
        0.35 * domainMatchScore +
        0.30 * feasibility.feasibilityScore +
        freshness +
        actionability;

      return {
        opportunity: opp,
        rawScore: Math.max(0, Math.min(100, Math.round(rawScore))),
      };
    });

    // Sort by raw score descending
    rawScored.sort((a, b) => b.rawScore - a.rawScore);

    // Stage 2: Diversified Reranking
    const repoSeenCount = new Map<string, number>();
    return rawScored
      .map(({ opportunity, rawScore }) => {
        const seen = repoSeenCount.get(opportunity.repoFullName) || 0;
        repoSeenCount.set(opportunity.repoFullName, seen + 1);
        const diversityPenalty = seen * 4;
        const finalScore = Math.max(0, rawScore - diversityPenalty);
        return {
          opportunity,
          finalScore,
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore);
  }
}

export const HybridIssueRanker = MultiSignalHeuristicRanker;
