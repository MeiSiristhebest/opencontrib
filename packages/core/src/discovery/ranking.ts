import type { FeasibilityAssessment, QualificationResult } from '../contracts/schemas.js';
import { calculateOsFeasibility } from './feasibility.js';
import { qualifyIssue } from './qualification.js';
import {
  applyDiversityReranking,
  computeActivityFreshnessModifier,
  computeActionabilityModifier,
  scoreCandidateIssue,
  type MatchedSignals,
  type ScoreBreakdown,
} from './scoring-engine.js';

export {
  applyDiversityReranking,
  computeActivityFreshnessModifier as computeFreshnessModifier,
  computeActionabilityModifier,
  scoreCandidateIssue,
};

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
  comments?: Array<{ author?: string; body?: string; createdAt?: string }>;
  commentsApiStatus?: 'OK' | 'API_UNAVAILABLE';
  existingLinkedPrsCount?: number;
  timelineApiStatus?: 'OK' | 'API_UNAVAILABLE';
  createdAt: string;
  updatedAt?: string;
}

export interface MultiSignalRankedOpportunity {
  issueNumber: number;
  title: string;
  url: string;
  finalScore: number;
  breakdown: ScoreBreakdown & { qualificationScore: number };
  matchedKeywords: string[];
  matchedSignals: MatchedSignals;
  isQualified: boolean;
  qualificationReason?: string;
  track: 'fast_track' | 'standard_track';
}

// Backward compatible alias
export type HybridRankedOpportunity = MultiSignalRankedOpportunity;

/**
 * MultiSignalHeuristicRanker
 * Calibrated deterministic opportunity ranking incorporating profile match,
 * OS feasibility, community qualification, freshness decay, and 2-stage diversity reranking.
 * Uses `scoreCandidateIssue` as the single source of truth for scoring.
 */
export class MultiSignalHeuristicRanker {
  private profile: DeveloperProfile;

  constructor(profile: DeveloperProfile) {
    this.profile = profile;
  }

  rankIssues(issues: RawIssueInput[], repoFullName: string): MultiSignalRankedOpportunity[] {
    const scoredList: MultiSignalRankedOpportunity[] = [];

    for (const issue of issues) {
      const labelNames = issue.labels.map((l) => l.name);

      // 1. Feasibility Evaluation
      const osFeasibility = calculateOsFeasibility(
        {
          os: this.profile.os,
          hasDocker: this.profile.hasDocker,
          hasWsl: this.profile.hasWsl || this.profile.os === 'wsl2',
        },
        labelNames,
        `${issue.title} ${issue.body}`,
      );

      const feasibility: FeasibilityAssessment = {
        level: osFeasibility.feasibilityScore >= 80 ? 'fully_feasible' : 'needs_investigation',
        scorePenalty: osFeasibility.penalty || 0,
        scope: 'runtime_bug',
        detectedRisks: [],
        missingCapabilities: [],
        mitigations: [],
        rationale: osFeasibility.reason || 'Standard environment compatible',
      };

      // 2. Authoritative Qualification (Single Source of Truth)
      const qualification = qualifyIssue({
        issueNumber: issue.number,
        issueTitle: issue.title,
        issueBody: issue.body,
        labels: labelNames,
        isOpen: true,
        assignees: issue.assignee ? [issue.assignee] : [],
        createdAt: issue.createdAt,
        comments: ((issue.comments as any) || []).map((c: any, idx: number) => ({
          id: idx,
          body: c.body,
          user: { login: c.author },
          created_at: c.createdAt || issue.createdAt,
        })),
        commentsApiStatus: issue.commentsApiStatus,
        existingLinkedPrsCount: issue.existingLinkedPrsCount,
        timelineApiStatus: issue.timelineApiStatus,
      });

      // 3. Score using Single Source of Truth
      const scoringResult = scoreCandidateIssue({
        profile: {
          techStack: this.profile.techStack,
          focusAreas: this.profile.focusAreas,
          proficiency: this.profile.proficiency,
        },
        issue: {
          title: issue.title,
          body: issue.body,
          labels: labelNames,
          createdAt: issue.createdAt,
          updatedAt: issue.updatedAt,
        },
        feasibility,
      });

      const finalScore = qualification.isQualified ? scoringResult.adjustedScore : 0;

      scoredList.push({
        issueNumber: issue.number,
        title: issue.title,
        url: issue.htmlUrl,
        finalScore,
        breakdown: {
          ...scoringResult.breakdown,
          qualificationScore: qualification.isQualified ? 100 : 0,
        },
        matchedKeywords: [
          ...scoringResult.matchedSignals.techStack,
          ...scoringResult.matchedSignals.focusAreas,
        ],
        matchedSignals: scoringResult.matchedSignals,
        isQualified: qualification.isQualified,
        qualificationReason: qualification.disqualifyReason,
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
  rankOpportunities(
    opportunities: Array<{
      issueNumber: number;
      title: string;
      body?: string;
      repoFullName: string;
      repoStars?: number;
      feasibility?: any;
      createdAt?: string;
      updatedAt?: string;
      labels?: string[];
      [key: string]: any;
    }>,
  ): Array<{ opportunity: any; finalScore: number }> {
    const rawScored = opportunities.map((opp) => {
      const scoring = scoreCandidateIssue({
        profile: {
          techStack: this.profile.techStack,
          focusAreas: this.profile.focusAreas,
          proficiency: this.profile.proficiency,
        },
        issue: {
          title: opp.title,
          body: opp.body,
          labels: opp.labels,
          createdAt: opp.createdAt || new Date().toISOString(),
          updatedAt: opp.updatedAt,
          repoStars: opp.repoStars,
        },
        feasibility: opp.feasibility || { scorePenalty: 0 },
      });

      return {
        opportunity: opp,
        repoFullName: opp.repoFullName,
        rawScore: scoring.adjustedScore,
      };
    });

    const reranked = applyDiversityReranking(rawScored);
    return reranked.map(({ item, finalScore }) => ({
      opportunity: item.opportunity,
      finalScore,
    }));
  }
}

export const MultiSignalRanker = MultiSignalHeuristicRanker;
export const HybridIssueRanker = MultiSignalHeuristicRanker;
