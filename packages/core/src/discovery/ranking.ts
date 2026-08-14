import { calculateOsFeasibility } from './feasibility.js';
import { qualifyIssue } from './qualification.js';

export interface DeveloperProfile {
  techStack: string[];
  focusAreas: string[];
  proficiency: 'beginner' | 'intermediate' | 'expert';
  os: 'windows' | 'linux' | 'macos' | 'wsl2';
  hasDocker: boolean;
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
  };
  matchedKeywords: string[];
  isQualified: boolean;
  qualificationReason: string;
  track: 'FAST_TRACK' | 'STANDARD_TRACK';
}

export class HybridIssueRanker {
  private profile: DeveloperProfile;

  constructor(profile: DeveloperProfile) {
    this.profile = profile;
  }

  rankIssues(issues: RawIssueInput[], repoFullName: string): HybridRankedOpportunity[] {
    const results: HybridRankedOpportunity[] = [];

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
          hasWsl: this.profile.os === 'wsl2',
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

      // 4. Hybrid Weighted Scoring Formula
      let domainMatchScore = 70;
      if (issue.labels.some((l) => /good first issue|help wanted|easy/i.test(l.name))) {
        domainMatchScore += 15;
      }
      if (issue.labels.some((l) => /bug|fix|defect/i.test(l.name))) {
        domainMatchScore += 10;
      }

      const qualificationScore = qualification.isQualified ? 100 : 0;

      const finalScore = qualification.isQualified
        ? Math.round(
            0.35 * profileKeywordScore +
              0.35 * domainMatchScore +
              0.30 * feasibility.feasibilityScore,
          )
        : 0;

      results.push({
        issueNumber: issue.number,
        title: issue.title,
        url: issue.htmlUrl,
        finalScore,
        breakdown: {
          domainMatchScore,
          profileKeywordScore,
          feasibilityScore: feasibility.feasibilityScore,
          qualificationScore,
        },
        matchedKeywords,
        isQualified: qualification.isQualified,
        qualificationReason: qualification.reason,
        track: qualification.track,
      });
    }

    return results.sort((a, b) => b.finalScore - a.finalScore);
  }

  rankOpportunities(opportunities: Array<{
    issueNumber: number;
    title: string;
    body?: string;
    repoFullName: string;
    matchScore: number;
    labels?: string[];
    [key: string]: any;
  }>): Array<{ opportunity: any; finalScore: number }> {
    return opportunities
      .map((opp) => {
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
            hasWsl: this.profile.os === 'wsl2',
          },
          opp.labels || [],
          fullText,
        );

        const domainMatchScore = opp.matchScore || 80;
        const finalScore = Math.round(
          0.35 * profileKeywordScore + 0.35 * domainMatchScore + 0.30 * feasibility.feasibilityScore,
        );

        return {
          opportunity: opp,
          finalScore,
        };
      })
      .sort((a, b) => b.finalScore - a.finalScore);
  }
}
