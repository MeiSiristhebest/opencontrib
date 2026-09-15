import { createHash } from "node:crypto";
import type { ContributionRunManager } from "../run/run-manager.js";
import {
  ApprovalArtifactSchema,
  type ApprovalArtifact,
} from "../contracts/schemas.js";

export interface CreateApprovalInput {
  runId: string;
  approvedBy?: string;
  approvalMode?: "explicit_human" | "policy_waived";
}

export class ApprovalService {
  constructor(private readonly runManager: ContributionRunManager) {}

  recordApproval(input: CreateApprovalInput): ApprovalArtifact {
    const summary = this.runManager.getRun(input.runId);
    if (!summary) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }

    const patch = summary.artifacts.patch || "";
    const patchSha256 = createHash("sha256").update(patch).digest("hex");

    let evidenceSha256: string | undefined;
    if (summary.artifacts.evidence) {
      evidenceSha256 = createHash("sha256")
        .update(JSON.stringify(summary.artifacts.evidence))
        .digest("hex");
    }

    let governanceSha256: string | undefined;
    if (summary.artifacts.governance) {
      governanceSha256 = createHash("sha256")
        .update(JSON.stringify(summary.artifacts.governance))
        .digest("hex");
    }

    let prBodySha256: string | undefined;
    if (summary.artifacts.prDraft) {
      prBodySha256 = createHash("sha256")
        .update(String(summary.artifacts.prDraft))
        .digest("hex");
    }

    const artifact: ApprovalArtifact = {
      runId: input.runId,
      patchSha256,
      evidenceSha256,
      governanceSha256,
      prBodySha256,
      approvedBy: input.approvedBy || "human_reviewer",
      approvedAt: new Date().toISOString(),
      approvalMode: input.approvalMode || "explicit_human",
    };

    ApprovalArtifactSchema.parse(artifact);

    this.runManager.saveArtifactTrusted(input.runId, "approval", artifact);

    return artifact;
  }

  verifyApprovalIntegrity(runId: string): { valid: boolean; reason?: string } {
    const summary = this.runManager.getRun(runId);
    if (!summary) {
      return { valid: false, reason: `Run ${runId} not found` };
    }

    const approval = summary.artifacts.approval as ApprovalArtifact | undefined;
    if (!approval) {
      return { valid: false, reason: "No ApprovalArtifact recorded" };
    }

    const currentPatch = summary.artifacts.patch || "";
    const currentPatchSha256 = createHash("sha256")
      .update(currentPatch)
      .digest("hex");

    if (currentPatchSha256 !== approval.patchSha256) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: patch has changed since explicit human approval was recorded.",
      };
    }

    if (summary.artifacts.evidence && approval.evidenceSha256) {
      const currentEvSha256 = createHash("sha256")
        .update(JSON.stringify(summary.artifacts.evidence))
        .digest("hex");
      if (currentEvSha256 !== approval.evidenceSha256) {
        return {
          valid: false,
          reason:
            "TOCTOU violation: evidence has changed since approval was recorded.",
        };
      }
    }

    if (summary.artifacts.governance && approval.governanceSha256) {
      const currentGovSha256 = createHash("sha256")
        .update(JSON.stringify(summary.artifacts.governance))
        .digest("hex");
      if (currentGovSha256 !== approval.governanceSha256) {
        return {
          valid: false,
          reason:
            "TOCTOU violation: governance audit has changed since approval was recorded.",
        };
      }
    }

    if (summary.artifacts.prDraft && approval.prBodySha256) {
      const currentPrBodySha256 = createHash("sha256")
        .update(String(summary.artifacts.prDraft))
        .digest("hex");
      if (currentPrBodySha256 !== approval.prBodySha256) {
        return {
          valid: false,
          reason:
            "TOCTOU violation: PR draft body has changed since approval was recorded.",
        };
      }
    }

    return { valid: true };
  }
}
