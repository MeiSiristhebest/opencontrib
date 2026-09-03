import { Octokit } from '@octokit/rest';
import type { ApiResult, RepoDetails, SearchIssuesResult } from './types.js';
import type { ResponseCache } from '../ports/response-cache.port.js';
import { requestWithRetry } from './retry-strategy.js';

export interface OctokitIssueSourceOptions {
  token: string;
  host: string;
  cache: ResponseCache;
}

/**
 * The octokit-backed "IssueSource" layer (architecture review §16 stage 4):
 * owns the authenticated Octokit instance and the GitHub domain operations.
 * Stateless retry and caching are injected (see `retry-strategy.ts` and
 * `response-cache.ts`), so this class is purely the *composition* of those
 * concerns around the API calls — no token resolution, no file I/O of its own.
 */
export class OctokitIssueSource {
  private octokit: Octokit;
  private cache: ResponseCache;

  constructor(opts: OctokitIssueSourceOptions) {
    this.octokit = new Octokit({
      auth: opts.token || undefined,
      baseUrl: opts.host ? `https://${opts.host}/api/v3` : undefined,
    });
    this.cache = opts.cache;
  }

  private request<T>(operation: () => Promise<T>, maxRetries = 3): Promise<ApiResult<T>> {
    return requestWithRetry(operation, maxRetries);
  }

  /**
   * Searches GitHub issues with explicit COMPLETE / PARTIAL / FAILED status taxonomy.
   */
  async searchIssues(
    query: string,
    options: { maxPages?: number; refresh?: boolean } = {},
  ): Promise<SearchIssuesResult> {
    const cacheKey = `search_${query}`;
    if (!options.refresh) {
      const cached = this.cache.get<SearchIssuesResult>(cacheKey);
      if (cached) return cached;
    }

    const items: any[] = [];
    const maxPages = options.maxPages ?? 2;
    let pagesFetched = 0;
    let failureError: string | undefined;

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request(async () => {
        return await this.octokit.request('GET /search/issues', {
          q: query,
          per_page: 30,
          page,
        });
      });

      if (res.status === 'OK' && res.data) {
        items.push(...res.data.data.items);
        pagesFetched++;
        if (res.data.data.items.length < 30) break; // Reached end of result set
        if (page < maxPages) {
          await new Promise((r) => setTimeout(r, 800)); // Pacing delay
        }
      } else {
        failureError = res.error;
        break; // Partial or complete failure
      }
    }

    let status: 'COMPLETE' | 'PARTIAL' | 'FAILED' = 'COMPLETE';
    if (pagesFetched === 0) {
      status = 'FAILED';
    } else if (pagesFetched < maxPages && failureError) {
      status = 'PARTIAL';
    }

    const result: SearchIssuesResult = {
      items,
      status,
      pagesFetched,
      pagesRequested: maxPages,
      error: failureError,
    };

    // Only cache completely successful searches
    if (status === 'COMPLETE') {
      this.cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Paged comments retrieval with central retry wrapper and rich error status.
   */
  async getIssueComments(
    owner: string,
    repo: string,
    issue_number: number,
    maxPages = 2,
  ): Promise<ApiResult<any[]>> {
    const cacheKey = `comments_${owner}_${repo}_${issue_number}`;
    const cached = this.cache.get<any[]>(cacheKey);
    if (cached) return { status: 'OK', data: cached };

    const allComments: any[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request(async () => {
        return await this.octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number,
          per_page: 50,
          page,
        });
      });

      if (res.status !== 'OK' || !res.data) {
        return {
          status: res.status,
          data: [],
          error: res.error,
          statusCode: res.statusCode,
        };
      }

      allComments.push(...res.data.data);
      if (res.data.data.length < 50) break;
    }

    this.cache.set(cacheKey, allComments);
    return { status: 'OK', data: allComments };
  }

  async getRepoTextFile(owner: string, repo: string, path: string): Promise<string | null> {
    const res = await this.request(async () => {
      return await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });
    });

    if (res.status !== 'OK' || !res.data) return null;
    const data = res.data.data;
    if (Array.isArray(data) || (data as any).type !== 'file' || typeof (data as any).content !== 'string') {
      return null;
    }
    return Buffer.from((data as any).content, 'base64').toString('utf-8').slice(0, 30_000);
  }

  async listWorkflowFiles(owner: string, repo: string): Promise<Array<{ path: string; content: string }>> {
    const res = await this.request(async () => {
      return await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: '.github/workflows',
      });
    });

    if (res.status !== 'OK' || !Array.isArray(res.data?.data)) return [];

    const workflowFiles = res.data.data
      .filter((item: any) => item.type === 'file' && /\.(ya?ml)$/i.test(item.name))
      .slice(0, 5);

    const contents = await Promise.all(
      workflowFiles.map(async (wf: any) => {
        const content = await this.getRepoTextFile(owner, repo, wf.path);
        return { path: wf.path, content: content || '' };
      }),
    );

    return contents.filter((c) => c.content.length > 0);
  }

  /**
   * Fetches real repository metadata.
   * Fail-Safe: Returns ApiResult<RepoDetails> and does NOT return fake mock data on error.
   */
  async getRepoDetails(owner: string, repo: string): Promise<ApiResult<RepoDetails>> {
    const cacheKey = `repo_details_${owner}_${repo}`;
    const cached = this.cache.get<RepoDetails>(cacheKey);
    if (cached) return { status: 'OK', data: cached };

    const res = await this.request(async () => {
      return await this.octokit.rest.repos.get({ owner, repo });
    });

    if (res.status !== 'OK' || !res.data) {
      return {
        status: res.status,
        data: null as any,
        error: res.error,
        statusCode: res.statusCode,
      };
    }

    const details: RepoDetails = {
      stars: res.data.data.stargazers_count ?? 0,
      defaultBranch: res.data.data.default_branch ?? 'main',
      isFork: res.data.data.fork ?? false,
      isArchived: res.data.data.archived ?? false,
      description: res.data.data.description ?? '',
    };

    this.cache.set(cacheKey, details);
    return { status: 'OK', data: details };
  }

  /**
   * Checks unique active open linked PRs via timeline events.
   * Uses Set<number> to count unique open PR numbers across timeline events.
   */
  async getIssueLinkedPrsCount(
    owner: string,
    repo: string,
    issue_number: number,
    maxPages = 2,
  ): Promise<ApiResult<number>> {
    const cacheKey = `issue_timeline_${owner}_${repo}_${issue_number}`;
    const cached = this.cache.get<number>(cacheKey);
    if (cached !== null) return { status: 'OK', data: cached };

    const openPrNumbers = new Set<number>();

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.request(async () => {
        return await this.octokit.rest.issues.listEventsForTimeline({
          owner,
          repo,
          issue_number,
          per_page: 50,
          page,
        });
      });

      if (res.status !== 'OK' || !res.data) {
        return {
          status: res.status,
          data: 0,
          error: res.error,
          statusCode: res.statusCode,
        };
      }

      for (const event of res.data.data) {
        if (
          event.event === 'cross-referenced' &&
          (event as any).source?.issue?.pull_request
        ) {
          const prNumber = (event as any).source?.issue?.number;
          const prState = (event as any).source?.issue?.state;
          if (prState === 'open' && typeof prNumber === 'number') {
            openPrNumbers.add(prNumber);
          }
        }
      }

      if (res.data.data.length < 50) break;
    }

    const uniqueOpenCount = openPrNumbers.size;
    this.cache.set(cacheKey, uniqueOpenCount);
    return { status: 'OK', data: uniqueOpenCount };
  }

  /**
   * High-level domain contract for checking existence of active linked PRs.
   */
  async hasActiveLinkedPr(
    owner: string,
    repo: string,
    issue_number: number,
  ): Promise<ApiResult<boolean>> {
    const res = await this.getIssueLinkedPrsCount(owner, repo, issue_number);
    return {
      status: res.status,
      data: res.data > 0,
      error: res.error,
      statusCode: res.statusCode,
    };
  }

  /** Exposed for callers that need raw resilient-request semantics. */
  requestWithRetry: typeof requestWithRetry = requestWithRetry;
}
