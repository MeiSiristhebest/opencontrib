import {
  CommunityGateSnapshotSchema,
  IssueBindingArtifactSchema,
  type IssueBindingArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import {
  pinIssueNumberFromProviderIssue,
  saveCanonicalArtifact,
} from "../run/canonical-writer.js";
import { hashCommunityGateSnapshot } from "../governance/community-gate.js";
import { requiresPrivateVulnerabilityDisclosure } from "../submission/submission-route.js";
import { canonicalGitHubIssueUrl } from "./issue-url.js";
import { mapErrorToApiStatus } from "./retry-strategy.js";
import type { ApiResult, ApiStatus, ProviderIssue } from "./types.js";

export interface IssueBindingProvider {
  /** Host whose API returned the issue; omitted providers use github.com. */
  readonly issueUrlHost?: string;
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

/** Return a positive issue number for public numeric identifiers. */
export function parsePublicIssueNumber(
  value: string | number,
): number | undefined {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(
        "IssueBindingInputError: issue number must be a positive safe integer.",
      );
    }
    return value;
  }
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return undefined;
  const issueNumber = Number(normalized);
  if (!Number.isSafeInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(
      "IssueBindingInputError: issue number must be a positive safe integer.",
    );
  }
  return issueNumber;
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

  /** Validate the public route before a caller creates a provider issue. */
  assertPublicIssueCreationAllowed(input: {
    runId: string;
    repoFullName: string;
  }): void {
    const run = this.runManager.getRun(input.runId);
    if (!run) throw new Error(`Contribution run ${input.runId} does not exist`);
    this.assertPublicIssueTarget(run, input.repoFullName);
  }

  async bind(input: BindIssueInput): Promise<IssueBindingArtifact> {
    const run = this.getPublicRun(input);

    const existing = IssueBindingArtifactSchema.safeParse(run.artifacts.issueBinding);
    const issue = await this.fetchProviderIssue(input);

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
      pinIssueNumberFromProviderIssue(
        this.runManager,
        input.runId,
        issue,
        this.provider.issueUrlHost,
      );
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
    pinIssueNumberFromProviderIssue(
      this.runManager,
      input.runId,
      issue,
      this.provider.issueUrlHost,
    );
    return artifact;
  }

  /** Recheck a stored binding against the provider without writing run state. */
  async verify(input: BindIssueInput): Promise<IssueBindingArtifact> {
    return (await this.verifyBoundIssue(input)).binding;
  }

  /** Return provider issue content only after the canonical binding is rechecked. */
  async verifyIssueContext(
    input: BindIssueInput,
  ): Promise<{
    binding: IssueBindingArtifact;
    issue: ProviderIssue & { body: string; labels: string[] };
  }> {
    const verified = await this.verifyBoundIssue(input);
    if (
      typeof verified.issue.body !== "string" ||
      !Array.isArray(verified.issue.labels) ||
      !verified.issue.labels.every((label) => typeof label === "string")
    ) {
      throw new Error(
        "IssueBindingProviderError: provider issue context is missing a string body or labels.",
      );
    }
    return {
      binding: verified.binding,
      issue: {
        ...verified.issue,
        body: verified.issue.body,
        labels: verified.issue.labels,
      },
    };
  }

  private async verifyBoundIssue(
    input: BindIssueInput,
  ): Promise<{ binding: IssueBindingArtifact; issue: ProviderIssue }> {
    const run = this.getPublicRun(input);
    const binding = IssueBindingArtifactSchema.safeParse(
      run.artifacts.issueBinding,
    );
    if (
      !binding.success ||
      binding.data.runId !== input.runId ||
      binding.data.provider !== "github" ||
      binding.data.repoFullName.toLowerCase() !==
        input.repoFullName.toLowerCase() ||
      binding.data.providerIssueId !== input.issueNumber ||
      run.manifest.issueNumber !== input.issueNumber ||
      binding.data.providerVerified !== true
    ) {
      throw new Error(
        `IssueBindingRequiredError: run ${input.runId} has no canonical provider binding for issue #${input.issueNumber}.`,
      );
    }

    const issue = await this.fetchProviderIssue(input);
    if (
      binding.data.state !== issue.state ||
      binding.data.title !== issue.title ||
      binding.data.issueUrl.toLowerCase() !== issue.htmlUrl.toLowerCase()
    ) {
      throw new Error(
        "IssueBindingProviderError: current provider issue does not match the stored binding.",
      );
    }
    return { binding: binding.data, issue };
  }

  private getPublicRun(input: BindIssueInput) {
    const run = this.runManager.getRun(input.runId);
    if (!run) throw new Error(`Contribution run ${input.runId} does not exist`);
    this.assertPublicIssueTarget(run, input.repoFullName);
    if (!Number.isSafeInteger(input.issueNumber) || input.issueNumber <= 0) {
      throw new Error("IssueBindingInputError: issueNumber must be a positive safe integer.");
    }
    if (
      run.manifest.issueNumber !== undefined &&
      run.manifest.issueNumber !== input.issueNumber
    ) {
      throw new Error(
        `IssueBindingTargetMismatchError: run is already bound to issue #${run.manifest.issueNumber}.`,
      );
    }
    return run;
  }

  private assertPublicIssueTarget(
    run: NonNullable<ReturnType<ContributionRunManager["getRun"]>>,
    repoFullName: string,
  ): void {
    const workspace = run.artifacts.workspace as
      | {
          baseCommitSha?: unknown;
          communityGate?: unknown;
          communityGateSha256?: unknown;
        }
      | undefined;
    const communityGate = CommunityGateSnapshotSchema.safeParse(
      workspace?.communityGate,
    );
    if (!communityGate.success) {
      throw new Error(
        "IssueBindingPolicyUnavailableError: issue binding requires a valid canonical workspace policy snapshot.",
      );
    }
    if (requiresPrivateVulnerabilityDisclosure(run)) {
      throw new Error(
        "PrivateIssueBindingForbiddenError: private disclosure runs cannot bind a public issue.",
      );
    }
    if (
      typeof workspace?.baseCommitSha !== "string" ||
      communityGate.data.sourceCommitSha !== workspace.baseCommitSha ||
      typeof workspace.communityGateSha256 !== "string" ||
      hashCommunityGateSnapshot(communityGate.data) !==
        workspace.communityGateSha256
    ) {
      throw new Error(
        "IssueBindingPolicyUnavailableError: community gate snapshot does not match its recorded hash and workspace base commit.",
      );
    }
    if (run.manifest.repoFullName.toLowerCase() !== repoFullName.toLowerCase()) {
      throw new Error(
        "IssueBindingTargetMismatchError: provider issue target does not match the canonical run repository.",
      );
    }
    if (!/^([^/\s]+)\/([^/\s]+)$/.test(repoFullName)) {
      throw new Error(
        "IssueBindingInputError: repoFullName must be exactly owner/repo.",
      );
    }
  }

  private async fetchProviderIssue(
    input: BindIssueInput,
  ): Promise<ProviderIssue> {
    const [, owner, repo] = /^([^/\s]+)\/([^/\s]+)$/.exec(
      input.repoFullName,
    )!;
    let response: ApiResult<ProviderIssue>;
    try {
      response = await this.provider.getIssue(owner, repo, input.issueNumber);
    } catch (error) {
      throw new IssueBindingProviderLookupError(
        mapErrorToApiStatus(error).status,
      );
    }
    if (response.status !== "OK" || !response.data) {
      throw new IssueBindingProviderLookupError(
        response.status === "OK" ? "UNKNOWN_ERROR" : response.status,
      );
    }
    const issue = response.data;
    const expectedIssueUrl = canonicalGitHubIssueUrl(
      this.provider.issueUrlHost,
      input.repoFullName,
      input.issueNumber,
    );
    if (
      issue.number !== input.issueNumber ||
      issue.state !== "open" ||
      !issue.title.trim() ||
      issue.htmlUrl.toLowerCase() !== expectedIssueUrl.toLowerCase()
    ) {
      throw new Error(
        "IssueBindingProviderError: provider returned mismatched issue identity, state, title, or URL.",
      );
    }
    return issue;
  }
}
