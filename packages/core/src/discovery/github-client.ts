import { EnvConfigGhCliCredentialsProvider } from '../github/credentials-provider.js';
import { FileResponseCache } from '../github/response-cache.js';
import { OctokitIssueSource } from '../github/octokit-issue-source.js';
import { CredentialsProvider } from '../ports/credentials-provider.port.js';
import { ResponseCache } from '../ports/response-cache.port.js';
import type {
  ApiResult,
  ApiStatus,
  GitHubClientOptions,
  IssueOrOpportunity,
  RepoDetails,
  SearchIssuesResult,
} from '../github/types.js';

// Re-export the shared types so existing callers that imported them from
// `discovery/github-client.js` keep working unchanged.
export type {
  ApiResult,
  ApiStatus,
  GitHubClientOptions,
  IssueOrOpportunity,
  RepoDetails,
  SearchIssuesResult,
} from '../github/types.js';

export interface GitHubClientDependencies {
  credentials?: CredentialsProvider;
  cache?: ResponseCache;
}

/**
 * GitHub API adapter (hexagonal port implementation).
 *
 * Refactored per the architecture review (§16 stage 4) from a single
 * ~460-line god class into four composed, independently-testable and swappable
 * layers:
 *   - Credentials : {@link CredentialsProvider} (token resolution)
 *   - Cache       : {@link ResponseCache} (file-backed response cache)
 *   - Retry       : `requestWithRetry` in `retry-strategy.ts`
 *   - IssueSource : {@link OctokitIssueSource} (Octokit domain operations)
 *
 * The public surface below is byte-for-byte compatible with the previous
 * monolith; only the internal wiring changed.
 */
export class GitHubClient {
  private credentials: CredentialsProvider;
  private cache: ResponseCache;
  private source: OctokitIssueSource;

  constructor(options: GitHubClientOptions = {}, deps: GitHubClientDependencies = {}) {
    const host = options.host || 'github.com';
    const apiVersion = options.apiVersion || '2022-11-28';

    this.credentials = deps.credentials ?? new EnvConfigGhCliCredentialsProvider(options.token);
    this.cache =
      deps.cache ??
      new FileResponseCache({
        host,
        apiVersion,
        tokenScope: this.credentials.getTokenScope(),
        ttlMs: options.cacheTtlMs,
      });
    this.source = new OctokitIssueSource({
      token: this.credentials.getToken(),
      host,
      cache: this.cache,
    });
  }

  /** Unified resilient request wrapper with exponential backoff and jitter. */
  requestWithRetry<T>(
    operation: () => Promise<T>,
    maxRetries = 3,
  ): Promise<ApiResult<T>> {
    return this.source.requestWithRetry(operation, maxRetries);
  }

  /** Searches GitHub issues with explicit COMPLETE / PARTIAL / FAILED status taxonomy. */
  searchIssues(
    query: string,
    options: { maxPages?: number; refresh?: boolean } = {},
  ): Promise<SearchIssuesResult> {
    return this.source.searchIssues(query, options);
  }

  /** Paged comments retrieval with central retry wrapper and rich error status. */
  getIssueComments(
    owner: string,
    repo: string,
    issue_number: number,
    maxPages = 2,
  ): Promise<ApiResult<any[]>> {
    return this.source.getIssueComments(owner, repo, issue_number, maxPages);
  }

  getRepoTextFile(owner: string, repo: string, path: string): Promise<string | null> {
    return this.source.getRepoTextFile(owner, repo, path);
  }

  listWorkflowFiles(owner: string, repo: string): Promise<Array<{ path: string; content: string }>> {
    return this.source.listWorkflowFiles(owner, repo);
  }

  /** Fetches real repository metadata. Fail-Safe: never returns fake mock data on error. */
  getRepoDetails(owner: string, repo: string): Promise<ApiResult<RepoDetails>> {
    return this.source.getRepoDetails(owner, repo);
  }

  /** Checks unique active open linked PRs via timeline events. */
  getIssueLinkedPrsCount(
    owner: string,
    repo: string,
    issue_number: number,
    maxPages = 2,
  ): Promise<ApiResult<number>> {
    return this.source.getIssueLinkedPrsCount(owner, repo, issue_number, maxPages);
  }

  /** High-level domain contract for checking existence of active linked PRs. */
  hasActiveLinkedPr(
    owner: string,
    repo: string,
    issue_number: number,
  ): Promise<ApiResult<boolean>> {
    return this.source.hasActiveLinkedPr(owner, repo, issue_number);
  }

  /** Submit Pull Request adhering to GitHostPort contract. */
  async submitPullRequest(options: any): Promise<any> {
    const { ContributionPrService } = await import('../github/contribution-pr-service.js');
    const prService = new ContributionPrService(this);
    return prService.submitPullRequest(options);
  }
}
