import {
  createPrivateKey,
  createPublicKey,
  sign as signMessage,
  verify as verifyMessage,
  type KeyObject,
} from "node:crypto";
import type { ApprovalArtifact } from "../contracts/schemas.js";
import type { MaintainerGateEvidence } from "../contracts/schemas.js";
import type {
  ApprovalArtifactVerifier,
  ApprovalAuthorityDecision,
  ApprovalAuthorityRequest,
} from "./approval-authority.js";

export interface ApprovalSigningPayload {
  runId: string;
  intentSha256: string;
  patchSha256: string;
  evidenceSha256: string;
  governanceSha256: string;
  policySha256: string;
  communityGateSha256: string;
  prBodySha256: string;
  approvedBy: string;
  approvalMode: ApprovalArtifact["approvalMode"];
  maintainerGateEvidence?: MaintainerGateEvidence;
}

/** Stable detached-signature payload; approvedAt is intentionally metadata only. */
export function getApprovalSigningPayload(
  request: Omit<ApprovalAuthorityRequest, "communityGate"> &
    Omit<ApprovalAuthorityDecision, "signature" | "signingKeyId"> & {
      patchSha256: string;
      evidenceSha256: string;
      governanceSha256: string;
      policySha256: string;
      communityGateSha256: string;
      prBodySha256: string;
    },
): string {
  const payload: ApprovalSigningPayload = {
    runId: request.runId,
    intentSha256: request.intentSha256,
    patchSha256: request.patchSha256,
    evidenceSha256: request.evidenceSha256,
    governanceSha256: request.governanceSha256,
    policySha256: request.policySha256,
    communityGateSha256: request.communityGateSha256,
    prBodySha256: request.prBodySha256,
    approvedBy: request.approvedBy,
    approvalMode: request.approvalMode,
    maintainerGateEvidence: request.maintainerGateEvidence,
  };
  return JSON.stringify(payload);
}

export interface ApprovalSigner {
  readonly signingKeyId: string;
  signApproval(payload: string): string;
}

export class Ed25519ApprovalSigner implements ApprovalSigner {
  readonly signingKeyId: string;
  private readonly privateKey: KeyObject;

  constructor(signingKeyId: string, privateKey: KeyObject | string | Buffer) {
    if (!signingKeyId.trim()) {
      throw new Error("ApprovalSigningError: signingKeyId is required.");
    }
    this.signingKeyId = signingKeyId;
    this.privateKey =
      typeof privateKey === "object" && "type" in privateKey
        ? privateKey
        : createPrivateKey(privateKey);
  }

  signApproval(payload: string): string {
    return signMessage(
      null,
      Buffer.from(payload, "utf8"),
      this.privateKey,
    ).toString("base64");
  }
}

export class Ed25519ApprovalVerifier implements ApprovalArtifactVerifier {
  readonly signingKeyId: string;
  private readonly publicKey: KeyObject;

  constructor(signingKeyId: string, publicKey: KeyObject | string | Buffer) {
    if (!signingKeyId.trim()) {
      throw new Error("ApprovalSigningError: signingKeyId is required.");
    }
    this.signingKeyId = signingKeyId;
    this.publicKey =
      typeof publicKey === "object" && "type" in publicKey
        ? publicKey
        : createPublicKey(publicKey);
  }

  verifyApproval(artifact: ApprovalArtifact): boolean {
    if (artifact.signingKeyId !== this.signingKeyId) return false;
    const payload = getApprovalSigningPayload({
      runId: artifact.runId,
      intentSha256: artifact.intentSha256,
      patchSha256: artifact.patchSha256,
      evidenceSha256: artifact.evidenceSha256,
      governanceSha256: artifact.governanceSha256,
      policySha256: artifact.policySha256,
      communityGateSha256: artifact.communityGateSha256,
      prBodySha256: artifact.prBodySha256,
      approvedBy: artifact.approvedBy,
      approvalMode: artifact.approvalMode,
      maintainerGateEvidence: artifact.maintainerGateEvidence,
    });
    try {
      return verifyMessage(
        null,
        Buffer.from(payload, "utf8"),
        this.publicKey,
        Buffer.from(artifact.signature, "base64"),
      );
    } catch {
      return false;
    }
  }
}

export function testApprovalSignaturePayload(
  artifact: Omit<ApprovalArtifact, "signature" | "signingKeyId" | "approvedAt">,
): string {
  return getApprovalSigningPayload(artifact);
}
