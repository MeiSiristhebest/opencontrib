import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { ApprovalArtifact } from "../contracts/schemas.js";
import { ApprovalService, type ApprovalChallenge } from "./approval-service.js";
import {
  createTrustedApprovalAuthority,
  type ApprovalArtifactVerifier,
  type ApprovalAuthorityDecision,
  type HostApprovalPort,
} from "./approval-authority.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import type { ApprovalSigner } from "./approval-signing.js";
import { getApprovalSigningPayload } from "./approval-signing.js";

export type ApprovalRequestStatus = "PENDING" | "APPROVED" | "REJECTED";

export interface ApprovalRequestRecord extends ApprovalChallenge {
  requestId: string;
  status: ApprovalRequestStatus;
  requestedAt: string;
  resolvedAt?: string;
  rejectionReason?: string;
}

export interface ApprovalBrokerStore {
  save(request: ApprovalRequestRecord): void;
  get(requestId: string): ApprovalRequestRecord | undefined;
}

export class InMemoryApprovalBrokerStore implements ApprovalBrokerStore {
  private readonly requests = new Map<string, ApprovalRequestRecord>();

  save(request: ApprovalRequestRecord): void {
    this.requests.set(request.requestId, structuredClone(request));
  }

  get(requestId: string): ApprovalRequestRecord | undefined {
    const request = this.requests.get(requestId);
    return request ? structuredClone(request) : undefined;
  }
}

/**
 * Durable broker storage for a separately-running host process. The directory
 * and private key must be inaccessible to the Agent OS user in production;
 * file permissions alone do not establish that boundary on a shared account.
 */
export class JsonApprovalBrokerStore implements ApprovalBrokerStore {
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  save(request: ApprovalRequestRecord): void {
    if (!/^approval_[a-f0-9]{64}$/.test(request.requestId)) {
      throw new Error("ApprovalBrokerStorageError: invalid request ID.");
    }
    const destination = join(this.directory, `${request.requestId}.json`);
    const temporary = `${destination}.tmp`;
    writeFileSync(temporary, JSON.stringify(request, null, 2), {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporary, destination);
  }

  get(requestId: string): ApprovalRequestRecord | undefined {
    if (!/^approval_[a-f0-9]{64}$/.test(requestId)) return undefined;
    const filePath = join(this.directory, `${requestId}.json`);
    if (!existsSync(filePath)) return undefined;
    try {
      return JSON.parse(
        readFileSync(filePath, "utf8"),
      ) as ApprovalRequestRecord;
    } catch {
      throw new Error(
        `ApprovalBrokerStorageError: approval request '${requestId}' is unreadable.`,
      );
    }
  }
}

export interface HumanApprovalDecision {
  approvedBy: string;
  approvalMode: "explicit_human" | "policy_waived";
}

export interface ApprovalBrokerClock {
  nowIso(): string;
}

const systemClock: ApprovalBrokerClock = {
  nowIso: () => new Date().toISOString(),
};

/**
 * Host-side approval broker. Agents may create pending challenges, but only a
 * host process possessing the signing key can transition one to APPROVED and
 * mint the canonical ApprovalArtifact.
 */
export class TrustedApprovalBroker {
  private readonly clock: ApprovalBrokerClock;

  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly signer: ApprovalSigner,
    private readonly verifier: ApprovalArtifactVerifier,
    private readonly store: ApprovalBrokerStore = new InMemoryApprovalBrokerStore(),
    clock: ApprovalBrokerClock = systemClock,
  ) {
    this.clock = clock;
  }

  request(runId: string): ApprovalRequestRecord {
    const challenge = new ApprovalService(this.runManager).requestApproval(
      runId,
    );
    const requestId = requestIdForChallenge(challenge);
    const existing = this.store.get(requestId);
    if (existing) {
      if (requestIdForChallenge(existing) !== requestId) {
        throw new Error(
          "ApprovalBrokerStorageError: persisted approval challenge identity does not verify.",
        );
      }
      return existing;
    }
    const request: ApprovalRequestRecord = {
      ...challenge,
      requestId,
      status: "PENDING",
      requestedAt: this.clock.nowIso(),
    };
    this.store.save(request);
    return request;
  }

  async approve(
    requestId: string,
    decision: HumanApprovalDecision,
  ): Promise<ApprovalArtifact> {
    const request = this.requirePending(requestId);
    const current = this.request(request.runId);
    if (!sameChallenge(request, current)) {
      throw new Error(
        "ApprovalChallengeStaleError: the run changed after the approval request; review the new challenge.",
      );
    }
    if (!decision.approvedBy.trim()) {
      throw new Error("ApprovalBrokerError: approvedBy is required.");
    }

    const authorityHost: HostApprovalPort = {
      issueApproval: (): ApprovalAuthorityDecision => ({
        approvedBy: decision.approvedBy,
        approvalMode: decision.approvalMode,
        signingKeyId: this.signer.signingKeyId,
        signature: this.signer.signApproval(
          getApprovalSigningPayload({
            runId: request.runId,
            intentSha256: request.intentSha256,
            patchSha256: request.patchSha256,
            evidenceSha256: request.evidenceSha256,
            governanceSha256: request.governanceSha256,
            prBodySha256: request.prBodySha256,
            approvedBy: decision.approvedBy,
            approvalMode: decision.approvalMode,
          }),
        ),
      }),
      verifyApproval: (artifact) => this.verifier.verifyApproval(artifact),
    };
    const authority = createTrustedApprovalAuthority(authorityHost);
    const approvalService = new ApprovalService(
      this.runManager,
      authority,
      this.verifier,
    );
    const artifact = await approvalService.recordApproval({
      runId: request.runId,
      expectedIntentSha256: request.intentSha256,
    });
    this.store.save({
      ...request,
      status: "APPROVED",
      resolvedAt: this.clock.nowIso(),
    });
    return artifact;
  }

  reject(requestId: string, reason: string): ApprovalRequestRecord {
    const request = this.requirePending(requestId);
    const rejected: ApprovalRequestRecord = {
      ...request,
      status: "REJECTED",
      resolvedAt: this.clock.nowIso(),
      rejectionReason: reason,
    };
    this.store.save(rejected);
    return rejected;
  }

  get(requestId: string): ApprovalRequestRecord | undefined {
    return this.store.get(requestId);
  }

  private requirePending(requestId: string): ApprovalRequestRecord {
    const request = this.store.get(requestId);
    if (
      !request ||
      request.status !== "PENDING" ||
      requestIdForChallenge(request) !== requestId
    ) {
      throw new Error(
        `ApprovalBrokerError: request '${requestId}' is missing, tampered, or is no longer pending.`,
      );
    }
    return request;
  }
}

function requestIdForChallenge(challenge: ApprovalChallenge): string {
  const identity = {
    runId: challenge.runId,
    intentSha256: challenge.intentSha256,
    patchSha256: challenge.patchSha256,
    evidenceSha256: challenge.evidenceSha256,
    governanceSha256: challenge.governanceSha256,
    prBodySha256: challenge.prBodySha256,
    target: challenge.target,
    branchName: challenge.branchName,
  };
  return `approval_${createHash("sha256")
    .update(JSON.stringify(identity))
    .digest("hex")}`;
}

function sameChallenge(
  left: ApprovalChallenge,
  right: ApprovalChallenge,
): boolean {
  return (
    left.runId === right.runId &&
    left.intentSha256 === right.intentSha256 &&
    left.patchSha256 === right.patchSha256 &&
    left.evidenceSha256 === right.evidenceSha256 &&
    left.governanceSha256 === right.governanceSha256 &&
    left.prBodySha256 === right.prBodySha256 &&
    left.target === right.target &&
    left.branchName === right.branchName
  );
}
