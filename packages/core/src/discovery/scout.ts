import type { Opportunity, UserProfile } from '../contracts/schemas.js';
import { assessFeasibility, detectSystemCapabilities } from './feasibility.js';
import { GitHubClient } from './github-client.js';
import { qualifyIssue } from './qualification.js';
import {
  applyDiversityReranking,
  getSearchAliasQuery,
  matchesProfileTerm,
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

/**
 * Concurrency helper to run async tasks in parallel with a concurrency limit.
 */
async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let currentIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (currentIndex < items.length) {
      const idx = currentIndex++;
      results[idx] = await fn(items[idx]);
    }
  });

  await Promise.all(workers);
  return results;
}

/**
 * Scout Engine (Two-Tier Discovery + Unified Calibrated Scoring + Diversity Reranking)
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

  // 1. Build Query (Parenthesized labels, techStack + focusAreas search terms, stars range)
  let searchQuery = '';
  if (options.repo) {
    searchQuery = `repo:${options.repo} is:issue is:open no:assignee archived:false`;
  } else {
    // Parenthesized label group
    const joinedLabels =
      '(label:"good first issue" OR label:"good-first-issue" OR label:"help wanted" OR label:"help-wanted")';

    // Canonical alias query for tech stack
    const validTechQueries = (profile.techStack || [])
      .map(getSearchAliasQuery)
      .filter((q) => q.length > 0)
      .slice(0, 5);

    // Search query for focus areas
    const validAreaQueries = (profile.focusAreas || [])
      .map(getSearchAliasQuery)
      .filter((q) => q.length > 0)
      .slice(0, 3);

    const allTopicQueries = [...validTechQueries, ...validAreaQueries];
    const topicQuery = allTopicQueries.length > 0 ? `(${allTopicQueries.join(' OR ')})` : '';
    const starsQuery = maxStars !== undefined ? `stars:${minStars}..${maxStars}` : `stars:>=${minStars}`;

    searchQuery = [joinedLabels, topicQuery, starsQuery, 'is:issue is:open no:assignee archived:false']
      .filter(Boolean)
      .join(' ');
  }

  const searchResult = await client.searchIssues(searchQuery, { refresh: options.refresh, maxPages: 2 });
  const rawItems = searchResult.items || [];
  if (rawItems.length === 0) {
    return [];
  }

  // 2. Tier 1: Cheap Local Pre-Filtering (High Recall: Top 40)
  // Uses token-aware `matchesProfileTerm` so Tier 1 matcher matches Tier 2 formal scorer
  const preFiltered = rawItems
    .filter((item) => !item.pull_request && !item.locked)
    .map((item) => {
      const labels = (item.labels || []).map((l: any) => (typeof l === 'string' ? l : l.name || ''));
      const text = `${item.title} ${item.body || ''}`;

      let keywordHits = 0;
      for (const tech of profile.techStack) {
        if (matchesProfileTerm(text, tech)) keywordHits++;
      }
      for (const area of profile.focusAreas || []) {
        if (matchesProfileTerm(text, area)) keywordHits++;
      }

      const cheapRelevance = keywordHits * 10 + (labels.some((l: string) => /good first issue|starter/i.test(l)) ? 15 : 0);
      return { item, labels, cheapRelevance };
    })
    .sort((a, b) => b.cheapRelevance - a.cheapRelevance)
    .slice(0, 40); // Expanded recall window

  // 3. Tier 2: Bounded Parallel Enrichment (Concurrency = 5)
  const repoDetailsCache = new Map<string, any>();

  const candidates = (
    await mapConcurrent(preFiltered, 5, async ({ item, labels }) => {
      // Parse repository full name
      const repoMatch = item.repository_url.match(/repos\/(.+?)\/(.+)$/);
      const owner = repoMatch ? repoMatch[1] : '';
      const repo = repoMatch ? repoMatch[2] : '';
      const repoFullName = options.repo || (owner && repo ? `${owner}/${repo}` : '');
      if (!repoFullName) return null;

      // Fail-Safe Batch repo details
      let repoDetails = repoDetailsCache.get(repoFullName);
      if (!repoDetails) {
        const repoRes = await client.getRepoDetails(owner, repo);
        if (repoRes.status !== 'OK' || !repoRes.data) {
          return null; // Fail-Safe: discard issue if repo metadata cannot be securely verified
        }
        repoDetails = repoRes.data;
        repoDetailsCache.set(repoFullName, repoDetails);
      }
      if (repoDetails.isArchived) return null;

      // Paged comments and timeline with rich ApiStatus
      const commentsResult = await client.getIssueComments(owner, repo, item.number);
      const timelineResult = await client.getIssueLinkedPrsCount(owner, repo, item.number);

      const comments = commentsResult.data.map((c: any) => ({
        id: c.id,
        body: c.body,
        user: { login: c.user?.login },
        created_at: c.created_at,
      }));

      // Authoritative Qualification Check (Strict Gate)
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
        return null; // Discard disqualified issues
      }

      // Feasibility Assessment
      const feasibility = assessFeasibility(item.title, item.body || '', labels, capabilities);

      // Latest comment timestamp calculation (strictly computed, not dependent on array ordering)
      const validCommentTimestamps = comments
        .map((c: any) => Date.parse(c.created_at))
        .filter((t: number) => !isNaN(t) && t > 0);
      const latestCommentAtStr =
        validCommentTimestamps.length > 0
          ? new Date(Math.max(...validCommentTimestamps)).toISOString()
          : undefined;

      // Single Source of Truth Scoring (Calibrated Formula)
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
          latestCommentAt: latestCommentAtStr,
          commentDates: comments.map((c: any) => c.created_at),
          repoStars: repoDetails.stars,
        },
        feasibility,
      });

      const opp: Opportunity = {
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
        rawScore: scoring.rawScore,
        feasibility,
        adjustedScore: scoring.adjustedScore,
        qualification,
        estimatedWorkload: feasibility.scope === 'docs_only' ? '30m-1h' : '2-4h',
        coreDemand: item.title,
        discoveryMode,
        matchedSignals: scoring.matchedSignals,
      };

      return opp;
    })
  ).filter((c): c is Opportunity => c !== null);

  // 4. Threshold Filter (in global discovery mode; targeted exploration retains all scored candidates)
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

  // 6. True Top N Slicing with Distinct rankScore and diversityPenalty
  return reranked.slice(0, limit).map(({ item, rankScore, diversityPenalty }) => ({
    ...item,
    diversityPenalty,
    rankScore,
  }));
}
