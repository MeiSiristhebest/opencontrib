import { Octokit } from '@octokit/rest';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface GitHubClientOptions {
  token?: string;
  cacheTtlMs?: number;
  host?: string;
  apiVersion?: string;
}

export type ApiStatus = 'OK' | 'NOT_FOUND' | 'RATE_LIMITED' | 'FORBIDDEN' | 'NETWORK_ERROR' | 'UNKNOWN_ERROR';

export interface ApiResult<T> {
  status: ApiStatus;
  data: T;
  error?: string;
  statusCode?: number;
}

export interface SearchIssuesResult {
  items: any[];
  status: 'COMPLETE' | 'PARTIAL' | 'FAILED';
  pagesFetched: number;
  pagesRequested: number;
  error?: string;
}

export interface RepoDetails {
  stars: number;
  defaultBranch: string;
  isFork: boolean;
  isArchived: boolean;
  description: string;
}

export class GitHubClient {
  private octokit: Octokit;
  private cacheDir: string;
  private cacheTtlMs: number;
  private tokenScope: string;
  private host: string;
  private apiVersion: string;
  private readonly schemaVersion = 'v4';

  constructor(options: GitHubClientOptions = {}) {
    let token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

    // Fallback 1: Read from ~/.config/opencontrib/config.json
    if (!token) {
      try {
        const configPath = join(homedir(), '.config', 'opencontrib', 'config.json');
        if (existsSync(configPath)) {
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          token = cfg?.github?.pat || '';
        }
      } catch {}
    }

    // Fallback 2: Read from GitHub CLI (gh auth token)
    if (!token) {
      try {
        const ghToken = require('child_process').execSync('gh auth token', {
          encoding: 'utf-8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        token = ghToken.trim();
      } catch {}
    }

    this.tokenScope = token ? createHash('sha256').update(token).digest('hex').slice(0, 8) : 'anon';
    this.host = options.host || 'github.com';
    this.apiVersion = options.apiVersion || '2022-11-28';
    this.octokit = new Octokit({ auth: token || undefined, baseUrl: options.host ? `https://${options.host}/api/v3` : undefined });
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000; // 10 minutes

    this.cacheDir = join(homedir(), '.opencontrib', 'cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCachePath(key: string): string {
    const identity = `${this.schemaVersion}_${this.host}_${this.apiVersion}_${this.tokenScope}_${key}`;
    const hash = createHash('sha256').update(identity).digest('hex');
    return join(this.cacheDir, `${hash}.json`);
  }

  private getCached<T>(key: string): T | null {
    const filePath = this.getCachePath(key);
    if (!existsSync(filePath)) return null;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (Date.now() - data.timestamp < this.cacheTtlMs) {
        return data.payload as T;
      }
    } catch {
      return null;
    }
    return null;
  }

  private setCache<T>(key: string, payload: T): void {
    const filePath = this.getCachePath(key);
    try {
      writeFileSync(filePath, JSON.stringify({ timestamp: Date.now(), payload }), 'utf-8');
    } catch {}
  }

  private mapErrorToApiStatus(err: any): { status: ApiStatus; statusCode?: number; isRetryable: boolean } {
    const status = err?.status || err?.statusCode;
    if (status === 404) return { status: 'NOT_FOUND', statusCode: 404, isRetryable: false };
    if (status === 401) return { status: 'FORBIDDEN', statusCode: 401, isRetryable: false };
    if (status === 403) {
      const isRateLimit = err?.response?.headers?.['x-ratelimit-remaining'] === '0' ||
                          /rate limit|secondary rate/i.test(err?.message || '');
      return {
        status: isRateLimit ? 'RATE_LIMITED' : 'FORBIDDEN',
        statusCode: 403,
        isRetryable: isRateLimit,
      };
    }
    if (status === 429) return { status: 'RATE_LIMITED', statusCode: 429, isRetryable: true };
    if (status >= 500 && status <= 504) return { status: 'UNKNOWN_ERROR', statusCode: status, isRetryable: true };
    if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.code === 'ETIMEDOUT' || err?.name === 'FetchError') {
      return { status: 'NETWORK_ERROR', isRetryable: true };
    }
    return { status: 'UNKNOWN_ERROR', statusCode: status, isRetryable: false };
  }

  private getRetryDelayMs(err: any, attempt: number): number {
    const headers = err?.response?.headers;
    if (headers) {
      if (headers['retry-after']) {
        const seconds = parseInt(headers['retry-after'], 10);
        if (!isNaN(seconds)) return Math.min(60000, seconds * 1000);
      }
      if (headers['x-ratelimit-reset']) {
        const resetTime = parseInt(headers['x-ratelimit-reset'], 10) * 1000;
        const diff = resetTime - Date.now();
        if (diff > 0 && diff < 60000) return diff + 500;
      }
    }
    // True exponential backoff with full jitter: (2^attempt * 1000ms) + random jitter (0-500ms)
    const baseDelay = Math.min(16000, Math.pow(2, attempt) * 1000);
    const jitter = Math.floor(Math.random() * 500);
    return baseDelay + jitter;
  }

  /**
   * Unified resilient request wrapper with exponential backoff and jitter.
   */
  async requestWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
  ): Promise<ApiResult<T>> {
    let attempt = 0;
    while (attempt < maxRetries) {
      try {
        const data = await operation();
        return { status: 'OK', data };
      } catch (err: any) {
        attempt++;
        const { status, statusCode, isRetryable } = this.mapErrorToApiStatus(err);
        if (isRetryable && attempt < maxRetries) {
          const delay = this.getRetryDelayMs(err, attempt);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        return {
          status,
          data: null as any,
          error: err?.message || String(err),
          statusCode,
        };
      }
    }
    return {
      status: 'UNKNOWN_ERROR',
      data: null as any,
      error: 'Max retries exhausted',
    };
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
      const cached = this.getCached<SearchIssuesResult>(cacheKey);
      if (cached) return cached;
    }

    const items: any[] = [];
    const maxPages = options.maxPages ?? 2;
    let pagesFetched = 0;
    let failureError: string | undefined;

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.requestWithRetry(async () => {
        return await this.octokit.rest.search.issuesAndPullRequests({
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
      this.setCache(cacheKey, result);
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
    const cached = this.getCached<any[]>(cacheKey);
    if (cached) return { status: 'OK', data: cached };

    const allComments: any[] = [];

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.requestWithRetry(async () => {
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

    this.setCache(cacheKey, allComments);
    return { status: 'OK', data: allComments };
  }

  async getRepoTextFile(owner: string, repo: string, path: string): Promise<string | null> {
    const res = await this.requestWithRetry(async () => {
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
    const res = await this.requestWithRetry(async () => {
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
    const cached = this.getCached<RepoDetails>(cacheKey);
    if (cached) return { status: 'OK', data: cached };

    const res = await this.requestWithRetry(async () => {
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

    this.setCache(cacheKey, details);
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
    const cached = this.getCached<number>(cacheKey);
    if (cached !== null) return { status: 'OK', data: cached };

    const openPrNumbers = new Set<number>();

    for (let page = 1; page <= maxPages; page++) {
      const res = await this.requestWithRetry(async () => {
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
    this.setCache(cacheKey, uniqueOpenCount);
    return { status: 'OK', data: uniqueOpenCount };
  }

  /**
   * High-level domain contract for checking existence of active linked PRs.
   */
  async hasActiveLinkedPr(owner: string, repo: string, issue_number: number): Promise<ApiResult<boolean>> {
    const res = await this.getIssueLinkedPrsCount(owner, repo, issue_number);
    return {
      status: res.status,
      data: res.data > 0,
      error: res.error,
      statusCode: res.statusCode,
    };
  }

  /**
   * Submit Pull Request adhering to GitHostPort contract.
   */
  async submitPullRequest(options: any): Promise<any> {
    const { ContributionPrService } = await import('../github/contribution-pr-service.js');
    const prService = new ContributionPrService(this);
    return prService.submitPullRequest(options);
  }
}

