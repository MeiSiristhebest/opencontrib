import {
  SubmissionIntentArtifactSchema,
  type SubmissionArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { GitHubSubmissionService } from "./submission-service.js";

export interface TrustedSubmissionRequest {
  runId: string;
  expectedIntentSha256?: string;
}

/**
 * Host-side broker facade for the provider-write operation.
 *
 * The agent-facing CLI/MCP client talks to this facade through a separately
 * deployed transport. The facade intentionally accepts only a run ID and
 * re-reads canonical artifacts; callers cannot supply provider options or a
 * GitHub credential.
 */
export class TrustedSubmissionBroker {
  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly submissionService: GitHubSubmissionService,
  ) {}

  async handle(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({ message: "Only POST is supported." }),
        { status: 405, headers: { "content-type": "application/json" } },
      );
    }
    try {
      const payload = (await request.json()) as Record<string, unknown>;
      if (typeof payload.runId !== "string") {
        throw new Error("SubmissionBrokerRequestError: runId is required.");
      }
      const artifact = await this.submit({
        runId: payload.runId,
        expectedIntentSha256:
          typeof payload.expectedIntentSha256 === "string"
            ? payload.expectedIntentSha256
            : undefined,
      });
      return new Response(JSON.stringify({ submissionArtifact: artifact }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Broker request rejected.";
      const status = message.includes("RequestError") ? 400 : 409;
      return new Response(JSON.stringify({ message }), {
        status,
        headers: { "content-type": "application/json" },
      });
    }
  }

  async submit(request: TrustedSubmissionRequest): Promise<SubmissionArtifact> {
    if (!request.runId.trim()) {
      throw new Error("SubmissionBrokerRequestError: runId is required.");
    }
    const run = this.runManager.getRun(request.runId);
    const intent = SubmissionIntentArtifactSchema.safeParse(
      run?.artifacts.submissionIntent,
    );
    if (!intent.success) {
      throw new Error(
        "SubmissionBrokerRejectedError: canonical SubmissionIntentArtifact is missing or invalid.",
      );
    }
    if (
      request.expectedIntentSha256 !== undefined &&
      request.expectedIntentSha256 !== intent.data.intentSha256
    ) {
      throw new Error(
        "SubmissionIntentMismatchError: requested intent does not match the canonical run.",
      );
    }

    const result = await this.submissionService.submit(request.runId);
    if (result.submissionArtifact.intentSha256 !== intent.data.intentSha256) {
      throw new Error(
        "SubmissionBrokerIntegrityError: provider result is not bound to the canonical intent.",
      );
    }
    return result.submissionArtifact;
  }
}
