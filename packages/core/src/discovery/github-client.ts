import { Octokit } from '@octokit/rest';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface GitHubClientOptions {
  token?: string;
  cacheTtlMs?: number;
}

export type ApiStatus = 'OK' | 'NOT_FOUND' | 'RATE_LIMITED' | 'FORBIDDEN' | 'NETWORK_ERROR' | 'UNKNOWN_ERROR';

export interface ApiResult<T> {
  status: ApiStatus;
  data: T;
  error?: string;
  statusCode?: number;
}

export class GitHubClient {
  private octokit: Octokit;
  private cacheDir: string;
  private cacheTtlMs: number;
  private tokenScope: string;
  private readonly schemaVersion = 'v3';

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
    this.octokit = new Octokit({ auth: token || undefined });
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000; // 10 minutes

    this.cacheDir = join(homedir(), '.opencontrib', 'cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCachePath(key: string): string {
    const hash = createHash('sha256')
      .update(`${this.schemaVersion}_${this.tokenScope}_${key}`)
      .digest('hex');
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

  private mapErrorToApiStatus(err: any): { status: ApiStatus; statusCode?: number } {
    const status = err?.status || err?.statusCode;
    if (status === 404) return { status: 'NOT_FOUND', statusCode: 404 };
    if (status === 403) return { status: 'FORBIDDEN', statusCode: 403 };
    if (status === 429) return { status: 'RATE_LIMITED', statusCode: 429 };
    if (err?.code === 'ENOTFOUND' || err?.code === 'ECONNREFUSED' || err?.name === 'FetchError') {
      return { status: 'NETWORK_ERROR' };
    }
    return { status: 'UNKNOWN_ERROR', statusCode: status };
  }

  private getRetryDelayMs(err: any): number {
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
    return 3000; // Default exponential/fallback backoff
  }

  async searchIssues(query: string, options: { maxPages?: number; refresh?: boolean } = {}): Promise<any[]> {
    const cacheKey = `search_${query}`;
    if (!options.refresh) {
      const cached = this.getCached<any[]>(cacheKey);
      if (cached) return cached;
    }

    const items: any[] = [];
    const maxPages = options.maxPages ?? 2;

    for (let page = 1; page <= maxPages; page++) {
      let retries = 0;
      let success = false;

      while (!success && retries < 3) {
        try {
          const resp = await this.octokit.rest.search.issuesAndPullRequests({
            q: query,
            per_page: 30,
            page,
          });

          items.push(...resp.data.items);
          success = true;

          // Pacing delay between pages
          if (page < maxPages && resp.data.items.length === 30) {
            await new Promise((r) => setTimeout(r, 1000));
          }
        } catch (err: any) {
          retries++;
          if (err.status === 403 || err.status === 429) {
            const delay = this.getRetryDelayMs(err);
            await new Promise((r) => setTimeout(r, delay));
          } else {
            throw err;
          }
        }
      }
    }

    this.setCache(cacheKey, items);
    return items;
  }

  /**
   * Paged comments retrieval with comprehensive Tri-State / Error taxonomy return.
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

    try {
      for (let page = 1; page <= maxPages; page++) {
        const resp = await this.octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number,
          per_page: 50,
          page,
        });

        allComments.push(...resp.data);
        if (resp.data.length < 50) break; // Reached end of comments
      }

      this.setCache(cacheKey, allComments);
      return { status: 'OK', data: allComments };
    } catch (err: any) {
      const errInfo = this.mapErrorToApiStatus(err);
      return {
        status: errInfo.status,
        data: [],
        error: err.message,
        statusCode: errInfo.statusCode,
      };
    }
  }

  async getRepoTextFile(owner: string, repo: string, path: string): Promise<string | null> {
    try {
      const resp = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path,
      });

      const data = resp.data;
      if (Array.isArray(data) || data.type !== 'file' || typeof data.content !== 'string') {
        return null;
      }
      return Buffer.from(data.content, 'base64').toString('utf-8').slice(0, 30_000);
    } catch {
      return null;
    }
  }

  async listWorkflowFiles(owner: string, repo: string): Promise<Array<{ path: string; content: string }>> {
    try {
      const resp = await this.octokit.rest.repos.getContent({
        owner,
        repo,
        path: '.github/workflows',
      });

      if (!Array.isArray(resp.data)) return [];

      const workflowFiles = resp.data
        .filter((item) => item.type === 'file' && /\.(ya?ml)$/i.test(item.name))
        .slice(0, 5);

      const contents = await Promise.all(
        workflowFiles.map(async (wf) => {
          const content = await this.getRepoTextFile(owner, repo, wf.path);
          return { path: wf.path, content: content || '' };
        }),
      );

      return contents.filter((c) => c.content.length > 0);
    } catch {
      return [];
    }
  }

  async getRepoDetails(owner: string, repo: string): Promise<{
    stars: number;
    defaultBranch: string;
    isFork: boolean;
    isArchived: boolean;
    description: string;
  }> {
    const cacheKey = `repo_details_${owner}_${repo}`;
    const cached = this.getCached<any>(cacheKey);
    if (cached) return cached;

    try {
      const resp = await this.octokit.rest.repos.get({ owner, repo });
      const details = {
        stars: resp.data.stargazers_count ?? 0,
        defaultBranch: resp.data.default_branch ?? 'main',
        isFork: resp.data.fork ?? false,
        isArchived: resp.data.archived ?? false,
        description: resp.data.description ?? '',
      };
      this.setCache(cacheKey, details);
      return details;
    } catch {
      return {
        stars: 0,
        defaultBranch: 'main',
        isFork: false,
        isArchived: false,
        description: '',
      };
    }
  }

  /**
   * Checks if an issue has active open linked PRs.
   * P0 Fix: Uses Set<number> to count unique open PR numbers across timeline events,
   * avoiding duplicate counting when a single PR cross-references an issue multiple times.
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

    try {
      for (let page = 1; page <= maxPages; page++) {
        const resp = await this.octokit.rest.issues.listEventsForTimeline({
          owner,
          repo,
          issue_number,
          per_page: 50,
          page,
        });

        for (const event of resp.data) {
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

        if (resp.data.length < 50) break;
      }

      const uniqueOpenCount = openPrNumbers.size;
      this.setCache(cacheKey, uniqueOpenCount);
      return { status: 'OK', data: uniqueOpenCount };
    } catch (err: any) {
      const errInfo = this.mapErrorToApiStatus(err);
      return {
        status: errInfo.status,
        data: 0,
        error: err.message,
        statusCode: errInfo.statusCode,
      };
    }
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
}
