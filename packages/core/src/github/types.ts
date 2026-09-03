/**
 * Shared types for the GitHub adapter layer.
 *
 * Extracted from the monolithic `github-client.ts` so that the
 * Credentials / Cache / Retry / IssueSource layers can each import the
 * types they need without creating an import cycle back into the composing
 * client. The composing `GitHubClient` re-exports these for backward
 * compatibility (callers that imported them from `github-client.js`).
 */

export type ApiStatus =
  | 'OK'
  | 'NOT_FOUND'
  | 'RATE_LIMITED'
  | 'FORBIDDEN'
  | 'NETWORK_ERROR'
  | 'UNKNOWN_ERROR';

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

export type IssueOrOpportunity = any;

export interface GitHubClientOptions {
  token?: string;
  cacheTtlMs?: number;
  host?: string;
  apiVersion?: string;
}
