import type { Opportunity, UserProfile } from '../contracts/schemas.js';
import { assessFeasibility, detectSystemCapabilities } from './feasibility.js';
import { GitHubClient } from './github-client.js';
import { qualifyIssue } from './qualification.js';

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
    const joinedLabels = 'label:"good first issue" OR label:"good-first-issue" OR label:"help wanted" OR label:"help-wanted"';
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

    // 1. Fetch comments for Anti-bandwagoning check
    const rawComments = await client.getIssueComments(owner, repo, item.number);
    const comments = rawComments.map((c: any) => ({
      id: c.id,
      body: c.body,
      user: { login: c.user?.login },
      created_at: c.created_at,
    }));

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
    });

    if (!qualification.isQualified) {
      continue; // Filter out disqualified issues (claimed, already PR'd, or active author intent)
    }

    // 3. Run Feasibility Assessment
    const feasibility = assessFeasibility(item.title, item.body || '', labels, capabilities);

    // 4. Calculate Base & Adjusted Match Score
    let matchScore = 75; // Baseline
    const text = `${item.title} ${item.body || ''}`.toLowerCase();
    
    // Tech stack match boost
    for (const tech of profile.techStack) {
      if (text.includes(tech.toLowerCase())) matchScore += 5;
    }
    matchScore = Math.min(100, Math.max(0, matchScore));

    const adjustedScore = Math.max(0, matchScore - feasibility.scorePenalty);

    // Filter by threshold
    if (adjustedScore >= profile.minMatchScore) {
      opportunities.push({
        repoFullName,
        repoStars: item.reactions?.total_count || 0, // Fallback if repo stars not attached directly in search item
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
    }

    if (opportunities.length >= limit) break;
  }

  // Sort descending by adjusted score
  return opportunities.sort((a, b) => b.adjustedScore - a.adjustedScore);
}
