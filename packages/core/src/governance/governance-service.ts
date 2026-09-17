import { createHash } from "node:crypto";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import {
  GovernanceDecisionArtifactSchema,
  ValidatedPatchArtifactSchema,
  type GovernanceDecisionArtifact,
} from "../contracts/schemas.js";
import { auditGovernance } from "./governance-auditor.js";
import { hashValidatedPatchArtifact } from "../evidence/validated-patch.js";

export interface GovernanceAuditRunOptions {
  /** Human-readable title to audit and bind to the later SubmissionIntent. */
  prTitle?: string;
  /** Inspection-only convenience value; it must equal the stored pr_draft. */
  prBody?: string;
  /** Deprecated agent-controlled bypasses are rejected, never honored. */
  allowUnverified?: boolean;
  isAutonomous?: boolean;
  subagentScore?: number;
}

function hash(value: unknown): string {
  const content =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(content).digest("hex");
}

export class GovernanceService {
  constructor(private readonly runManager: ContributionRunManager) {}

  /**
   * Run-scoped authoritative governance audit.
   *
   * Patch, Evidence, and PR body are read from the immutable run bundle. The
   * caller may provide a title for inspection, but the exact title and body
   * hashes are persisted and must match the later SubmissionIntent. No
   * caller-supplied patch/evidence can replace a run artifact, and an
   * agent-supplied quality waiver is never honored.
   */
  audit(
    runId: string,
    options: GovernanceAuditRunOptions = {},
  ): GovernanceDecisionArtifact {
    const run = this.runManager.getRun(runId);
    if (!run) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }
    if (run.manifest.currentPhase !== "EVIDENCE_COLLECTED") {
      throw new Error(
        `GovernanceNotReadyError: run ${runId} is in phase "${run.manifest.currentPhase}"; audit requires EVIDENCE_COLLECTED.`,
      );
    }
    if (options.allowUnverified === true) {
      throw new Error(
        "GovernanceAuthorityError: agent-controlled --allow-unverified cannot create a canonical governance decision.",
      );
    }

    const patchRaw = run.artifacts.patch;
    if (!patchRaw || (typeof patchRaw === "string" && patchRaw.trim() === "")) {
      throw new Error(
        `Cannot audit governance for run ${runId}: missing required patch artifact.`,
      );
    }
    const validatedPatchResult = ValidatedPatchArtifactSchema.safeParse(
      run.artifacts.validatedPatch,
    );
    if (!validatedPatchResult.success) {
      throw new Error(
        `Cannot audit governance for run ${runId}: missing immutable ValidatedPatchArtifact. Complete canonical GREEN verification first.`,
      );
    }
    const validatedPatch = validatedPatchResult.data;
    const patchContent =
      typeof patchRaw === "string" ? patchRaw : JSON.stringify(patchRaw);
    if (
      validatedPatch.patchSha256 !== hash(patchContent) ||
      validatedPatch.artifactSha256 !==
        hashValidatedPatchArtifact(validatedPatch)
    ) {
      throw new Error(
        `GovernanceProvenanceError: current patch or ValidatedPatchArtifact integrity does not match the canonical GREEN result for run ${runId}.`,
      );
    }
    const evidenceArtifact = run.artifacts.evidence;
    if (!evidenceArtifact) {
      throw new Error(
        `Cannot audit governance for run ${runId}: missing required evidence artifact. Complete Evidence V2 first.`,
      );
    }
    const prDraftRaw = run.artifacts.prDraft;
    if (typeof prDraftRaw !== "string") {
      throw new Error(
        `Cannot audit governance for run ${runId}: missing canonical pr_draft artifact. Store the exact PR body before auditing.`,
      );
    }
    if (options.prBody !== undefined && options.prBody !== prDraftRaw) {
      throw new Error(
        "GovernanceProvenanceError: caller-supplied PR body differs from the stored pr_draft artifact.",
      );
    }

    const evidenceSha256 = hash(evidenceArtifact);
    const prDraftSha256 = hash(prDraftRaw);
    const prTitle =
      options.prTitle ||
      (typeof patchRaw === "object" && patchRaw !== null
        ? String((patchRaw as any).title || "")
        : "") ||
      run.manifest.issueTitle ||
      "chore: opencontrib contribution";

    const auditResult = auditGovernance({
      patchContent,
      prTitle,
      prBody: prDraftRaw,
      evidence: evidenceArtifact as any,
      lineCount: validatedPatch.changedLines,
      // Governance is deliberately technical-only. Approval is minted later
      // by an external trusted authority and is not inferred from this audit.
      subagentQualityScore: options.subagentScore,
    });

    const decision: GovernanceDecisionArtifact = {
      runId,
      patchSha256: validatedPatch.patchSha256,
      evidenceSha256,
      prDraftSha256,
      prTitle,
      prTitleSha256: hash(prTitle),
      auditResult,
      passed: auditResult.technicalGate?.status === "PASS",
      auditedAt: new Date().toISOString(),
    };

    GovernanceDecisionArtifactSchema.parse(decision);

    // Failed audits remain diagnostic output only. A canonical governance
    // artifact is created exactly once, after the technical gate passes.
    if (!decision.passed) return decision;

    saveCanonicalArtifact(
      this.runManager,
      runId,
      "governance",
      decision as any,
      "GOVERNANCE_AUDITED",
    );
    return decision;
  }
}
