import { describe, expect, it } from 'bun:test';
import {
  mapErrorToApiStatus,
  requestWithRetry,
} from '../src/github/retry-strategy.js';
import { GitHubClient } from '../src/discovery/github-client.js';
import { scoutOpportunities } from '../src/discovery/scout.js';
import type { CredentialsProvider } from '../src/ports/credentials-provider.port.js';
import type { ResponseCache } from '../src/ports/response-cache.port.js';

// ── Retry strategy (extracted, pure) ───────────────────────────────────────────
describe('retry-strategy (GitHubClient split)', () => {
  it('classifies 404 as NOT_FOUND / not retryable', () => {
    const r = mapErrorToApiStatus({ status: 404 });
    expect(r.status).toBe('NOT_FOUND');
    expect(r.isRetryable).toBe(false);
  });

  it('classifies 403 rate-limit as RATE_LIMITED / retryable', () => {
    const r = mapErrorToApiStatus({
      status: 403,
      response: { headers: { 'x-ratelimit-remaining': '0' } },
    });
    expect(r.status).toBe('RATE_LIMITED');
    expect(r.isRetryable).toBe(true);
  });

  it('classifies ENOTFOUND as NETWORK_ERROR / retryable', () => {
    const r = mapErrorToApiStatus({ code: 'ENOTFOUND' });
    expect(r.status).toBe('NETWORK_ERROR');
    expect(r.isRetryable).toBe(true);
  });

  it('preserves provider errors that already carry an ApiStatus', () => {
    expect(mapErrorToApiStatus({ status: 'RATE_LIMITED' })).toEqual({
      status: 'RATE_LIMITED',
      isRetryable: true,
    });
    expect(mapErrorToApiStatus({ status: 'FORBIDDEN' })).toEqual({
      status: 'FORBIDDEN',
      isRetryable: false,
    });
  });

  it('returns OK on first success', async () => {
    const res = await requestWithRetry(async () => 42);
    expect(res).toEqual({ status: 'OK', data: 42 });
  });

  it('retries retryable errors then surfaces the failure (injectable sleep)', async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const res = await requestWithRetry(
      async () => {
        attempts++;
        throw { status: 500 };
      },
      3,
      async (ms) => {
        sleeps.push(ms);
      },
    );
    expect(attempts).toBe(3);
    expect(sleeps.length).toBe(2); // two sleeps between three attempts
    expect(res.status).toBe('UNKNOWN_ERROR');
  });
});

// ── Dependency-injection seam (ports, not hardcoded wiring) ────────────────────
describe('GitHubClient composition root seam', () => {
  it('accepts injected CredentialsProvider and ResponseCache ports', () => {
    const calls: string[] = [];
    const fakeCreds: CredentialsProvider = {
      getToken: () => 'injected-token',
      getTokenScope: () => 'scope-abc',
    };
    const fakeCache: ResponseCache = {
      get: (k: string) => {
        calls.push(`get:${k}`);
        return null;
      },
      set: (k: string) => {
        calls.push(`set:${k}`);
      },
    };

    // Construction must not perform network or cache I/O.
    const client = new GitHubClient({ token: 'injected-token' }, {
      credentials: fakeCreds,
      cache: fakeCache,
    });
    expect(client).toBeInstanceOf(GitHubClient);
    expect((client as any).credentials).toBe(fakeCreds);
    expect((client as any).cache).toBe(fakeCache);
    expect(calls).toEqual([]);
  });

  it('keeps baseUrl undefined for public github.com and api.github.com to hit api.github.com', () => {
    const fakeCreds: CredentialsProvider = {
      getToken: () => 'token',
      getTokenScope: () => 'scope',
    };
    const fakeCache: ResponseCache = {
      get: () => null,
      set: () => {},
    };

    const publicClient = new GitHubClient({}, { credentials: fakeCreds, cache: fakeCache });
    const octokitPublic = (publicClient as any).source.octokit;
    expect(octokitPublic.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');

    const dotComClient = new GitHubClient({ host: 'github.com' }, { credentials: fakeCreds, cache: fakeCache });
    const octokitDotCom = (dotComClient as any).source.octokit;
    expect(octokitDotCom.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');

    const enterpriseClient = new GitHubClient({ host: 'github.mycompany.internal' }, { credentials: fakeCreds, cache: fakeCache });
    const octokitEnterprise = (enterpriseClient as any).source.octokit;
    expect(octokitEnterprise.request.endpoint.DEFAULTS.baseUrl).toBe('https://github.mycompany.internal/api/v3');
  });

  it('exposes listRepoIssues method for direct repository issues retrieval', () => {
    const fakeCreds: CredentialsProvider = {
      getToken: () => 'token',
      getTokenScope: () => 'scope',
    };
    const fakeCache: ResponseCache = {
      get: () => null,
      set: () => {},
    };

    const client = new GitHubClient({}, { credentials: fakeCreds, cache: fakeCache });
    expect(typeof client.listRepoIssues).toBe('function');
  });

  it('scoutOpportunities executes Tri-Route fallback to listRepoIssues when search returns 0 items', async () => {
    let searchIssuesCalled = false;
    let listRepoIssuesCalled = false;
    const fakeClient = {
      searchIssues: async () => {
        searchIssuesCalled = true;
        return {
          items: [],
          status: 'COMPLETE' as const,
          pagesFetched: 1,
          pagesRequested: 1,
        };
      },
      listRepoIssues: async (owner: string, repo: string) => {
        listRepoIssuesCalled = true;
        return {
          status: 'OK' as const,
          data: [
            {
              number: 42,
              title: 'Fix issue in parser',
              body: 'Parser needs bugfix with typescript',
              labels: [{ name: 'good first issue' }],
              repository_url: `https://api.github.com/repos/${owner}/${repo}`,
              assignee: null,
              assignees: [],
              pull_request: undefined,
              locked: false,
              state: 'open',
              created_at: new Date().toISOString(),
              user: { login: 'alice' },
            },
          ],
        };
      },
      getRepoDetails: async () => ({
        status: 'OK' as const,
        data: {
          stars: 120,
          defaultBranch: 'main',
          isFork: false,
          isArchived: false,
          description: 'A great open-source project',
        },
      }),
      getRepoTextFileResult: async () => ({
        status: 'OK' as const,
        data: null,
      }),
      getRepoTextFile: async () => null,
      hasActiveLinkedPr: async () => ({
        status: 'OK' as const,
        data: false,
      }),
      getIssueComments: async () => ({
        status: 'OK' as const,
        data: [],
      }),
      getIssueLinkedPrsCount: async () => ({
        status: 'OK' as const,
        data: 0,
      }),
    };

    const opportunities = await scoutOpportunities(
      {
        techStack: ['typescript'],
        focusAreas: ['bugfix'],
        proficiency: 'intermediate',
        minMatchScore: 50,
      },
      { repo: 'microsoft/demo-repo', minStars: 50 },
      fakeClient as any,
    );

    expect(searchIssuesCalled).toBe(true);
    expect(listRepoIssuesCalled).toBe(true);
    expect(opportunities.length).toBe(1);
    expect(opportunities[0].issueNumber).toBe(42);
    expect(opportunities[0].repoFullName).toBe('microsoft/demo-repo');
  });
});
