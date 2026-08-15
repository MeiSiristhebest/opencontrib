import type { IssueOrOpportunity, RepoDetails } from '../discovery/github-client.js';
import type { GitTreeEntry, PrSubmissionOptions, PrSubmissionResult } from './contribution-pr-service.js';

export interface GitHostPort {
  getRepoDetails(owner: string, repo: string): Promise<RepoDetails>;
  listOpenIssues(owner: string, repo: string, labels?: string[]): Promise<IssueOrOpportunity[]>;
  submitPullRequest(options: PrSubmissionOptions): Promise<PrSubmissionResult>;
}

export type { GitTreeEntry, PrSubmissionOptions, PrSubmissionResult };
