import { createHash } from "node:crypto";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import {
  ApprovalArtifactSchema,
  GovernanceDecisionArtifactSchema,
  SubmissionIntentArtifactSchema,
  ValidatedPatchArtifactSchema,
  type ApprovalArtifact,
  type SubmissionIntentArtifact,
} from "../contracts/schemas.js";
import {
  isTrustedApprovalAuthority,
  type ApprovalArtifactVerifier,
  type TrustedApprovalAuthority,
} from "./approval-authority.js";
import { hashValidatedPatchArtifact } from "../evidence/validated-patch.js";

export interface CreateApprovalInput {
  runId: string;
  /** Hash returned by requestApproval; mandatory challenge binding. */
  expectedIntentSha256: string;
}

export interface ApprovalChallenge {
  runId: string;
  intentSha256: string;
  patchSha256: string;
  evidenceSha256: string;
  governanceSha256: string;
  prBodySha256: string;
  target: string;
  branchName: string;
}

function hash(value: unknown): string {
  const content =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(content).digest("hex");
}

export class ApprovalService {
  private readonly verifier?: ApprovalArtifactVerifier;

  constructor(
    private readonly runManager: ContributionRunManager,
    private readonly authority?: TrustedApprovalAuthority,
    verifier?: ApprovalArtifactVerifier,
  ) {
    if (authority !== undefined && !isTrustedApprovalAuthority(authority)) {
      throw new Error(
        "ApprovalAuthorityError: only a host-issued trusted approval capability may be injected.",
      );
    }
    if (
      verifier !== undefined &&
      typeof verifier.verifyApproval !== "function"
    ) {
      throw new Error(
        "ApprovalAuthorityError: an approval verifier is required to validate signed artifacts.",
      );
    }
    this.verifier = verifier ?? authority;
  }

  /** Create a challenge; this method never writes an approval artifact. */
  requestApproval(runId: string): ApprovalChallenge {
    const summary = this.getGovernanceReadySummary(runId);
    const intent = this.parseIntent(summary.artifacts.submissionIntent);
    const hashes = this.currentHashes(summary);
    return {
      runId,
      intentSha256: intent.intentSha256,
      patchSha256: hashes.patchSha256,
      evidenceSha256: hashes.evidenceSha256,
      governanceSha256: hashes.governanceSha256,
      prBodySha256: hash(intent.body),
      target: `${intent.upstreamOwner}/${intent.upstreamRepo}`,
      branchName: intent.branchName,
    };
  }

  /** Mint an ApprovalArtifact only when an opaque host capability is present. */
  async recordApproval(input: CreateApprovalInput): Promise<ApprovalArtifact> {
    if (!this.authority) {
      throw new Error(
        "ApprovalAuthorityRequiredError: approval can only be minted by a trusted human/policy host. Use requestApproval() to create a challenge.",
      );
    }
    if (!input.expectedIntentSha256) {
      throw new Error(
        "ApprovalIntentMismatchError: expectedIntentSha256 is mandatory.",
      );
    }

    const summary = this.getGovernanceReadySummary(input.runId);
    const intent = this.parseIntent(summary.artifacts.submissionIntent);
    if (input.expectedIntentSha256 !== intent.intentSha256) {
      throw new Error(
        `ApprovalIntentMismatchError: expected intent SHA "${input.expectedIntentSha256}" does not match recorded intent SHA "${intent.intentSha256}".`,
      );
    }

    const challenge = this.requestApproval(input.runId);
    const authorityDecision = await this.authority.issueApproval({
      runId: input.runId,
      intentSha256: challenge.intentSha256,
    });
    if (
      !authorityDecision ||
      !authorityDecision.approvedBy ||
      !authorityDecision.signingKeyId ||
      !authorityDecision.signature ||
      !["explicit_human", "policy_waived"].includes(
        authorityDecision.approvalMode,
      )
    ) {
      throw new Error(
        "ApprovalAuthorityError: trusted host returned an invalid approval decision.",
      );
    }

    const artifact: ApprovalArtifact = {
      runId: input.runId,
      intentSha256: challenge.intentSha256,
      patchSha256: challenge.patchSha256,
      evidenceSha256: challenge.evidenceSha256,
      governanceSha256: challenge.governanceSha256,
      prBodySha256: challenge.prBodySha256,
      approvedBy: authorityDecision.approvedBy,
      approvedAt: new Date().toISOString(),
      approvalMode: authorityDecision.approvalMode,
      signingKeyId: authorityDecision.signingKeyId,
      signature: authorityDecision.signature,
    };
    ApprovalArtifactSchema.parse(artifact);
    if (!this.verifier || !this.verifier.verifyApproval(artifact)) {
      throw new Error(
        "ApprovalAuthorityError: trusted host returned an unverifiable approval signature.",
      );
    }

    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "approval",
      artifact as any,
    );
    return artifact;
  }

  verifyApprovalIntegrity(runId: string): { valid: boolean; reason?: string } {
    const summary = this.runManager.getRun(runId);
    if (!summary) return { valid: false, reason: `Run ${runId} not found` };

    const approvalResult = ApprovalArtifactSchema.safeParse(
      summary.artifacts.approval,
    );
    if (!approvalResult.success) {
      return { valid: false, reason: "No valid ApprovalArtifact recorded" };
    }
    const approval = approvalResult.data;
    if (!this.verifier || !this.verifier.verifyApproval(approval)) {
      return {
        valid: false,
        reason:
          "Approval signature is missing or does not verify against a trusted host key.",
      };
    }

    const intentResult = SubmissionIntentArtifactSchema.safeParse(
      summary.artifacts.submissionIntent,
    );
    if (!intentResult.success) {
      return {
        valid: false,
        reason: "TOCTOU violation: SubmissionIntent is missing or invalid.",
      };
    }
    const intent = intentResult.data;
    let hashes: ReturnType<ApprovalService["currentHashes"]>;
    try {
      hashes = this.currentHashes(summary);
    } catch {
      return {
        valid: false,
        reason:
          "TOCTOU violation: current patch or ValidatedPatchArtifact is invalid.",
      };
    }
    if (intent.intentSha256 !== approval.intentSha256) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: SubmissionIntent has been mutated or removed since approval.",
      };
    }

    if (hashes.patchSha256 !== approval.patchSha256) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: patch has changed since explicit approval was recorded.",
      };
    }
    if (hashes.evidenceSha256 !== approval.evidenceSha256) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: evidence has changed since approval was recorded.",
      };
    }
    if (hashes.governanceSha256 !== approval.governanceSha256) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: governance audit has changed since approval was recorded.",
      };
    }
    if (
      summary.artifacts.prDraft &&
      hash(summary.artifacts.prDraft) !== approval.prBodySha256
    ) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: PR body has changed since approval was recorded.",
      };
    }
    if (hash(intent.body) !== approval.prBodySha256) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: PR body has changed since approval was recorded.",
      };
    }
    if (
      intent.patchSha256 !== hashes.patchSha256 ||
      intent.evidenceSha256 !== hashes.evidenceSha256 ||
      intent.governanceSha256 !== hashes.governanceSha256 ||
      intent.bodySha256 !== hash(intent.body)
    ) {
      return {
        valid: false,
        reason:
          "TOCTOU violation: SubmissionIntent constituent hashes do not match the current run.",
      };
    }
    return { valid: true };
  }

  private getGovernanceReadySummary(runId: string) {
    const summary = this.runManager.getRun(runId);
    if (!summary) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }
    if (summary.manifest.currentPhase !== "GOVERNANCE_AUDITED") {
      throw new Error(
        `ApprovalNotReadyError: run ${runId} must be in GOVERNANCE_AUDITED before approval.`,
      );
    }
    const governance = GovernanceDecisionArtifactSchema.safeParse(
      summary.artifacts.governance,
    );
    if (!governance.success || !governance.data.passed) {
      throw new Error(
        "ApprovalNotReadyError: a passing canonical governance decision is required.",
      );
    }
    return summary;
  }

  private parseIntent(value: unknown): SubmissionIntentArtifact {
    const result = SubmissionIntentArtifactSchema.safeParse(value);
    if (!result.success) {
      throw new Error(
        "ApprovalNotReadyError: no valid SubmissionIntentArtifact found. Request approval only after creating the immutable intent.",
      );
    }
    return result.data;
  }

  private currentHashes(
    summary: NonNullable<ReturnType<ContributionRunManager["getRun"]>>,
  ): {
    patchSha256: string;
    evidenceSha256: string;
    governanceSha256: string;
  } {
    if (
      !summary.artifacts.patch ||
      !summary.artifacts.validatedPatch ||
      !summary.artifacts.evidence ||
      !summary.artifacts.governance
    ) {
      throw new Error(
        "ApprovalNotReadyError: patch, validated patch, evidence, and governance artifacts are required.",
      );
    }
    const validatedPatch = ValidatedPatchArtifactSchema.safeParse(
      summary.artifacts.validatedPatch,
    );
    if (
      !validatedPatch.success ||
      validatedPatch.data.patchSha256 !== hash(summary.artifacts.patch) ||
      validatedPatch.data.artifactSha256 !==
        hashValidatedPatchArtifact(validatedPatch.data)
    ) {
      throw new Error(
        "ApprovalNotReadyError: the current patch or ValidatedPatchArtifact integrity does not match the canonical GREEN result.",
      );
    }
    return {
      patchSha256: validatedPatch.data.patchSha256,
      evidenceSha256: hash(summary.artifacts.evidence),
      governanceSha256: hash(summary.artifacts.governance),
    };
  }
}
