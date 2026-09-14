import {
  ArtifactType,
  ContributionRunPhase,
  ContributionRunSummary,
} from "./types.js";
import { DERIVED_PHASE_REQUIREMENTS } from "../workflow/protocol-contract.js";

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
    const ev = runSummary.artifacts.evidence as
      | Partial<{
          reproductionVerified: boolean;
          allTestsPassing: boolean;
        }>
      | undefined;
    // A RED→GREEN-verified evidence artifact is MANDATORY to enter
    // EVIDENCE_COLLECTED. Missing artifact OR unverified (reproductionVerified
    // !== true) both fail closed. allTestsPassing alone (GREEN without a
    // captured RED baseline) is NOT sufficient.
    if (!ev || ev.reproductionVerified !== true) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            !ev
              ? "Missing evidence artifact: cannot enter EVIDENCE_COLLECTED without a RED→GREEN evidence report."
              : "Evidence artifact fails semantic validity: reproductionVerified must be true (RED baseline required).",
          ],
          "Capture the RED baseline: opencontrib evidence capture-red --test-cmd '<cmd>' --assertion '<pattern>', then opencontrib evidence verify-green --test-cmd '<cmd>'.",
        ),
      };
    }
  }

  if (targetPhase === "COMPLETED") {
    const res = runSummary.artifacts.result as
      | Partial<{
          submissionVerified: boolean;
          prNumber: number;
          prUrl: string;
        }>
      | undefined;
    if (
      res &&
      res.submissionVerified === false &&
      (!res.prNumber || !res.prUrl)
    ) {
      return {
        ok: false,
        error: new PhaseGateViolationError(
          runSummary.manifest.runId,
          currentPhase,
          targetPhase,
          [
            "Result artifact fails semantic validity: PR submission is unverified or missing prNumber/prUrl.",
          ],
          "Submit PR through verified SubmissionService before completing run.",
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
