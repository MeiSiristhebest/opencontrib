import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getOpenContribDataDir } from '../kernel/home.js';
import type {
  Opportunity,
  UserProfile,
  CommunityGateStatus,
  MaintainerApprovalSignal,
} from '../contracts/schemas.js';
import { assessFeasibility, detectSystemCapabilities } from './feasibility.js';
import { GitHubClient } from './github-client.js';
import { qualifyIssue } from './qualification.js';
import {
  COMMUNITY_GATE_POLICY_PATHS,
  detectCommunityGateFromContents,
  type CommunityGatePolicy,
} from '../governance/community-gate.js';
import {
  applyDiversityReranking,
  getSearchAliasQuery,
  matchesProfileTerm,
  scoreCandidateIssue,
} from './scoring-engine.js';

// The Contents API caps directory listings at 1,000 entries; a full listing may omit policy paths.
const MAX_GITHUB_DIRECTORY_ENTRIES = 1000;

const COMMUNITY_POLICY_DIRECTORIES = Array.from(
  new Set(
    COMMUNITY_GATE_POLICY_PATHS.map((policyPath) => {
      const separator = policyPath.lastIndexOf('/');
      return separator === -1 ? '' : policyPath.slice(0, separator);
    }),
  ),
).sort((left, right) => left.length - right.length);

/**
 * Scans local runs directory to collect previously attempted or completed issue targets.
 * Returns a Set of canonical lowercase keys: "owner/repo#123".
 */
export function collectHistoricalRunIssues(runsDir?: string): Set<string> {
  const issues = new Set<string>();
  const targetDir = runsDir
    ? resolve(runsDir)
    : resolve(getOpenContribDataDir(), 'runs');
  if (!existsSync(targetDir)) {
    return issues;
  }

  try {
    const entries = readdirSync(targetDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const runDir = join(targetDir, entry.name);
      for (const fname of ['context.json', 'run.json', 'manifest.json', 'opportunity.json']) {
        const fpath = join(runDir, fname);
        if (!existsSync(fpath)) continue;
        try {
          const raw = JSON.parse(readFileSync(fpath, 'utf8'));
          const repo =
            raw.problemContext?.repoFullName ||
            raw.topOpportunity?.repoFullName ||
            raw.repoFullName ||
            raw.manifest?.repoFullName ||
            raw.targetRepo ||
            raw.target;
          const issueNum =
            raw.problemContext?.issueNumber ??
            raw.issueNumber ??
            raw.manifest?.issueNumber ??
            raw.topOpportunity?.issueNumber ??
            raw.issue;
          if (repo && typeof issueNum === 'number') {
            issues.add(`${String(repo).toLowerCase()}#${issueNum}`);
          }
        } catch {
          // ignore corrupted or transient json artifacts
        }
      }
    }
  } catch {
    // best-effort discovery
  }

  return issues;
}

export interface ScoutOptions {
  repo?: string;
  minStars?: number;
  maxStars?: number;
  limit?: number;
  refresh?: boolean;
  githubToken?: string;
  excludeIssues?: Array<{ repoFullName: string; issueNumber: number } | string>;
  excludeCompletedRuns?: boolean;
  runsDir?: string;
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

  const workers: Promise<void>[] = [];
  const workerCount = Math.min(concurrency, items.length);
  for (let workerIndex = 0; workerIndex < workerCount; workerIndex++) {
    workers.push(
      (async () => {
        while (currentIndex < items.length) {
          const idx = currentIndex++;
          results[idx] = await fn(items[idx]);
        }
      })(),
    );
  }

  await Promise.all(workers);
  return results;
}

/**
 * Scout Engine (Two-Tier Discovery + Unified Calibrated Scoring + Diversity Reranking)
 * Orchestrates GitHub discovery, cheap pre-ranking, deep community enrichment,
 * single source of truth scoring, and 2-stage diversity reranking.
 *
 * The GitHub client may be injected via `options.client` (DIP): the pipeline
 * passes its already-wired `deps.client` so `scout` never constructs its own
 * network adapter and is fully testable with an `InMemoryIssueSource`.
 * Callers that omit `options.client` get a default-wired production client.
 */
export async function scoutOpportunities(
  profile: UserProfile,
  options: ScoutOptions = {},
  client?: GitHubClient,
): Promise<Opportunity[]> {
  const resolvedClient = client ?? new GitHubClient({ token: options.githubToken });
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

  let rawItems: any[] = [];
  const searchResult = await resolvedClient.searchIssues(searchQuery, { refresh: options.refresh, maxPages: 2 });
  if (searchResult.status !== 'FAILED' && searchResult.items && searchResult.items.length > 0) {
    rawItems = searchResult.items;
  } else if (discoveryMode === 'targeted_repo' && options.repo) {
    // Tri-route fallback: GitHub Search API failed or returned 0 items due to search index delay or query constraints.
    // Fall back to direct repository issues API (listForRepo)
    const [owner, repo] = options.repo.split('/');
    if (owner && repo) {
      const listRes = await resolvedClient.listRepoIssues(owner, repo, {
        state: 'open',
        sort: 'updated',
        maxPages: 2,
        refresh: options.refresh,
      });
      if (listRes.status === 'OK' && Array.isArray(listRes.data)) {
        rawItems = listRes.data.map((item) => ({
          ...item,
          repository_url: item.repository_url || `https://api.github.com/repos/${owner}/${repo}`,
        }));
      }
    }
  }

  if (rawItems.length === 0) {
    return [];
  }

  // Build excluded issues set (from historical runs or explicit configuration)
  const excludedSet = new Set<string>();
  if (options.excludeCompletedRuns) {
    const historical = collectHistoricalRunIssues(options.runsDir);
    for (const h of historical) excludedSet.add(h);
  }
  if (options.excludeIssues) {
    for (const entry of options.excludeIssues) {
      if (typeof entry === 'string') {
        const trimmed = entry.trim().toLowerCase();
        if (trimmed.includes('#')) {
          excludedSet.add(trimmed);
        } else if (options.repo && /^\d+$/.test(trimmed)) {
          excludedSet.add(`${options.repo.toLowerCase()}#${trimmed}`);
        }
      } else if (entry && entry.repoFullName && typeof entry.issueNumber === 'number') {
        excludedSet.add(`${entry.repoFullName.toLowerCase()}#${entry.issueNumber}`);
      }
    }
  }

  // 2. Tier 1: Cheap Local Pre-Filtering (Bounded Recall Window)
  // For targeted repo exploration, bound recall to (limit * 2) to eliminate 100+ slow network HTTP calls
  const maxRecall = discoveryMode === 'targeted_repo' ? Math.min(limit * 2, 15) : Math.min(limit * 3, 30);

  const preFiltered = rawItems
    .filter((item) => {
      if (item.pull_request || item.locked || item.assignee || (item.assignees && item.assignees.length > 0)) {
        return false;
      }
      if (excludedSet.size > 0) {
        const repoMatch = item.repository_url?.match(/repos\/(.+?)\/(.+)$/);
        const itemRepo = options.repo || (repoMatch ? `${repoMatch[1]}/${repoMatch[2]}` : '');
        if (itemRepo && excludedSet.has(`${itemRepo.toLowerCase()}#${item.number}`)) {
          return false;
        }
      }
      return true;
    })
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
    .slice(0, maxRecall); // Strictly bounded recall window to guarantee sub-3s response

  // 3. Tier 2: Bounded Parallel Enrichment (Concurrency = 5)
  const repoDetailsCache = new Map<string, any>();
  const repoGatePolicyCache = new Map<string, Promise<CommunityGatePolicy>>();
  const getRepoGatePolicy = (
    owner: string,
    repo: string,
    repoFullName: string,
  ): Promise<CommunityGatePolicy> => {
    let pending = repoGatePolicyCache.get(repoFullName);
    if (!pending) {
      pending = (async () => {
        const directoryContents = new Map<
          string,
          Array<{ path: string; type: 'file' | 'dir' }>
        >();
        const rootContents = await resolvedClient.getRepoDirectoryContentsResult(
          owner,
          repo,
          '',
        );
        if (rootContents.status !== 'OK') {
          throw new Error(
            `CommunityGatePolicyReadError: ${rootContents.status} while listing repository root`,
          );
        }
        directoryContents.set('', rootContents.data);

        for (const directory of COMMUNITY_POLICY_DIRECTORIES) {
          if (directory === '') continue;
          const separator = directory.lastIndexOf('/');
          const parent = separator === -1 ? '' : directory.slice(0, separator);
          const parentEntries = directoryContents.get(parent) ?? [];
          if (
            !parentEntries.some(
              (entry) => entry.path === directory && entry.type === 'dir',
            )
          ) {
            continue;
          }

          const result = await resolvedClient.getRepoDirectoryContentsResult(
            owner,
            repo,
            directory,
          );
          if (result.status !== 'OK') {
            throw new Error(
              `CommunityGatePolicyReadError: ${result.status} while listing ${directory}`,
            );
          }
          directoryContents.set(directory, result.data);
        }

        const discoveredPaths = new Set<string>();
        for (const entries of directoryContents.values()) {
          for (const entry of entries) {
            if (entry.type === 'file') discoveredPaths.add(entry.path);
          }
        }
        const hasPossiblyTruncatedDirectory = Array.from(
          directoryContents.values(),
        ).some(
          (entries) => entries.length >= MAX_GITHUB_DIRECTORY_ENTRIES,
        );
        const candidatePaths = COMMUNITY_GATE_POLICY_PATHS.filter(
          (path) => hasPossiblyTruncatedDirectory || discoveredPaths.has(path),
        );
        const policyResults = await Promise.all(
          candidatePaths.map((path) =>
            resolvedClient.getRepoTextFileResult(owner, repo, path),
          ),
        );
        const policyFiles: Array<{ path: string; content: string }> = [];
        for (let index = 0; index < candidatePaths.length; index++) {
          const path = candidatePaths[index];
          const result = policyResults[index];
          if (result.status === 'NOT_FOUND' && !discoveredPaths.has(path)) {
            continue;
          }
          if (result.status !== 'OK') {
            throw new Error(
              `CommunityGatePolicyReadError: ${result.status} while reading ${path}`,
            );
          }
          if (result.data) policyFiles.push({ path, content: result.data });
        }
        return detectCommunityGateFromContents(policyFiles);
      })();
      repoGatePolicyCache.set(repoFullName, pending);
    }
    return pending;
  };

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
        const repoRes = await resolvedClient.getRepoDetails(owner, repo);
        if (repoRes.status !== 'OK' || !repoRes.data) {
          return null; // Fail-Safe: discard issue if repo metadata cannot be securely verified
        }
        repoDetails = repoRes.data;
        repoDetailsCache.set(repoFullName, repoDetails);
      }
      if (repoDetails.isArchived) return null;

      // Fail closed if any policy lookup is unavailable; a read failure must
      // never be mistaken for a repository with no contribution gate.
      let gatePolicy: CommunityGatePolicy;
      try {
        gatePolicy = await getRepoGatePolicy(owner, repo, repoFullName);
      } catch {
        return null;
      }

      // Paged comments and timeline with rich ApiStatus
      const commentsResult = await resolvedClient.getIssueComments(owner, repo, item.number);
      const timelineResult = await resolvedClient.getIssueLinkedPrsCount(owner, repo, item.number);

      const comments = commentsResult.data.map((c: any) => ({
        id: c.id,
        body: c.body,
        user: { login: c.user?.login },
        author_association: c.author_association,
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

      // Multi-dimensional Community Gate & Maintainer Approval Detection
      const hasGateRules = Boolean(
        gatePolicy.autoClosesNewIssues ||
        gatePolicy.hasLgtmApprovalProtocol ||
        gatePolicy.requiresIssueApprovalBeforePr
      );

      const approvalSignals: MaintainerApprovalSignal[] = [];

      if (hasGateRules) {
        // 1. Label-based maintainer approval signal (e.g. accepted, approved, lgtm, triaged, ready)
        for (const l of labels) {
          const lLower = l.toLowerCase();
          if (/\b(?:approved|lgtm|accepted|triaged|ready-for-pr|ready|confirmed)\b/i.test(lLower)) {
            approvalSignals.push({
              source: 'label',
              detail: `Issue labeled: "${l}"`,
              confidence: 'high',
            });
          }
        }

        // 2. Only repository-maintainer associations can authorize contribution.
        for (const c of comments) {
          const assoc = (c.author_association || '').toUpperCase();
          const isMaintainer = ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(assoc);
          if (!isMaintainer) continue;

          const body = (c.body || '').trim().toLowerCase();
          const isNegated =
            /\b(?:not|no|never|don't|doesn't|isn't|cannot|can't|wait|hold off)\b/i.test(
              body,
            );
          const hasApprovalIntent =
            /\b(?:lgtmi?|approved|looks good|go ahead|feel free to|welcome to send|assigned to you)\b/i.test(
              body,
            ) || /(?:^|\s)\+1\b/.test(body);

          if (hasApprovalIntent && !isNegated) {
            approvalSignals.push({
              source: 'author_association',
              detail: `Maintainer (@${c.user?.login || 'unknown'}, ${assoc}) approved: "${(c.body || '').slice(0, 80)}"`,
              confidence: 'high',
            });
          }
        }
      }

      let communityGateStatus: CommunityGateStatus = 'OPEN_FOR_CONTRIBUTION';
      let communityGateSuggestedAction: string | undefined;

      if (hasGateRules) {
        if (approvalSignals.length > 0) {
          communityGateStatus = 'APPROVED_BY_MAINTAINER';
          communityGateSuggestedAction = 'Maintainer has approved this issue. Ready for contribution.';
        } else {
          communityGateStatus = 'REQUIRES_MAINTAINER_APPROVAL';
          communityGateSuggestedAction = gatePolicy.suggestedContributorAction ||
            'Repository requires maintainer triage/approval before submitting a PR. Discuss in issue first.';
        }
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
        primaryLanguage: repoDetails.primaryLanguage,
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
        communityGateStatus,
        communityGateSignals: approvalSignals.length > 0 ? approvalSignals : undefined,
        communityGateSuggestedAction,
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
