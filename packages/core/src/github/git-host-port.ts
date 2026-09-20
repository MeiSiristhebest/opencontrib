import type {
  IssueOrOpportunity,
  RepoDetails,
} from "../discovery/github-client.js";
import type {
  GitTreeEntry,
  PrSubmissionOptions,
  PrSubmissionResult,
} from "./contribution-pr-service.js";

export interface GitHostPort {
  getRepoDetails(owner: string, repo: string): Promise<RepoDetails>;
  listOpenIssues(
    owner: string,
    repo: string,
    labels?: string[],
  ): Promise<IssueOrOpportunity[]>;
  /**
   * Provider writes are deliberately not part of the read-only host port.
   * SubmissionPort/GitHubSubmissionService owns that capability in the
   * trusted composition root.
   */
}

export type { GitTreeEntry, PrSubmissionOptions, PrSubmissionResult };
