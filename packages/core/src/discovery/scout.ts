import type { Opportunity, UserProfile } from '../contracts/schemas.js';
import { assessFeasibility, detectSystemCapabilities } from './feasibility.js';
import { GitHubClient } from './github-client.js';
import { qualifyIssue } from './qualification.js';
import {
  applyDiversityReranking,
  scoreCandidateIssue,
} from './scoring-engine.js';

export interface ScoutOptions {
  repo?: string;
  minStars?: number;
  maxStars?: number;
  limit?: number;
  refresh?: boolean;
  githubToken?: string;
}

function sanitizeSearchTerm(term: string): string {
  // Remove special characters that disrupt GitHub search queries
  return term.replace(/[^\w\s.+-]/g, '').trim();
}

/**
 * Scout Engine (Two-Tier Discovery + Unified Scoring + Diversity Reranking)
 * Orchestrates GitHub discovery, cheap pre-ranking, deep community enrichment,
 * single source of truth scoring, and 2-stage diversity reranking.
 */
export async function scoutOpportunities(
  profile: UserProfile,
  options: ScoutOptions = {},
): Promise<Opportunity[]> {
  const client = new GitHubClient({ token: options.githubToken });
  const capabilities = detectSystemCapabilities();
  const limit = options.limit ?? 10;
  const minStars = options.minStars ?? 50;
  const maxStars = options.maxStars;
  const discoveryMode = options.repo ? 'targeted_repo' : 'global_discovery';

  // 1. Build Query (Safe terms, minStars/maxStars compliance)
  let searchQuery = '';
  if (options.repo) {
    searchQuery = `repo:${options.repo} is:issue is:open no:assignee archived:false`;
  } else {
    const joinedLabels =
      'label:"good first issue" OR label:"good-first-issue" OR label:"help wanted" OR label:"help-wanted"';

    const validTechTerms = (profile.techStack || [])
      .map(sanitizeSearchTerm)
      .filter((t) => t.length > 0)
      .slice(0, 5);

    const techQuery = validTechTerms.length > 0 ? `(${validTechTerms.join(' OR ')})` : '';
    const starsQuery = maxStars !== undefined ? `stars:${minStars}..${maxStars}` : `stars:>=${minStars}`;

    searchQuery = [joinedLabels, techQuery, starsQuery, 'is:issue is:open no:assignee archived:false']
      .filter(Boolean)
      .join(' ');
  }

  const rawItems = await client.searchIssues(searchQuery, { refresh: options.refresh, maxPages: 2 });
  if (rawItems.length === 0) {
    return [];
  }

  // 2. Tier 1: Cheap Local Pre-Filtering
  // Score basic relevance locally without burning API calls; keep top 20 candidates for deep inspection
  const preFiltered = rawItems
    .filter((item) => !item.pull_request && !item.locked)
    .map((item) => {
      const labels = (item.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name || ''));
      const text = `${item.title} ${item.body || ''}`.toLowerCase();

      let keywordHits = 0;
      for (const tech of profile.techStack) {
        if (text.includes(tech.toLowerCase())) keywordHits++;
      }
      for (const area of profile.focusAreas || []) {
        if (text.includes(area.toLowerCase())) keywordHits++;
      }

      const cheapRelevance = keywordHits * 10 + (labels.some((l: string) => /good first issue|starter/i.test(l)) ? 15 : 0);
      return { item, labels, cheapRelevance };
    })
    .sort((a, b) => b.cheapRelevance - a.cheapRelevance)
    .slice(0, 20);

  // 3. Tier 2: Deep Enrichment (Batch repo details & paged timeline/comments)
  const repoDetailsCache = new Map<string, any>();
  const candidates: Opportunity[] = [];

  for (const { item, labels } of preFiltered) {
    // Parse repository full name
    const repoMatch = item.repository_url.match(/repos\/(.+?)\/(.+)$/);
    const owner = repoMatch ? repoMatch[1] : '';
    const repo = repoMatch ? repoMatch[2] : '';
    const repoFullName = `${owner}/${repo}`;

    // Batch get repo details
    let repoDetails = repoDetailsCache.get(repoFullName);
    if (!repoDetails) {
      repoDetails = await client.getRepoDetails(owner, repo);
      repoDetailsCache.set(repoFullName, repoDetails);
    }
    if (repoDetails.isArchived) continue;

    // Fetch paged comments and linked PRs with tri-state status
    const commentsResult = await client.getIssueComments(owner, repo, item.number);
    const timelineResult = await client.getIssueLinkedPrsCount(owner, repo, item.number);

    const comments = commentsResult.data.map((c: any) => ({
      id: c.id,
      body: c.body,
      user: { login: c.user?.login },
      created_at: c.created_at,
    }));

    // Authoritative Qualification Check
    const qualification = qualifyIssue({
      issueNumber: item.number,
      issueTitle: item.title,
      issueBody: item.body || '',
      labels,
      isOpen: item.state === 'open',
      assignees: (item.assignees || []).map((a: any) => a.login),
      createdAt: item.created_at,
      authorLogin: item.user?.login,
      comments,
      commentsApiStatus: commentsResult.status,
      existingLinkedPrsCount: timelineResult.data,
      timelineApiStatus: timelineResult.status,
    });

    if (!qualification.isQualified) {
      continue; // Filter out disqualified issues
    }

    // Feasibility Assessment
    const feasibility = assessFeasibility(item.title, item.body || '', labels, capabilities);

    // Single Source of Truth Scoring
    const scoring = scoreCandidateIssue({
      profile: {
        techStack: profile.techStack,
        focusAreas: profile.focusAreas || [],
        proficiency: profile.proficiency,
        minMatchScore: profile.minMatchScore,
      },
      issue: {
        title: item.title,
        body: item.body || '',
        labels,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
        latestCommentAt: comments.length > 0 ? comments[comments.length - 1].created_at : undefined,
        repoStars: repoDetails.stars,
      },
      feasibility,
    });

    candidates.push({
      repoFullName,
      repoStars: repoDetails.stars,
      issueNumber: item.number,
      title: item.title,
      url: item.html_url,
      body: item.body || '',
      labels,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      matchScore: scoring.rawScore,
      feasibility,
      adjustedScore: scoring.adjustedScore,
      qualification,
      estimatedWorkload: feasibility.scope === 'docs_only' ? '30m-1h' : '2-4h',
      coreDemand: item.title,
      discoveryMode,
      matchedSignals: scoring.matchedSignals,
    });
  }

  // 4. Threshold Filter (in global discovery mode; targeted exploration returns all scored candidates)
  const threshold = profile.minMatchScore ?? 70;
  const filteredCandidates =
    discoveryMode === 'global_discovery'
      ? candidates.filter((c) => c.adjustedScore >= threshold)
      : candidates;

  // 5. Stage 2: 2-Stage Diversity Reranking
  const reranked = applyDiversityReranking(
    filteredCandidates.map((c) => ({
      ...c,
      rawScore: c.adjustedScore,
    })),
  );

  // 6. True Top N Slicing
  return reranked.slice(0, limit).map(({ item, finalScore }) => ({
    ...item,
    adjustedScore: finalScore,
  }));
}
