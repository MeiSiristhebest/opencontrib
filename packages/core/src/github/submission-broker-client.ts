import { SubmissionArtifactSchema, type SubmissionArtifact } from "../contracts/schemas.js";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface RemoteSubmissionBrokerOptions {
  /** Exact broker endpoint; no GitHub credential is accepted or stored here. */
  endpoint?: string;
  fetchImpl?: FetchLike;
}

/** The only submission surface exposed to an agent-facing CLI/MCP client. */
export class RemoteSubmissionBrokerClient {
  private readonly endpoint: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: RemoteSubmissionBrokerOptions = {}) {
    const endpoint = options.endpoint || process.env.OPENCONTRIB_SUBMISSION_BROKER_URL;
    if (!endpoint) {
      throw new Error(
        "SubmissionBrokerRequiredError: agent-facing submission requires an external trusted submission broker. Set OPENCONTRIB_SUBMISSION_BROKER_URL.",
      );
    }
    let parsed: URL;
    try {
      parsed = new URL(endpoint);
    } catch {
      throw new Error("SubmissionBrokerConfigurationError: broker endpoint must be a valid URL.");
    }
    if (parsed.protocol !== "https:" && parsed.hostname !== "localhost" && parsed.hostname !== "127.0.0.1") {
      throw new Error(
        "SubmissionBrokerConfigurationError: broker endpoint must use HTTPS except for loopback development.",
      );
    }
    this.endpoint = parsed.toString();
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async submit(runId: string, expectedIntentSha256?: string): Promise<SubmissionArtifact> {
    if (!runId.trim()) {
      throw new Error("SubmissionBrokerRequestError: runId is required.");
    }
    const response = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ runId, expectedIntentSha256 }),
    });

    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new Error(
        `SubmissionBrokerProtocolError: broker returned a non-JSON response (HTTP ${response.status}).`,
      );
    }
    if (!response.ok) {
      const message =
        typeof payload === "object" && payload !== null && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `HTTP ${response.status}`;
      throw new Error(`SubmissionBrokerRejectedError: ${message}`);
    }

    const result = SubmissionArtifactSchema.safeParse(
      typeof payload === "object" && payload !== null && "submissionArtifact" in payload
        ? (payload as { submissionArtifact?: unknown }).submissionArtifact
        : payload,
    );
    if (!result.success) {
      throw new Error(
        "SubmissionBrokerProtocolError: trusted broker response did not contain a valid verified SubmissionArtifact.",
      );
    }
    return result.data as SubmissionArtifact;
  }
}
