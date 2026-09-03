/**
 * IssueSource port — the seam that decouples issue discovery/scouting from the
 * concrete GitHub (or any forge) client. The domain scouting logic depends only
 * on this port, so it can be exercised with `InMemoryIssueSource` (zero network).
 */

export interface DiscoveredIssue {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  state?: 'open' | 'closed';
  url?: string;
}

export interface IssueQuery {
  state?: 'open' | 'closed' | 'all';
  labels?: string[];
  limit?: number;
}

export interface IssueSource {
  listIssues(repoFullName: string, query?: IssueQuery): Promise<DiscoveredIssue[]>;
}
