import { createHash } from "node:crypto";
import {
  ArtifactType,
  ContributionRunPhase,
  ContributionRunSummary,
} from "./types.js";
import { DERIVED_PHASE_REQUIREMENTS } from "../workflow/protocol-contract.js";
import { hashValidatedPatchArtifact } from "../evidence/validated-patch.js";
import {
  EvidenceBundleV2Schema,
  GovernanceDecisionArtifactSchema,
  GovernanceAuditResultSchema,
  SubmissionIntentArtifactSchema,
  SubmissionArtifactSchema,
  ApprovalArtifactSchema,
  ResultArtifactSchema,
  ValidatedPatchArtifactSchema,
  type EvidenceBundleV2,
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

  const toSummaryKey = (type: ArtifactType): string => {
    switch (type) {
      case "pr_draft":
        return "prDraft";
      case "evidence_red":
        return "evidenceRed";
      case "submission_intent":
        return "submissionIntent";
      case "validated_patch":
        return "validatedPatch";
      default:
        return type;
    }
  };

  const missingArtifacts = req.requiredArtifacts.filter((art) => {
    const key = toSummaryKey(art);
    const value =
      (runSummary.artifacts as any)[key] ?? (runSummary.artifacts as any)[art];
    return value === undefined;
  });

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

  // Evidence is the first privileged phase and is accepted only when the
  // canonical Evidence V2 producer emitted a complete, content-bound bundle.
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
            ev
              ? `Evidence artifact fails EvidenceBundleV2 semantic validity: ${issue ?? "missing RED/GREEN evidence or verified status."}`
              : "Missing evidence artifact: cannot enter EVIDENCE_COLLECTED without a RED→GREEN evidence bundle.",
          ],
          "Capture the RED baseline: opencontrib evidence capture-red --test-cmd '<cmd>' --assertion '<pattern>', then opencontrib evidence verify-green --test-cmd '<cmd>'.",
        ),
      };
    }

    const invalid = validateEvidenceBundleIdentity(evidence.data);
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

    const validatedResult = ValidatedPatchArtifactSchema.safeParse(
      runSummary.artifacts.validatedPatch,
    );
    const workspaceBase = (runSummary.artifacts.workspace as any)
      ?.baseCommitSha;
    const patchSha256 = hashArtifact(runSummary.artifacts.patch);
    if (
      !validatedResult.success ||
      validatedResult.data.runId !== runSummary.manifest.runId ||
      validatedResult.data.patchSha256 !== patchSha256 ||
      validatedResult.data.baseCommitSha !== workspaceBase ||
      validatedResult.data.redTreeSha256 !==
        evidence.data.redEvidence.sourceTreeSha256 ||
      validatedResult.data.greenTreeSha256 !==
        evidence.data.greenEvidence.sourceTreeSha256 ||
      evidence.data.greenEvidence.appliedPatchSha256 !==
        validatedResult.data.patchSha256 ||
      validatedResult.data.artifactSha256 !==
        hashValidatedPatchArtifact(validatedResult.data) ||
      evidence.data.greenEvidence.validatedPatchArtifactSha256 !==
        validatedResult.data.artifactSha256
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            "ValidatedPatchArtifact must be immutable and bind the current patch, workspace baseCommitSha, RED tree, GREEN tree, and applied patch hash.",
          ],
          "Re-run the canonical EvidenceService GREEN verification; do not edit patch or evidence artifacts afterward.",
        ),
      };
    }
  }

  // Governance is a technical audit phase. Human/policy approval is a separate
  // authority-controlled artifact and is required only for PR_SUBMITTED.
  if (targetPhase === "GOVERNANCE_AUDITED") {
    const gov = runSummary.artifacts.governance;
    let decision = gov
      ? GovernanceDecisionArtifactSchema.safeParse(gov)
      : undefined;
    if (!decision?.success && gov) {
      const legacyAudit = GovernanceAuditResultSchema.safeParse(gov);
      if (legacyAudit.success) {
        decision = {
          success: true,
          data: {
            runId: runSummary.manifest.runId,
            patchSha256: hashArtifact(runSummary.artifacts.patch),
            evidenceSha256: hashArtifact(runSummary.artifacts.evidence),
            prDraftSha256: runSummary.artifacts.prDraft
              ? hashArtifact(runSummary.artifacts.prDraft)
              : undefined,
            prTitle: "chore: contribution",
            prTitleSha256: hashArtifact("chore: contribution"),
            auditResult: legacyAudit.data,
            passed: legacyAudit.data.technicalGate?.status === "PASS",
            auditedAt: new Date().toISOString(),
          },
        } as any;
      }
    }
    if (!decision?.success) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            gov
              ? `Governance artifact fails semantic validity: ${decision?.error.issues[0]?.message ?? "invalid governance decision."}`
              : "Missing governance artifact: cannot enter GOVERNANCE_AUDITED without an authoritative audit result.",
          ],
          "Run the canonical GovernanceService audit after Evidence V2 completes.",
        ),
      };
    }

    const audit = decision.data;
    if (
      !audit.passed ||
      audit.auditResult.technicalGate?.status !== "PASS" ||
      audit.auditResult.technicalGate?.passed !== true
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            "Governance artifact fails semantic validity: technicalGate.status and passed must both be PASS/true.",
          ],
          "Fix the patch/governance audit failures before advancing to GOVERNANCE_AUDITED.",
        ),
      };
    }

    const validatedPatch = ValidatedPatchArtifactSchema.safeParse(
      runSummary.artifacts.validatedPatch,
    );
    const patchSha256 = validatedPatch.success
      ? validatedPatch.data.patchSha256
      : hashArtifact(runSummary.artifacts.patch);
    const evidenceSha256 = hashArtifact(runSummary.artifacts.evidence);
    const prDraftSha256 = runSummary.artifacts.prDraft
      ? hashArtifact(runSummary.artifacts.prDraft)
      : undefined;
    if (
      !validatedPatch.success ||
      audit.patchSha256 !== patchSha256 ||
      audit.evidenceSha256 !== evidenceSha256 ||
      audit.prDraftSha256 !== prDraftSha256
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            "Governance artifact provenance hashes do not match the current patch, evidence, and PR draft artifacts.",
          ],
          "Re-run GovernanceService.audit against the stored run artifacts.",
        ),
      };
    }
  }

  if (targetPhase === "PR_SUBMITTED") {
    const intentResult = SubmissionIntentArtifactSchema.safeParse(
      runSummary.artifacts.submissionIntent,
    );
    const approvalResult = ApprovalArtifactSchema.safeParse(
      runSummary.artifacts.approval,
    );
    const submissionResult = SubmissionArtifactSchema.safeParse(
      runSummary.artifacts.submission,
    );

    if (!intentResult.success || !approvalResult.success) {
      return gateError(
        runSummary,
        targetPhase,
        [
          intentResult.success
            ? undefined
            : "Missing or invalid SubmissionIntentArtifact.",
          approvalResult.success
            ? undefined
            : "Missing or invalid ApprovalArtifact from a trusted approval authority.",
        ],
        "Create a SubmissionIntent and obtain explicit approval from a trusted authority before submitting.",
      );
    }

    const intent = intentResult.data;
    const approval = approvalResult.data;
    const submission = submissionResult.success
      ? submissionResult.data
      : undefined;
    const expectedHashes = currentRunHashes(runSummary);
    const approvalBound =
      approval.runId === runSummary.manifest.runId &&
      approval.intentSha256 === intent.intentSha256 &&
      approval.patchSha256 === expectedHashes.patchSha256 &&
      approval.evidenceSha256 === expectedHashes.evidenceSha256 &&
      approval.governanceSha256 === expectedHashes.governanceSha256 &&
      approval.prBodySha256 === hashArtifact(intent.body);
    const intentBound =
      intent.runId === runSummary.manifest.runId &&
      intent.patchSha256 === expectedHashes.patchSha256 &&
      intent.evidenceSha256 === expectedHashes.evidenceSha256 &&
      intent.governanceSha256 === expectedHashes.governanceSha256 &&
      intent.bodySha256 === hashArtifact(intent.body);
    const submissionBound =
      !!submission &&
      submission.verified === true &&
      submission.runId === runSummary.manifest.runId &&
      submission.intentSha256 === intent.intentSha256 &&
      submission.patchSha256 === approval.patchSha256 &&
      submission.evidenceSha256 === approval.evidenceSha256 &&
      submission.governanceSha256 === approval.governanceSha256 &&
      submission.baseCommitSha === intent.baseCommitSha &&
      submission.owner.toLowerCase() === intent.upstreamOwner.toLowerCase() &&
      submission.repo.toLowerCase() === intent.upstreamRepo.toLowerCase() &&
      submission.baseBranch === intent.baseBranch &&
      submission.branchName === intent.branchName;
    const validPrUrl =
      !!submission &&
      /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9][0-9]*$/i.test(
        submission.prUrl,
      );

    if (!approvalBound || !intentBound || !submissionBound || !validPrUrl) {
      return gateError(
        runSummary,
        targetPhase,
        [
          approvalBound
            ? undefined
            : "ApprovalArtifact hashes do not bind the current intent and run artifacts.",
          intentBound
            ? undefined
            : "SubmissionIntentArtifact hashes do not bind the current run artifacts.",
          submissionResult.success
            ? submissionBound
              ? undefined
              : "SubmissionArtifact does not bind the approved intent, hashes, target, or run-owned branch."
            : "Missing or invalid verified SubmissionArtifact.",
          validPrUrl
            ? undefined
            : "SubmissionArtifact must contain a valid GitHub PR URL.",
        ],
        "Submit only through GitHubSubmissionService after rechecking the immutable intent and approval.",
      );
    }
  }

  if (targetPhase === "COMPLETED") {
    const result = ResultArtifactSchema.safeParse(runSummary.artifacts.result);
    const submission = SubmissionArtifactSchema.safeParse(
      runSummary.artifacts.submission,
    );
    const matches =
      result.success &&
      submission.success &&
      result.data.runId === runSummary.manifest.runId &&
      result.data.submission.runId === submission.data.runId &&
      result.data.submission.intentSha256 === submission.data.intentSha256 &&
      result.data.submission.headSha === submission.data.headSha &&
      result.data.prNumber === submission.data.prNumber &&
      result.data.prUrl === submission.data.prUrl &&
      result.data.submissionVerified === true &&
      submission.data.verified === true;
    if (!matches) {
      return gateError(
        runSummary,
        targetPhase,
        [
          "Result artifact must be a canonical, verified result bound to the stored SubmissionArtifact.",
        ],
        "Sync the flywheel from the verified run after PR_SUBMITTED; do not synthesize a result.",
      );
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

function gateError(
  runSummary: ContributionRunSummary,
  targetPhase: ContributionRunPhase,
  messages: Array<string | undefined>,
  suggestedAction: string,
): { ok: false; error: PhaseGateViolationError } {
  return {
    ok: false,
    error: new PhaseGateViolationError(
      runSummary.manifest.runId,
      runSummary.manifest.currentPhase,
      targetPhase,
      messages.filter((message): message is string => Boolean(message)),
      suggestedAction,
    ),
  };
}

function hashArtifact(value: unknown): string {
  const content =
    typeof value === "string" ? value : JSON.stringify(value ?? "");
  return createHash("sha256").update(content).digest("hex");
}

function currentRunHashes(runSummary: ContributionRunSummary): {
  patchSha256: string;
  evidenceSha256: string;
  governanceSha256: string;
} {
  const validatedPatch = ValidatedPatchArtifactSchema.safeParse(
    runSummary.artifacts.validatedPatch,
  );
  return {
    patchSha256: validatedPatch.success
      ? validatedPatch.data.patchSha256
      : hashArtifact(runSummary.artifacts.patch),
    evidenceSha256: hashArtifact(runSummary.artifacts.evidence),
    governanceSha256: hashArtifact(runSummary.artifacts.governance),
  };
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
    [
      redEvidence.testIdentity.identitySha256 ===
        greenEvidence.testIdentity.identitySha256,
      "TestIdentity mismatch: GREEN test-file contents must equal RED's unless an audited mutation diff matches.",
    ],
    [
      redEvidence.testIdentity.testFiles.length > 0 &&
        greenEvidence.testIdentity.testFiles.length > 0,
      "TestIdentity must resolve at least one concrete test file for both RED and GREEN.",
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

  const identitiesMatch =
    redEvidence.testIdentity.identitySha256 ===
    greenEvidence.testIdentity.identitySha256;
  if (!identitiesMatch) {
    const policy = redEvidence.testMutationPolicy;
    const actual = greenEvidence.actualTestDiffSha256;
    if (
      !policy ||
      policy.allowed !== true ||
      !actual ||
      policy.expectedDiffSha256 !== actual
    ) {
      return "TestIdentity mismatch: GREEN test-file contents must equal RED's unless an audited mutation diff matches.";
    }
    // Replace the identity check with the separately recorded, content-derived
    // mutation proof. A caller-supplied testDiffSha256 is never accepted here.
    checks[4] = [true, checks[4][1]];
  }

  const failed = checks.find(([ok]) => !ok);
  return failed ? failed[1] : undefined;
}
