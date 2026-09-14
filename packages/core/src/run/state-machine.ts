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
