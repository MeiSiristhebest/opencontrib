import { describe, expect, it } from 'bun:test';
import {
  mapErrorToApiStatus,
  requestWithRetry,
} from '../src/github/retry-strategy.js';
import { GitHubClient } from '../src/discovery/github-client.js';
import { OctokitIssueSource } from '../src/github/octokit-issue-source.js';
import { scoutOpportunities } from '../src/discovery/scout.js';
import { COMMUNITY_GATE_POLICY_PATHS } from '../src/governance/community-gate.js';
import type { CredentialsProvider } from '../src/ports/credentials-provider.port.js';
import type { ResponseCache } from '../src/ports/response-cache.port.js';

function createMemoryCache(): {
  cache: ResponseCache;
  reads: string[];
  writes: string[];
} {
  const values = new Map<string, unknown>();
  const reads: string[] = [];
  const writes: string[] = [];
  return {
    cache: {
      get<T>(key: string): T | null {
        reads.push(key);
        return (values.get(key) as T | undefined) ?? null;
      },
      set<T>(key: string, payload: T): void {
        writes.push(key);
        values.set(key, payload);
      },
    },
    reads,
    writes,
  };
}

function createMockIssueSource(cache: ResponseCache): OctokitIssueSource {
  const source = new OctokitIssueSource({
    token: 'token',
    host: 'github.com',
    cache,
  });
  (source as any).request = async (operation: () => Promise<unknown>) => {
    try {
      return { status: 'OK', data: await operation() };
    } catch (error) {
      return {
        status: 'NETWORK_ERROR',
        data: null,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };
  return source;
}

interface ScoutFixtureComment {
  body: string;
  author_association: string;
  created_at?: string;
}

function createScoutFixture(options: {
  issueCount?: number;
  policyPath?: string;
  policyContent?: string;
  policyReadFails?: boolean;
  directoryListingTruncated?: boolean;
  comments?: ScoutFixtureComment[];
} = {}) {
  const now = new Date().toISOString();
  const policyReads: string[] = [];
  const directoryReads: string[] = [];
  const issues = Array.from({ length: options.issueCount ?? 1 }, (_, index) => ({
    number: 42 + index,
    title: `Fix TypeScript parser bug ${index}`,
    body: 'Reproducible bug fix for parser input handling in TypeScript.',
    labels: [],
    repository_url: 'https://api.github.com/repos/owner/repo',
    html_url: `https://github.com/owner/repo/issues/${42 + index}`,
    assignee: null,
    assignees: [],
    pull_request: undefined,
    locked: false,
    state: 'open',
    created_at: now,
    updated_at: now,
    user: { login: 'issue-author' },
  }));
  const comments = (options.comments ?? []).map((comment) => ({
    ...comment,
    created_at: comment.created_at ?? now,
    user: { login: 'reviewer' },
  }));

  return {
    policyReads,
    directoryReads,
    client: {
      searchIssues: async () => ({
        items: issues,
        status: 'COMPLETE' as const,
        pagesFetched: 1,
        pagesRequested: 1,
      }),
      listRepoIssues: async () => ({ status: 'OK' as const, data: [] }),
      getRepoDetails: async () => ({
        status: 'OK' as const,
        data: {
          stars: 120,
          defaultBranch: 'main',
          isFork: false,
          isArchived: false,
          description: 'Scout fixture',
        },
      }),
      getRepoDirectoryContentsResult: async (
        _owner: string,
        _repo: string,
        directoryPath: string,
      ) => {
        directoryReads.push(directoryPath);
        if (directoryPath === '' && options.directoryListingTruncated) {
          return {
            status: 'OK' as const,
            data: Array.from({ length: 1000 }, (_, index) => ({
              path: `unrelated-${index}.md`,
              type: 'file' as const,
            })),
          };
        }
        const policyIsPresent =
          options.policyContent !== undefined || options.policyReadFails;
        if (!policyIsPresent) return { status: 'OK' as const, data: [] };

        const policyPath =
          options.policyPath ?? COMMUNITY_GATE_POLICY_PATHS[0];
        const directoryPrefix = directoryPath ? `${directoryPath}/` : '';
        if (!policyPath.startsWith(directoryPrefix)) {
          return { status: 'OK' as const, data: [] };
        }
        const remainingPath = policyPath.slice(directoryPrefix.length);
        const [segment, ...rest] = remainingPath.split('/');
        const entryPath = `${directoryPrefix}${segment}`;
        return rest.length > 0
          ? {
              status: 'OK' as const,
              data: [{ path: entryPath, type: 'dir' as const }],
            }
          : {
              status: 'OK' as const,
              data: [{ path: policyPath, type: 'file' as const }],
            };
      },
      getRepoTextFileResult: async (
        _owner: string,
        _repo: string,
        policyPath: string,
      ) => {
        policyReads.push(policyPath);
        if (options.policyReadFails) {
          return {
            status: 'NETWORK_ERROR' as const,
            data: null,
            error: 'policy read unavailable',
          };
        }
        if (
          policyPath ===
            (options.policyPath ?? COMMUNITY_GATE_POLICY_PATHS[0]) &&
          options.policyContent !== undefined
        ) {
          return { status: 'OK' as const, data: options.policyContent };
        }
        return { status: 'NOT_FOUND' as const, data: null };
      },
      getRepoTextFile: async () => null,
      hasActiveLinkedPr: async () => ({
        status: 'OK' as const,
        data: false,
      }),
      getIssueComments: async () => ({
        status: 'OK' as const,
        data: comments,
      }),
      getIssueLinkedPrsCount: async () => ({
        status: 'OK' as const,
        data: 0,
      }),
    },
  };
}

async function scoutFixture(client: unknown) {
  return scoutOpportunities(
    {
      techStack: ['typescript'],
      focusAreas: ['bugfix'],
      proficiency: 'intermediate',
      minMatchScore: 50,
    },
    { repo: 'owner/repo', minStars: 0 },
    client as any,
  );
}

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

  it('normalizes public and enterprise hosts to their canonical API base URLs', () => {
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

    const apiHostClient = new GitHubClient({ host: 'api.github.com' }, { credentials: fakeCreds, cache: fakeCache });
    const octokitApiHost = (apiHostClient as any).source.octokit;
    expect(octokitApiHost.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com');

    const enterpriseClient = new GitHubClient({ host: 'HTTPS://GitHub.MyCompany.Internal/' }, { credentials: fakeCreds, cache: fakeCache });
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

  it('lists repository directory entries for community policy discovery', async () => {
    const { cache } = createMemoryCache();
    const source = createMockIssueSource(cache);
    const octokit = (source as any).octokit;
    octokit.rest.repos.getContent = async ({ path }: { path: string }) => {
      expect(path).toBe('');
      return {
        data: [
          { type: 'file', path: 'CONTRIBUTING.md' },
          { type: 'dir', path: '.github' },
          { type: 'symlink', path: 'linked-policy' },
        ],
      };
    };

    const result = await source.getRepoDirectoryContentsResult(
      'org',
      'repo',
      '',
    );

    expect(result).toEqual({
      status: 'OK',
      data: [
        { path: 'CONTRIBUTING.md', type: 'file' },
        { path: '.github', type: 'dir' },
      ],
    });
  });

  it('includes maxPages in search and repository issue cache identities', async () => {
    const { cache, writes } = createMemoryCache();
    const source = createMockIssueSource(cache);
    const octokit = (source as any).octokit;
    const searchPages: number[] = [];
    octokit.request = async (_route: string, params: { page: number }) => {
      searchPages.push(params.page);
      return { data: { items: [] } };
    };
    await source.searchIssues('repo:org/repo is:issue', { maxPages: 1 });
    await source.searchIssues('repo:org/repo is:issue', { maxPages: 2 });
    expect(searchPages).toEqual([1, 1]);
    expect(writes.filter((key) => key.startsWith('search_'))).toEqual([
      'search_repo:org/repo is:issue_1',
      'search_repo:org/repo is:issue_2',
    ]);

    octokit.rest.issues.listForRepo = async () => ({ data: [] });
    await source.listRepoIssues('org', 'repo', { maxPages: 1 });
    await source.listRepoIssues('org', 'repo', { maxPages: 2 });
    expect(writes.filter((key) => key.startsWith('repo_issues_'))).toEqual([
      'repo_issues_org_repo_open_updated_desc_all_1',
      'repo_issues_org_repo_open_updated_desc_all_2',
    ]);
  });

  it('returns a failure instead of caching partial repository pagination', async () => {
    const { cache, writes } = createMemoryCache();
    const source = createMockIssueSource(cache);
    const octokit = (source as any).octokit;
    let pageCalls = 0;
    octokit.rest.issues.listForRepo = async ({ page }: { page: number }) => {
      pageCalls += 1;
      if (page === 1) {
        return { data: Array.from({ length: 50 }, (_, index) => ({ number: index + 1 })) };
      }
      throw new Error('page 2 unavailable');
    };

    const result = await source.listRepoIssues('org', 'repo', { maxPages: 2 });
    expect(result.status).toBe('NETWORK_ERROR');
    expect(result.data).toEqual([]);
    expect(result.error).toContain('page 2 unavailable');
    expect(pageCalls).toBe(2);
    expect(writes).toEqual([]);
  });

  it('fails closed when a repository policy read is unavailable', async () => {
    const fixture = createScoutFixture({ policyReadFails: true });
    const opportunities = await scoutFixture(fixture.client);

    expect(opportunities).toEqual([]);
    expect(fixture.policyReads).toEqual([COMMUNITY_GATE_POLICY_PATHS[0]]);
  });

  it('requires maintainer approval for affirmative signals from untrusted or negated comments', async () => {
    const policyContent = 'New issues are auto-closed by default.';
    const nonMaintainer = createScoutFixture({
      policyContent,
      comments: [
        { body: 'Approved to work on this issue.', author_association: 'NONE' },
      ],
    });
    const negatedMaintainer = createScoutFixture({
      policyContent,
      comments: [
        {
          body: 'Not approved yet; wait for maintainer review.',
          author_association: 'MEMBER',
        },
      ],
    });

    const nonMaintainerResult = await scoutFixture(nonMaintainer.client);
    const negatedResult = await scoutFixture(negatedMaintainer.client);
    expect(nonMaintainerResult[0].communityGateStatus).toBe(
      'REQUIRES_MAINTAINER_APPROVAL',
    );
    expect(negatedResult[0].communityGateStatus).toBe(
      'REQUIRES_MAINTAINER_APPROVAL',
    );
  });

  it('accepts a maintainer +1 as affirmative approval', async () => {
    const fixture = createScoutFixture({
      policyContent: 'New issues are auto-closed by default.',
      comments: [{ body: '+1', author_association: 'COLLABORATOR' }],
    });
    const opportunities = await scoutFixture(fixture.client);

    expect(opportunities[0].communityGateStatus).toBe(
      'APPROVED_BY_MAINTAINER',
    );
  });

  it('reads shared repository policy once for concurrent issues', async () => {
    const fixture = createScoutFixture({
      issueCount: 2,
      policyContent: 'New issues are auto-closed by default.',
    });
    const opportunities = await scoutFixture(fixture.client);

    expect(opportunities).toHaveLength(2);
    expect(fixture.policyReads).toEqual([COMMUNITY_GATE_POLICY_PATHS[0]]);
    expect(fixture.directoryReads).toEqual(['']);
  });

  it('discovers nested policy files through directory listings', async () => {
    const policyPath =
      '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md';
    const fixture = createScoutFixture({
      policyPath,
      policyContent: 'New issues are auto-closed by default.',
    });

    const opportunities = await scoutFixture(fixture.client);

    expect(opportunities).toHaveLength(1);
    expect(fixture.directoryReads).toEqual([
      '',
      '.github',
      '.github/PULL_REQUEST_TEMPLATE',
    ]);
    expect(fixture.policyReads).toEqual([policyPath]);
  });

  it('probes configured policy paths when a directory listing reaches the API cap', async () => {
    const policyPath =
      '.github/PULL_REQUEST_TEMPLATE/pull_request_template.md';
    const fixture = createScoutFixture({
      policyPath,
      policyContent: 'New issues are auto-closed by default.',
      directoryListingTruncated: true,
    });

    const opportunities = await scoutFixture(fixture.client);

    expect(opportunities).toHaveLength(1);
    expect(opportunities[0].communityGateStatus).toBe(
      'REQUIRES_MAINTAINER_APPROVAL',
    );
    expect(fixture.directoryReads).toEqual(['']);
    expect(fixture.policyReads).toHaveLength(COMMUNITY_GATE_POLICY_PATHS.length);
    expect(fixture.policyReads).toContain(policyPath);
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
      getRepoDirectoryContentsResult: async () => ({
        status: 'OK' as const,
        data: [],
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
