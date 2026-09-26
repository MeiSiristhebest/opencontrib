import {
  IssueBindingArtifactSchema,
  type IssueBindingArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { IssueBindingService, type IssueBindingProvider } from "./issue-binding-service.js";
import type { ApiResult, ProviderIssue } from "./types.js";

export interface IssueCreationProvider extends IssueBindingProvider {
  createIssue(
    owner: string,
    repo: string,
    input: { title: string; body: string },
  ): Promise<ApiResult<ProviderIssue>>;
}

export interface CreateIssueInput {
  runId: string;
  repoFullName: string;
  title: string;
  body: string;
}

/**
 * Trusted provider-backed Issue creation. Creation and binding are one
 * operation: a provider response is immediately re-read and sealed as the
 * run's IssueBindingArtifact. Callers never get to choose the resulting ID.
 */
export class IssueCreationService {
  private readonly bindingService: IssueBindingService;

  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly provider: IssueCreationProvider,
  ) {
    this.bindingService = new IssueBindingService(runManager, provider);
  }

  async createAndBind(input: CreateIssueInput): Promise<IssueBindingArtifact> {
    const run = this.runManager.getRun(input.runId);
    if (!run) throw new Error(`Contribution run ${input.runId} does not exist`);
    if (!/^[^/\s]+\/[^/\s]+$/.test(input.repoFullName)) {
      throw new Error(
        "IssueCreationInputError: repoFullName must be exactly owner/repo.",
      );
    }
    if (
      run.manifest.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase()
    ) {
      throw new Error(
        "IssueCreationTargetMismatchError: issue target does not match the canonical run repository.",
      );
    }
    if (!input.title.trim() || !input.body.trim()) {
      throw new Error(
        "IssueCreationInputError: title and body are required for provider-backed issue creation.",
      );
    }

    const existing = IssueBindingArtifactSchema.safeParse(
      run.artifacts.issueBinding,
    );
    if (existing.success) {
      return this.bindingService.bind({
        runId: input.runId,
        repoFullName: input.repoFullName,
        issueNumber: existing.data.providerIssueId,
      });
    }

    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error("IssueCreationInputError: repoFullName must be owner/repo.");
    }
    const response = await this.provider.createIssue(owner, repo, {
      title: input.title.trim(),
      body: input.body,
    });
    if (response.status !== "OK" || !response.data) {
      throw new Error(
        `IssueCreationProviderError: provider issue creation failed (${response.status}).`,
      );
    }
    if (!Number.isInteger(response.data.number) || response.data.number <= 0) {
      throw new Error(
        "IssueCreationProviderError: provider returned an invalid issue number.",
      );
    }
    return this.bindingService.bind({
      runId: input.runId,
      repoFullName: input.repoFullName,
      issueNumber: response.data.number,
    });
  }
}
