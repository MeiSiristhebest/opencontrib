import {
  ArtifactType,
  ContributionRunPhase,
  ContributionRunSummary,
} from "./types.js";
import { DERIVED_PHASE_REQUIREMENTS } from "../workflow/protocol-contract.js";
import {
  EvidenceBundleV2Schema,
  GovernanceAuditResultSchema,
  SubmissionArtifactSchema,
  ApprovalArtifactSchema,
  type EvidenceBundleV2,
  type SubmissionArtifact,
} from "../contracts/schemas.js";

export class PhaseGateViolationError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentPhase: ContributionRunPhase,
    public readonly targetPhase: ContributionRunPhase,
    public readonly missingPrerequisites: string[],
    public readonly suggestedAction: string,
  ) {
    super(
      `[PhaseGateViolation] Run ${runId} is in phase '${currentPhase}', cannot transition to '${targetPhase}'. ` +
        `Missing prerequisites: ${missingPrerequisites.join(", ")}. ` +
        `Suggested next action: ${suggestedAction}`,
    );
    this.name = "PhaseGateViolationError";
  }
}

export interface PhaseTransitionRequirement {
  fromPhases: ContributionRunPhase[];
  requiredArtifacts: ArtifactType[];
  suggestedAction: string;
}

export const PHASE_REQUIREMENTS: Record<
  ContributionRunPhase,
  PhaseTransitionRequirement
> = DERIVED_PHASE_REQUIREMENTS;

export function validatePhaseGate(
  runSummary: ContributionRunSummary,
  targetPhase: ContributionRunPhase,
): { ok: boolean; error?: PhaseGateViolationError } {
  const req = PHASE_REQUIREMENTS[targetPhase];
  if (!req) return { ok: true };

  const currentPhase = runSummary.manifest.currentPhase;
  const availableArtifacts = Object.keys(
    runSummary.artifacts,
  ) as ArtifactType[];

  const missingArtifacts = req.requiredArtifacts.filter(
    (art) =>
      !availableArtifacts.includes(art) ||
      runSummary.artifacts[art as keyof typeof runSummary.artifacts] ===
        undefined,
  );

  if (missingArtifacts.length > 0) {
    return {
      ok: false,
      error: new PhaseGateViolationError(
        runSummary.manifest.runId,
        currentPhase,
        targetPhase,
        missingArtifacts.map((a) => `Missing artifact: ${a}`),
        req.suggestedAction,
      ),
    };
  }

  // Semantic artifact predicates
  if (targetPhase === "EVIDENCE_COLLECTED") {
    const ev = runSummary.artifacts.evidence;
    const evidence = ev ? EvidenceBundleV2Schema.safeParse(ev) : undefined;
    if (!evidence?.success) {
      const issue = evidence?.error.issues[0]?.message;
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            !ev
              ? "Missing evidence artifact: cannot enter EVIDENCE_COLLECTED without a RED→GREEN evidence bundle."
              : `Evidence artifact fails EvidenceBundleV2 semantic validity: ${issue ?? "missing RED/GREEN evidence or verified status."}`,
          ],
          "Capture the RED baseline: opencontrib evidence capture-red --test-cmd '<cmd>' --assertion '<pattern>', then opencontrib evidence verify-green --test-cmd '<cmd>'.",
        ),
      };
    }

    const bundle = evidence.data;
    const invalid = validateEvidenceBundleIdentity(bundle);
    if (invalid) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [invalid],
          "Re-run the canonical Evidence V2 flow: capture-red, apply the fix, verify-green.",
        ),
      };
    }
  }

  if (targetPhase === "GOVERNANCE_AUDITED") {
    const gov = runSummary.artifacts.governance;
    const audit = gov ? GovernanceAuditResultSchema.safeParse(gov) : undefined;
    if (!audit?.success) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            !gov
              ? "Missing governance artifact: cannot enter GOVERNANCE_AUDITED without audit result."
              : `Governance artifact fails semantic validity: ${audit?.error.issues[0]?.message ?? "invalid audit result."}`,
          ],
          "Run opencontrib governance audit --patch <file> --pr-title '<title>'.",
        ),
      };
    }

    const gate = audit.data;
    if (gate.technicalGate?.status !== "PASS") {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            "Governance artifact fails semantic validity: technicalGate.status must be PASS.",
          ],
          "Fix the patch/governance audit failures before advancing to GOVERNANCE_AUDITED.",
        ),
      };
    }
    if (
      gate.approvalGate?.status !== "APPROVED" &&
      gate.approvalGate?.status !== "WAIVED"
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            "Governance artifact fails semantic validity: approvalGate must be APPROVED or WAIVED.",
          ],
          "Complete explicit human approval or a recorded policy waiver before advancing to GOVERNANCE_AUDITED.",
        ),
      };
    }
  }

  if (targetPhase === "PR_SUBMITTED") {
    const app = runSummary.artifacts.approval;
    const approval = app ? ApprovalArtifactSchema.safeParse(app) : undefined;
    if (!approval?.success) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            !app
              ? "Missing approval artifact: cannot enter PR_SUBMITTED without recorded ApprovalArtifact."
              : `Approval artifact fails semantic validity: ${approval?.error.issues[0]?.message ?? "invalid schema"}`,
          ],
          "Record approval via ApprovalService before submitting PR.",
        ),
      };
    }

    const sub = runSummary.artifacts.submission;
    const submission = sub
      ? SubmissionArtifactSchema.safeParse(sub)
      : undefined;
    const validPrUrl =
      typeof submission?.data?.prUrl === "string" &&
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*$/i.test(
        submission.data.prUrl,
      );
    if (
      !submission?.success ||
      !submission.data.verified ||
      !submission.data.prNumber ||
      !submission.data.prUrl ||
      !submission.data.headSha ||
      !validPrUrl
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            !sub
              ? "Missing submission artifact: cannot enter PR_SUBMITTED without a verified SubmissionArtifact."
              : !submission?.success
                ? `Submission artifact fails semantic validity: ${submission?.error.issues[0]?.message ?? "invalid schema"}`
                : !submission.data.verified
                  ? "Submission artifact fails semantic validity: SubmissionArtifact.verified must be true."
                  : "Submission artifact fails semantic validity: valid github PR URL, headSha, and prNumber required.",
          ],
          "Submit PR through verified SubmissionService to generate SubmissionArtifact.",
        ),
      };
    }
  }

  if (targetPhase === "COMPLETED") {
    const res = runSummary.artifacts.result as
      | (Partial<{ prNumber: number; prUrl: string }> & {
          submission?: SubmissionArtifact;
        })
      | undefined;
    const submissionArtifact = runSummary.artifacts.submission
      ? SubmissionArtifactSchema.safeParse(runSummary.artifacts.submission)
      : undefined;
    const resSubmission = res?.submission
      ? SubmissionArtifactSchema.safeParse(res.submission)
      : undefined;
    const submission = resSubmission?.success
      ? resSubmission
      : submissionArtifact;

    const validPrUrl =
      typeof res?.prUrl === "string" &&
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*$/i.test(
        res.prUrl,
      );
    if (
      !submission?.success ||
      !submission.data.verified ||
      !submission.data.prNumber ||
      !submission.data.prUrl ||
      !submission.data.headSha ||
      !validPrUrl ||
      res?.prNumber !== submission.data.prNumber ||
      res?.prUrl !== submission.data.prUrl
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            !submission?.success
              ? "Result artifact fails semantic validity: missing verified SubmissionArtifact."
              : !submission.data.verified
                ? "Result artifact fails semantic validity: SubmissionArtifact.verified must be true."
                : "Result artifact fails semantic validity: prNumber/prUrl must match the verified SubmissionArtifact.",
          ],
          "Submit PR through the verified SubmissionService before completing run.",
        ),
      };
    }
  }

  if (
    targetPhase !== "FAILED" &&
    req.fromPhases.length > 0 &&
    !req.fromPhases.includes(currentPhase)
  ) {
    return {
      ok: false,
      error: new PhaseGateViolationError(
        runSummary.manifest.runId,
        currentPhase,
        targetPhase,
        [
          `Phase '${currentPhase}' is not an allowed precursor to '${targetPhase}'`,
        ],
        req.suggestedAction,
      ),
    };
  }

  return { ok: true };
}

function validateEvidenceBundleIdentity(
  bundle: EvidenceBundleV2,
): string | undefined {
  const { redEvidence, greenEvidence, reproductionVerified, allTestsPassing } =
    bundle;
  const checks: Array<[boolean, string]> = [
    [
      redEvidence.assertionMatched === true,
      "RED baseline assertion must have matched.",
    ],
    [
      redEvidence.exitCode !== 0,
      "RED baseline must record a non-zero exit code.",
    ],
    [
      redEvidence.command.trim().replace(/\s+/g, " ") ===
        greenEvidence.command.trim().replace(/\s+/g, " "),
      "GREEN test command must match RED baseline test command.",
    ],
    [
      redEvidence.assertionMatchedFingerprint ===
        greenEvidence.assertionMatchedFingerprint,
      "GREEN evidence must bind to the same assertion fingerprint as RED.",
    ],
    [greenEvidence.passed === true, "GREEN tests must pass."],
    [
      greenEvidence.treeChangedComparedToRed === true,
      "Source tree must change between RED and GREEN.",
    ],
    [
      greenEvidence.treeHashMatchesRed === false,
      "GREEN tree must differ from RED tree hash.",
    ],
    [greenEvidence.stressLoopPassed === true, "GREEN stress loop must pass."],
    [reproductionVerified === true, "reproductionVerified must be true."],
    [allTestsPassing === true, "allTestsPassing must be true."],
  ];
  const failed = checks.find(([ok]) => !ok);
  return failed ? failed[1] : undefined;
}
