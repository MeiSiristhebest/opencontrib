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

export interface RankOpportunitySignalsInput {
  issue: {
    number?: number;
    title: string;
    body?: string;
    labels?: Array<string | { name: string }>;
    state?: string;
    isOpen?: boolean;
    createdAt?: string;
    created_at?: string;
    updatedAt?: string;
    updated_at?: string;
    commentsCount?: number;
    comments_count?: number;
    assignees?: Array<string | { login: string }>;
  };
  repository: {
    fullName: string;
    stars?: number;
    primaryLanguage?: string;
    openIssuesCount?: number;
  };
  developerProfile?: {
    techStack?: string[];
    focusAreas?: string[];
    proficiency?: 'beginner' | 'intermediate' | 'expert' | 'advanced';
    minMatchScore?: number;
  };
  environment?: {
    os?: 'windows' | 'linux' | 'macos' | 'wsl2';
    hasDocker?: boolean;
    hasWsl?: boolean;
  };
}

export interface OpportunitySignalsResult {
  score: number;
  signals: {
    skillMatch: number;
    environmentFeasibility: number;
    issueActionability: number;
    maintenanceRisk: number;
    isAuthorClaimed: boolean;
    isQualified: boolean;
  };
  reasons: string[];
  breakdown: {
    profileKeywordScore: number;
    domainMatchScore: number;
    feasibilityScore: number;
    freshnessModifier: number;
    actionabilityModifier: number;
    repoPopularityBonus: number;
  };
}

/**
 * Deterministic multi-dimensional signal extractor for candidate opportunities.
 * Returns objective probabilities and signals without prescribing autonomous decisions.
 */
export function rankOpportunitySignals(input: RankOpportunitySignalsInput): OpportunitySignalsResult {
  const profile: UserProfile = {
    techStack: input.developerProfile?.techStack ?? ['typescript', 'javascript'],
    focusAreas: input.developerProfile?.focusAreas ?? ['bugfix', 'testing', 'docs'],
    proficiency: input.developerProfile?.proficiency ?? 'intermediate',
    minMatchScore: input.developerProfile?.minMatchScore ?? 60,
  };

  const envCapabilities = input.environment
    ? {
        os: input.environment.os ?? (process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux'),
        hasDocker: input.environment.hasDocker ?? false,
        hasWsl: input.environment.hasWsl ?? false,
      }
    : {
        os: process.platform === 'win32' ? ('windows' as const) : process.platform === 'darwin' ? ('macos' as const) : ('linux' as const),
        hasDocker: false,
        hasWsl: false,
      };

  const rawLabels = input.issue.labels || [];
  const normalizedLabels = rawLabels.map((l) => (typeof l === 'string' ? l.toLowerCase() : (l.name || '').toLowerCase()));
  const text = `${input.issue.title} ${input.issue.body || ''}`.toLowerCase();

  // 1. Feasibility calculation
  const osFeasibility = calculateOsFeasibility(envCapabilities, normalizedLabels, text);
  const feasibility: FeasibilityAssessment = {
    level: osFeasibility.feasibilityScore >= 80 ? 'fully_feasible' : 'needs_investigation',
    scorePenalty: osFeasibility.penalty || 0,
    scope: 'runtime_bug',
    detectedRisks: [],
    missingCapabilities: [],
    mitigations: [],
    rationale: osFeasibility.reason || 'Standard environment compatible',
  };

  // 2. Qualification check
  const isOpen = input.issue.isOpen ?? (input.issue.state === 'open' || !input.issue.state);
  const createdAt = input.issue.createdAt || input.issue.created_at || new Date().toISOString();
  const assignees = (input.issue.assignees || []).map((a) => (typeof a === 'string' ? a : a?.login || '')).filter(Boolean);

  const qualification = qualifyIssue({
    issueNumber: input.issue.number ?? 0,
    issueTitle: input.issue.title,
    issueBody: input.issue.body || '',
    labels: normalizedLabels,
    isOpen,
    assignees,
    createdAt,
    comments: [],
  });

  // 3. Scoring breakdown calculation
  const scoringResult = scoreCandidateIssue({
    profile,
    issue: {
      title: input.issue.title,
      body: input.issue.body,
      labels: normalizedLabels,
      createdAt,
      updatedAt: input.issue.updatedAt || input.issue.updated_at,
      repoStars: input.repository.stars,
    },
    feasibility,
  });

  // 4. Transform into normalized 0.0 ~ 1.0 probability signals
  const skillMatch = Math.min(1.0, Math.max(0.0, scoringResult.breakdown.profileKeywordScore / 100));
  const environmentFeasibility = Math.min(1.0, Math.max(0.0, scoringResult.breakdown.feasibilityScore / 100));
  const issueActionability = Math.min(1.0, Math.max(0.0, (50 + scoringResult.breakdown.actionabilityModifier + scoringResult.breakdown.freshnessModifier) / 60));
  const maintenanceRisk = qualification.isQualified ? 0.1 : 0.85;


  const reasons: string[] = [];
  if (scoringResult.matchedSignals.techStack.length > 0) {
    reasons.push(`Matched technology keywords: ${scoringResult.matchedSignals.techStack.join(', ')}`);
  }
  if (scoringResult.matchedSignals.focusAreas.length > 0) {
    reasons.push(`Matched focus areas: ${scoringResult.matchedSignals.focusAreas.join(', ')}`);
  }
  if (environmentFeasibility >= 0.9) {
    reasons.push('High execution feasibility in current environment');
  } else {
    reasons.push(`Environment feasibility constraint: ${osFeasibility.reason || 'Compatibility inspection recommended'}`);
  }
  if (!qualification.isQualified) {
    reasons.push(`Disqualification flag: ${qualification.disqualificationReason || 'Blocked by qualification rules'}`);
  }

  return {
    score: scoringResult.adjustedScore,
    signals: {
      skillMatch,
      environmentFeasibility,
      issueActionability,
      maintenanceRisk,
      isAuthorClaimed: qualification.disqualificationReason?.includes('Author-first-right') ?? false,
      isQualified: qualification.isQualified,
    },
    reasons,
    breakdown: scoringResult.breakdown,
  };
}

