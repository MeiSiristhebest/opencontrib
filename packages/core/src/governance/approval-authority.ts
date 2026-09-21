import type {
  ApprovalArtifact,
  CommunityGateSnapshot,
} from "../contracts/schemas.js";

export interface ApprovalAuthorityRequest {
  runId: string;
  intentSha256: string;
  communityGate: CommunityGateSnapshot;
  communityGateSha256: string;
}

export interface ApprovalAuthorityDecision {
  approvedBy: string;
  approvalMode: "explicit_human" | "policy_waived";
  signingKeyId: string;
  signature: string;
}

/** Public-key verification only; the signing key must remain in the host. */
export interface ApprovalArtifactVerifier {
  verifyApproval(artifact: ApprovalArtifact): boolean;
}

export interface HostApprovalPort extends ApprovalArtifactVerifier {
  issueApproval(
    request: ApprovalAuthorityRequest,
  ): ApprovalAuthorityDecision | Promise<ApprovalAuthorityDecision>;
}

const authorityBrand = Symbol("opencontrib.trustedApprovalAuthority");

/** Opaque capability; the brand is intentionally not exported. */
export type TrustedApprovalAuthority = HostApprovalPort & {
  readonly [authorityBrand]: true;
};

/**
 * Adapter used only by a trusted host/composition root. Agent-facing CLI/MCP
 * code has no way to construct this capability and therefore cannot mint an
 * explicit_human or policy_waived ApprovalArtifact.
 */
export function createTrustedApprovalAuthority(
  host: HostApprovalPort,
): TrustedApprovalAuthority {
  if (!host || typeof host.issueApproval !== "function") {
    throw new Error("ApprovalAuthorityError: trusted host port is required.");
  }
  return Object.freeze({
    [authorityBrand]: true as const,
    issueApproval: (request: ApprovalAuthorityRequest) =>
      host.issueApproval(request),
    verifyApproval: (artifact: ApprovalArtifact) =>
      host.verifyApproval(artifact),
  }) as TrustedApprovalAuthority;
}

export function isTrustedApprovalAuthority(
  value: unknown,
): value is TrustedApprovalAuthority {
  return Boolean(
    value &&
    typeof (value as any).issueApproval === "function" &&
    (value as any)[authorityBrand] === true,
  );
}

export type ApprovalAuthorityArtifact = Pick<
  ApprovalArtifact,
  "approvedBy" | "approvalMode"
>;
