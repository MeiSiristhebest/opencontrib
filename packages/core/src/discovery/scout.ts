import type { Opportunity, UserProfile } from '../contracts/schemas.js';
import { assessFeasibility, detectSystemCapabilities } from './feasibility.js';
import { GitHubClient } from './github-client.js';
import { qualifyIssue } from './qualification.js';
import {
  computeFreshnessModifier,
  computeActionabilityModifier,
} from './ranking.js';

export interface ScoutOptions {
  repo?: string;
  minStars?: number;
  maxStars?: number;
  limit?: number;
  refresh?: boolean;
  githubToken?: string;
}

export async function scoutOpportunities(
  profile: UserProfile,
  options: ScoutOptions = {},
): Promise<Opportunity[]> {
  const client = new GitHubClient({ token: options.githubToken });
  const capabilities = detectSystemCapabilities();
  const limit = options.limit ?? 10;
  const minStars = options.minStars ?? 50;

  let searchQuery = '';
  if (options.repo) {
    searchQuery = `repo:${options.repo} is:issue is:open no:assignee archived:false`;
  } else {
    const joinedLabels =
      'label:"good first issue" OR label:"good-first-issue" OR label:"help wanted" OR label:"help-wanted"';
    const techTerms = profile.techStack.slice(0, 3).join(' OR ');
    searchQuery = `(${joinedLabels}) (${techTerms}) stars:>=${minStars} is:issue is:open no:assignee archived:false`;
  }

  const rawItems = await client.searchIssues(searchQuery, { refresh: options.refresh, maxPages: 2 });
  const opportunities: Opportunity[] = [];

  for (const item of rawItems) {
    if (item.pull_request || item.locked) continue;

    // Parse repository full name
    const repoMatch = item.repository_url.match(/repos\/(.+?)\/(.+)$/);
    const owner = repoMatch ? repoMatch[1] : '';
    const repo = repoMatch ? repoMatch[2] : '';
    const repoFullName = `${owner}/${repo}`;

    // 1. Fetch comments and timeline for Anti-bandwagoning and real linked PR check
    const rawComments = await client.getIssueComments(owner, repo, item.number);
    const comments = rawComments.map((c: any) => ({
      id: c.id,
      body: c.body,
      user: { login: c.user?.login },
      created_at: c.created_at,
    }));

    const existingLinkedPrsCount = await client.getIssueLinkedPrsCount(owner, repo, item.number);

    // 2. Run Qualification Check
    const labels = (item.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name || ''));
    const qualification = qualifyIssue({
      issueNumber: item.number,
      issueTitle: item.title,
      issueBody: item.body || '',
      labels,
      isOpen: item.state === 'open',
      assignees: (item.assignees || []).map((a: any) => a.login),
      createdAt: item.created_at,
      comments,
      existingLinkedPrsCount,
    });

    if (!qualification.isQualified) {
      continue; // Filter out disqualified issues (claimed, already PR'd, or active author intent)
    }

    // 3. Fetch real repository details (stars, default branch)
    const repoDetails = await client.getRepoDetails(owner, repo);
    if (repoDetails.isArchived) continue;

    // 4. Run Feasibility Assessment
    const feasibility = assessFeasibility(item.title, item.body || '', labels, capabilities);

    // 5. Calculate Calibrated Multi-Signal Score
    const text = `${item.title} ${item.body || ''}`.toLowerCase();
    let keywordHits = 0;
    for (const tech of profile.techStack) {
      if (text.includes(tech.toLowerCase())) keywordHits++;
    }
    const profileKeywordScore = Math.min(100, 50 + keywordHits * 12);

    let domainScore = 70;
    if (labels.some((l: string) => /good first issue|starter|easy/i.test(l))) domainScore += 14;
    if (labels.some((l: string) => /help wanted/i.test(l))) domainScore += 9;

    const freshnessModifier = computeFreshnessModifier(item.created_at);
    const actionabilityModifier = computeActionabilityModifier(item.body || '');

    const rawMatch =
      0.35 * profileKeywordScore +
      0.35 * domainScore +
      0.30 * feasibility.feasibilityScore +
      freshnessModifier +
      actionabilityModifier;

    const matchScore = Math.max(0, Math.min(100, Math.round(rawMatch)));
    const adjustedScore = Math.max(0, matchScore - feasibility.scorePenalty);

    // Filter by threshold (for general discovery; targeted repo searches return all candidates ranked by score)
    const threshold = profile.minMatchScore ?? 0;
    if (!options.repo && adjustedScore < threshold) {
      continue;
    }

    opportunities.push({
      repoFullName,
      repoStars: repoDetails.stars,
      issueNumber: item.number,
      title: item.title,
      url: item.html_url,
      body: item.body || '',
      labels,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      matchScore,
      feasibility,
      adjustedScore,
      qualification,
      estimatedWorkload: feasibility.scope === 'docs_only' ? '30m-1h' : '2-4h',
      coreDemand: item.title,
    });

    if (opportunities.length >= limit) break;
  }

  // Sort descending by adjusted score
  return opportunities.sort((a, b) => b.adjustedScore - a.adjustedScore);
}
