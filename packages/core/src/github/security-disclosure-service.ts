import {
  SecurityDisclosureArtifactSchema,
  SecurityDisclosureEventArtifactSchema,
  type SecurityDisclosureArtifact,
  type SecurityDisclosureEventArtifact,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import type { ApiResult } from "./types.js";

export type SecurityDisclosureStage =
  | "CHANNEL_DISCOVERED"
  | "DISCLOSED"
  | "ACKNOWLEDGED"
  | "PUBLIC_FIX_AUTHORIZED";

export interface ProviderSecurityDisclosureStatus {
  stage: SecurityDisclosureStage;
  providerEventId: string;
  publicDisclosureAllowed: boolean;
}

export interface SecurityPolicyProvider {
  getRepoTextFile(owner: string, repo: string, path: string): Promise<string | null>;
  /** Optional host/provider integration for append-only lifecycle events. */
  getDisclosureStatus?(
    owner: string,
    repo: string,
    runId: string,
  ): Promise<ApiResult<ProviderSecurityDisclosureStatus>>;
}

export interface VerifySecurityDisclosureInput {
  runId: string;
  repoFullName: string;
}

/**
 * Verifies the repository's private security channel through the provider and
 * records a fail-closed disclosure decision. Discovering SECURITY.md never
 * grants permission to publish a public issue or pull request.
 */
export class SecurityDisclosureService {
  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly provider: SecurityPolicyProvider,
  ) {}

  async verifyPrivateChannel(
    input: VerifySecurityDisclosureInput,
  ): Promise<SecurityDisclosureArtifact> {
    const run = this.runManager.getRun(input.runId);
    if (!run) throw new Error(`Contribution run ${input.runId} does not exist`);
    if (run.manifest.repoFullName.toLowerCase() !== input.repoFullName.toLowerCase()) {
      throw new Error(
        "SecurityDisclosureTargetMismatchError: repository does not match the canonical run.",
      );
    }

    const existing = SecurityDisclosureArtifactSchema.safeParse(
      run.artifacts.securityDisclosure,
    );

    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error("SecurityDisclosureInputError: repoFullName must be owner/repo.");
    }

    let policyContent: string | null = null;
    for (const policyPath of ["SECURITY.md", ".github/SECURITY.md"]) {
      policyContent = await this.provider.getRepoTextFile(owner, repo, policyPath);
      if (policyContent) break;
    }
    if (!policyContent || !/(?:private|security|vulnerabilit|contact)/i.test(policyContent)) {
      throw new Error(
        "SecurityDisclosureProviderError: provider did not return a verifiable private security channel.",
      );
    }

    const artifact = SecurityDisclosureArtifactSchema.parse({
      runId: input.runId,
      provider: "github",
      repoFullName: input.repoFullName,
      channel: "github_security_policy",
      channelUrl: `https://github.com/${input.repoFullName}/security/policy`,
      providerVerified: true,
      publicDisclosureAllowed: false,
      stage: "CHANNEL_DISCOVERED",
      verifiedAt: new Date().toISOString(),
    });
    if (existing.success) {
      if (
        existing.data.runId !== artifact.runId ||
        existing.data.provider !== artifact.provider ||
        existing.data.repoFullName.toLowerCase() !== artifact.repoFullName.toLowerCase() ||
        existing.data.channel !== artifact.channel ||
        existing.data.channelUrl !== artifact.channelUrl ||
        existing.data.providerVerified !== true
      ) {
        throw new Error(
          "SecurityDisclosureImmutableError: the stored disclosure record does not match the current provider policy.",
        );
      }
      return existing.data;
    }
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "security_disclosure",
      artifact as any,
    );
    return artifact;
  }

  /**
   * Reconcile a provider-owned disclosure lifecycle into an append-only event.
   * The provider must supply the event ID and authorization state; local
   * callers cannot promote a disclosure by editing the run bundle.
   */
  async syncLifecycle(
    input: VerifySecurityDisclosureInput,
  ): Promise<SecurityDisclosureEventArtifact | null> {
    const base = await this.verifyPrivateChannel(input);
    if (!this.provider.getDisclosureStatus) {
      throw new Error(
        "SecurityDisclosureProviderError: provider does not expose a disclosure lifecycle status endpoint.",
      );
    }
    const [owner, repo] = input.repoFullName.split("/");
    if (!owner || !repo) {
      throw new Error("SecurityDisclosureInputError: repoFullName must be owner/repo.");
    }
    const response = await this.provider.getDisclosureStatus(
      owner,
      repo,
      input.runId,
    );
    if (response.status !== "OK" || !response.data) {
      throw new Error(
        `SecurityDisclosureProviderError: disclosure lifecycle lookup failed (${response.status}).`,
      );
    }
    const order: Record<SecurityDisclosureStage, number> = {
      CHANNEL_DISCOVERED: 0,
      DISCLOSED: 1,
      ACKNOWLEDGED: 2,
      PUBLIC_FIX_AUTHORIZED: 3,
    };
    const rawStatus = response.data as unknown;
    if (!rawStatus || typeof rawStatus !== "object") {
      throw new Error(
        "SecurityDisclosureProviderError: lifecycle status payload is invalid.",
      );
    }
    const statusRecord = rawStatus as Record<string, unknown>;
    if (
      typeof statusRecord.stage !== "string" ||
      !Object.prototype.hasOwnProperty.call(order, statusRecord.stage) ||
      typeof statusRecord.providerEventId !== "string" ||
      typeof statusRecord.publicDisclosureAllowed !== "boolean"
    ) {
      throw new Error(
        "SecurityDisclosureProviderError: lifecycle status payload is invalid.",
      );
    }
    const stage = statusRecord.stage as SecurityDisclosureStage;
    const providerEventId = statusRecord.providerEventId;
    const publicDisclosureAllowed = statusRecord.publicDisclosureAllowed;
    if (stage === "CHANNEL_DISCOVERED") return null;
    if (!providerEventId.trim()) {
      throw new Error(
        "SecurityDisclosureProviderError: lifecycle status is missing providerEventId.",
      );
    }

    const run = this.runManager.getRun(input.runId);
    const events = (run?.artifacts.securityDisclosureEvents ?? [])
      .map((event) => SecurityDisclosureEventArtifactSchema.safeParse(event))
      .filter((result): result is { success: true; data: SecurityDisclosureEventArtifact } => result.success)
      .map((result) => result.data);
    const latest = events[events.length - 1];
    if (latest && order[stage] < order[latest.stage]) {
      throw new Error(
        "SecurityDisclosureLifecycleError: provider lifecycle moved backwards; refusing to append a downgrade.",
      );
    }
    if (latest?.providerEventId === providerEventId) {
      if (
        latest.stage === stage &&
        latest.publicDisclosureAllowed === publicDisclosureAllowed
      ) {
        return latest;
      }
      throw new Error(
        "SecurityDisclosureLifecycleError: provider reused an event ID for a different lifecycle state.",
      );
    }
    if (latest && order[stage] === order[latest.stage]) {
      throw new Error(
        "SecurityDisclosureLifecycleError: a lifecycle stage already exists with a different provider event ID.",
      );
    }
    if (latest && order[stage] !== order[latest.stage] + 1) {
      throw new Error(
        "SecurityDisclosureLifecycleError: lifecycle stages must advance through DISCLOSED, ACKNOWLEDGED, and PUBLIC_FIX_AUTHORIZED in order.",
      );
    }

    const event = SecurityDisclosureEventArtifactSchema.parse({
      runId: input.runId,
      provider: "github",
      repoFullName: base.repoFullName,
      stage,
      providerEventId,
      providerVerified: true,
      publicDisclosureAllowed,
      recordedAt: new Date().toISOString(),
    });
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "security_disclosure_event",
      event as any,
    );
    return event;
  }

  assertPublicSubmissionAllowed(runId: string): void {
    const run = this.runManager.getRun(runId);
    if (!run) throw new Error(`Contribution run ${runId} does not exist`);
    const workspace = run.artifacts.workspace as
      | { communityGate?: { policy?: { privateVulnerabilityDisclosure?: boolean } } }
      | undefined;
    if (!workspace?.communityGate?.policy?.privateVulnerabilityDisclosure) return;

    const disclosure = SecurityDisclosureArtifactSchema.safeParse(
      run.artifacts.securityDisclosure,
    );
    if (!disclosure.success || disclosure.data.providerVerified !== true) {
      throw new Error(
        "SecurityDisclosureRequiredError: private disclosure policy requires provider-verified security channel evidence before submission.",
      );
    }
    const events = (run.artifacts.securityDisclosureEvents ?? [])
      .map((event) => SecurityDisclosureEventArtifactSchema.safeParse(event))
      .filter((result): result is { success: true; data: SecurityDisclosureEventArtifact } => result.success)
      .map((result) => result.data);
    const latest = events[events.length - 1];
    if (latest?.stage !== "PUBLIC_FIX_AUTHORIZED") {
      throw new Error(
        "PublicDisclosureBlockedError: public submission requires append-only DISCLOSED -> ACKNOWLEDGED -> PUBLIC_FIX_AUTHORIZED provider events; the initial private channel record is not authorization.",
      );
    }
    if (latest.publicDisclosureAllowed !== true) {
      throw new Error(
        "PublicDisclosureBlockedError: repository requires private vulnerability disclosure; public submission is not authorized.",
      );
    }
  }
}
