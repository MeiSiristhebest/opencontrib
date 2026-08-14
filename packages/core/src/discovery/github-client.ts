import { Octokit } from '@octokit/rest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export interface GitHubClientOptions {
  token?: string;
  cacheTtlMs?: number;
}

export class GitHubClient {
  private octokit: Octokit;
  private cacheDir: string;
  private cacheTtlMs: number;

  constructor(options: GitHubClientOptions = {}) {
    let token = options.token || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

    // Fallback 1: Read from ~/.config/openmeta/config.json
    if (!token) {
      try {
        const configPath = join(homedir(), '.config', 'openmeta', 'config.json');
        if (existsSync(configPath)) {
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          token = cfg?.github?.pat || '';
        }
      } catch {}
    }

    // Fallback 2: Read from GitHub CLI (gh auth token)
    if (!token) {
      try {
        const ghToken = require('child_process').execSync('gh auth token', { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
        token = ghToken.trim();
      } catch {}
    }

    this.octokit = new Octokit({ auth: token || undefined });
    this.cacheTtlMs = options.cacheTtlMs ?? 10 * 60 * 1000; // 10 minutes

    this.cacheDir = join(homedir(), '.opencontrib', 'cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCachePath(key: string): string {
    const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.cacheDir, `${safeKey}.json`);
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
    } catch {
      // Ignore cache write errors
    }
  }

  async searchIssues(query: string, options: { maxPages?: number; refresh?: boolean } = {}) {
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

          // Pacing delay (3000ms) between pages
          if (page < maxPages && resp.data.items.length === 30) {
            await new Promise((r) => setTimeout(r, 3000));
          }
        } catch (err: any) {
          retries++;
          if (err.status === 403 || err.status === 429) {
            // Rate limit hit, wait 5s and retry
            await new Promise((r) => setTimeout(r, 5000));
          } else {
            throw err;
          }
        }
      }
    }

    this.setCache(cacheKey, items);
    return items;
  }

  async getIssueComments(owner: string, repo: string, issue_number: number) {
    const cacheKey = `comments_${owner}_${repo}_${issue_number}`;
    const cached = this.getCached<any[]>(cacheKey);
    if (cached) return cached;

    try {
      const resp = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number,
        per_page: 50,
      });
      this.setCache(cacheKey, resp.data);
      return resp.data;
    } catch {
      return [];
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
}
