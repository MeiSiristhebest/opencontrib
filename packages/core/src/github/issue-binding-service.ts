import {
  IssueBindingArtifactSchema,
  type IssueBindingArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import type { ApiResult, ApiStatus, ProviderIssue } from "./types.js";

export interface IssueBindingProvider {
  getIssue(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<ApiResult<ProviderIssue>>;
}

export interface BindIssueInput {
  runId: string;
  repoFullName: string;
  issueNumber: number;
}

export class IssueBindingProviderLookupError extends Error {
  readonly retryable: boolean;

  constructor(readonly status: ApiStatus) {
    super(`IssueBindingProviderError: GitHub issue lookup failed (${status}).`);
    this.name = "IssueBindingProviderLookupError";
    this.retryable =
      status === "RATE_LIMITED" ||
      status === "NETWORK_ERROR" ||
      status === "UNKNOWN_ERROR";
  }
}

/**
 * Creates the only authoritative issue binding used by submission. The
 * selected opportunity is untrusted discovery data; the provider response is
 * the source of truth for issue identity, state, title, and URL.
 */
export class IssueBindingService {
  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly provider: IssueBindingProvider,
  ) {}

  async bind(input: BindIssueInput): Promise<IssueBindingArtifact> {
    const run = this.runManager.getRun(input.runId);
    if (!run) throw new Error(`Contribution run ${input.runId} does not exist`);
    if (run.manifest.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase()) {
      throw new Error(
        "IssueBindingTargetMismatchError: provider issue target does not match the canonical run repository.",
      );
    }
    if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new Error("IssueBindingInputError: issueNumber must be a positive integer.");
    }

    const existing = IssueBindingArtifactSchema.safeParse(run.artifacts.issueBinding);

    const repoMatch = /^([^/\s]+)\/([^/\s]+)$/.exec(input.repoFullName);
    if (!repoMatch) {
      throw new Error(
        "IssueBindingInputError: repoFullName must be exactly owner/repo.",
      );
    }
    const [, owner, repo] = repoMatch;
    let response: ApiResult<ProviderIssue>;
    try {
      response = await this.provider.getIssue(owner, repo, input.issueNumber);
    } catch {
      throw new IssueBindingProviderLookupError("NETWORK_ERROR");
    }
    if (response.status !== "OK" || !response.data) {
      throw new IssueBindingProviderLookupError(
        response.status === "OK" ? "UNKNOWN_ERROR" : response.status,
      );
    }
    const issue = response.data;
    if (issue.number !== input.issueNumber || issue.state !== "open") {
      throw new Error(
        "IssueBindingProviderError: provider issue identity or open state does not match the selected opportunity.",
      );
    }
    const expectedIssueUrl =
      `https://github.com/${input.repoFullName}/issues/${input.issueNumber}`;
    if (
      !issue.title.trim() ||
      issue.htmlUrl.toLowerCase() !== expectedIssueUrl.toLowerCase()
    ) {
      throw new Error(
        "IssueBindingProviderError: provider returned incomplete or mismatched issue identity data.",
      );
    }

    if (existing.success) {
      if (
        existing.data.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase() ||
        existing.data.providerIssueId !== issue.number ||
        existing.data.state !== issue.state ||
        existing.data.title !== issue.title ||
        existing.data.issueUrl !== issue.htmlUrl
      ) {
        throw new Error(
          "IssueBindingImmutableError: the stored binding does not match the current provider response.",
        );
      }
      return existing.data;
    }

    const artifact = IssueBindingArtifactSchema.parse({
      runId: input.runId,
      provider: "github",
      repoFullName: input.repoFullName,
      providerIssueId: issue.number,
      state: issue.state,
      title: issue.title,
      issueUrl: issue.htmlUrl,
      providerVerified: true,
      verifiedAt: new Date().toISOString(),
    });
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "issue_binding",
      artifact as any,
    );
    return artifact;
  }
}
