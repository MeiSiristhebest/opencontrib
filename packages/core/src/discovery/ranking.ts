import type {
  FeasibilityAssessment,
  Opportunity,
  QualificationResult,
  UserProfile,
} from '../contracts/schemas.js';
import { calculateOsFeasibility } from './feasibility.js';
import { qualifyIssue } from './qualification.js';
import {
  applyDiversityReranking,
  scoreCandidateIssue,
} from './scoring-engine.js';

export interface MultiSignalRankedOpportunity {
  issue: any;
  issueNumber: number;
  finalScore: number;
  rawScore: number;
  adjustedScore: number;
  rankScore: number;
  diversityPenalty: number;
  feasibility: FeasibilityAssessment;
  qualification: QualificationResult;
  matchedKeywords: string[];
  matchedSignals: {
    techStack: string[];
    focusAreas: string[];
    labels: string[];
    freshnessModifier: number;
    actionabilityModifier: number;
  };
  opportunity?: Opportunity;
}

export class MultiSignalHeuristicRanker {
  private profile: UserProfile;
  private envCapabilities: { os: 'windows' | 'linux' | 'macos' | 'wsl2'; hasDocker: boolean; hasWsl: boolean };

  constructor(
    profile: UserProfile,
    envCapabilities?: { os: 'windows' | 'linux' | 'macos' | 'wsl2'; hasDocker: boolean; hasWsl: boolean },
  ) {
    this.profile = profile;
    this.envCapabilities = envCapabilities || {
      os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
      hasDocker: false,
      hasWsl: false,
    };
  }

  /**
   * Authoritative candidate issue ranking.
   * Delegates scoring to single-source scoreCandidateIssue() and applies 2-stage diversity reranking.
   */
  rankIssues(issues: any[], repoFullNameFallback?: string): MultiSignalRankedOpportunity[] {
    const scoredList: Array<{
      issue: any;
      repoFullName: string;
      rawScore: number;
      adjustedScore: number;
      feasibility: FeasibilityAssessment;
      qualification: QualificationResult;
      matchedSignals: any;
    }> = [];

    for (const issue of issues) {
      const labels = (issue.labels || []).map((l: any) =>
        typeof l === 'string' ? l.toLowerCase() : (l.name || '').toLowerCase(),
      );
      const text = `${issue.title} ${issue.body || ''}`.toLowerCase();

      // 1. Environment & OS Feasibility Assessment
      const osFeasibility = calculateOsFeasibility(
        this.envCapabilities,
        labels,
        text,
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

      // 2. Strict Qualification (Requires explicit open state, rejects missing state assumptions)
      const isOpen = issue.state === 'open' || issue.isOpen === true;
      const createdAt = issue.created_at || issue.createdAt;
      if (!createdAt) {
        continue; // Discard issues lacking creation timestamps (evidence-first requirement)
      }

      const assignees = (issue.assignees || (issue.assignee ? [issue.assignee] : []))
        .map((a: any) => (typeof a === 'string' ? a : a?.login || ''))
        .filter(Boolean);

      const qualification = qualifyIssue({
        issueNumber: issue.number ?? issue.issueNumber ?? 0,
        issueTitle: issue.title,
        issueBody: issue.body || '',
        labels,
        isOpen,
        assignees,
        createdAt,
        authorLogin: issue.user?.login || issue.authorLogin,
        comments: (issue.commentsData || []).map((c: any) => ({
          id: c.id,
          body: c.body,
          user: { login: c.user?.login },
          created_at: c.created_at || c.createdAt,
        })),
        existingLinkedPrsCount: issue.existingLinkedPrsCount ?? 0,
      });

      if (!qualification.isQualified) {
        continue;
      }

      // 3. Extract repository full name
      const repoFullName =
        issue.repoFullName ||
        repoFullNameFallback ||
        (issue.repository_url ? issue.repository_url.replace(/.*repos\//, '') : 'unknown/repo');

      // 4. Single Source of Truth Candidate Scoring
      const scoringResult = scoreCandidateIssue({
        profile: {
          techStack: this.profile.techStack,
          focusAreas: this.profile.focusAreas || [],
          proficiency: this.profile.proficiency,
          minMatchScore: this.profile.minMatchScore,
        },
        issue: {
          title: issue.title,
          body: issue.body || '',
          labels,
          createdAt,
          updatedAt: issue.updated_at || issue.updatedAt,
          latestCommentAt: issue.latestCommentAt,
          commentDates: (issue.commentsData || []).map((c: any) => c.created_at || c.createdAt),
          repoStars: issue.repoStars || issue.stargazers_count || 0,
        },
        feasibility,
      });

      scoredList.push({
        issue,
        repoFullName,
        rawScore: scoringResult.rawScore,
        adjustedScore: scoringResult.adjustedScore,
        feasibility,
        qualification,
        matchedSignals: scoringResult.matchedSignals,
      });
    }

    // 5. Unified 2-Stage Diversity Reranking Pipeline
    const reranked = applyDiversityReranking(scoredList);

    return reranked.map(({ item, rankScore, diversityPenalty }) => ({
      issue: item.issue,
      issueNumber: item.issue.number ?? item.issue.issueNumber ?? 0,
      finalScore: rankScore,
      rawScore: item.rawScore,
      adjustedScore: item.adjustedScore,
      rankScore,
      diversityPenalty,
      feasibility: item.feasibility,
      qualification: item.qualification,
      matchedKeywords: [...item.matchedSignals.techStack, ...item.matchedSignals.focusAreas],
      matchedSignals: item.matchedSignals,
    }));
  }

  /**
   * Reranks structured Opportunity objects using the exact same diversity pipeline.
   */
  rankOpportunities(opportunities: Opportunity[]): Opportunity[] {
    const reranked = applyDiversityReranking(
      opportunities.map((opp) => ({
        ...opp,
        rawScore: opp.adjustedScore,
      })),
    );

    return reranked.map(({ item, rankScore, diversityPenalty }) => ({
      ...item,
      opportunity: item,
      finalScore: rankScore,
      diversityPenalty,
      rankScore,
    }));
  }
}

// Backward-compatible alias exports
export const HybridIssueRanker = MultiSignalHeuristicRanker;
export type HybridRankedOpportunity = MultiSignalRankedOpportunity;
