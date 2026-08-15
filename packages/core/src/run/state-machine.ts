import { ArtifactType, ContributionRunPhase, ContributionRunSummary } from './types.js';

export class PhaseGateViolationError extends Error {
  constructor(
    public readonly runId: string,
    public readonly currentPhase: ContributionRunPhase,
    public readonly targetPhase: ContributionRunPhase,
    public readonly missingPrerequisites: string[],
    public readonly suggestedAction: string
  ) {
    super(
      `[PhaseGateViolation] Run ${runId} is in phase '${currentPhase}', cannot transition to '${targetPhase}'. ` +
        `Missing prerequisites: ${missingPrerequisites.join(', ')}. ` +
        `Suggested next action: ${suggestedAction}`
    );
    this.name = 'PhaseGateViolationError';
  }
}

export interface PhaseTransitionRequirement {
  fromPhases: ContributionRunPhase[];
  requiredArtifacts: ArtifactType[];
  suggestedAction: string;
}

export const PHASE_REQUIREMENTS: Record<ContributionRunPhase, PhaseTransitionRequirement> = {
  INITIALIZED: {
    fromPhases: [],
    requiredArtifacts: [],
    suggestedAction: 'Call contrib_scout or contrib_qualify_issue to identify contribution target.',
  },
  OPPORTUNITY_SCOUTED: {
    fromPhases: ['INITIALIZED'],
    requiredArtifacts: ['opportunity'],
    suggestedAction: 'Call contrib_assemble_context or contrib_prepare_workspace.',
  },
  CONTEXT_ASSEMBLED: {
    fromPhases: ['INITIALIZED', 'OPPORTUNITY_SCOUTED'],
    requiredArtifacts: ['context'],
    suggestedAction: 'Call contrib_prepare_workspace to create isolated sandbox.',
  },
  WORKSPACE_PREPARED: {
    fromPhases: ['INITIALIZED', 'OPPORTUNITY_SCOUTED', 'CONTEXT_ASSEMBLED'],
    requiredArtifacts: ['workspace'],
    suggestedAction: 'Develop reproduction test and capture pre-fix failure baseline.',
  },
  PATCH_DRAFTED: {
    fromPhases: ['WORKSPACE_PREPARED'],
    requiredArtifacts: ['workspace'],
    suggestedAction: 'Run verification tests and call contrib_collect_evidence.',
  },
  EVIDENCE_COLLECTED: {
    fromPhases: ['WORKSPACE_PREPARED', 'PATCH_DRAFTED'],
    requiredArtifacts: ['workspace', 'evidence'],
    suggestedAction: 'Call contrib_collect_evidence to capture reproduction baseline.',
  },
  GOVERNANCE_AUDITED: {
    fromPhases: ['EVIDENCE_COLLECTED'],
    requiredArtifacts: ['workspace', 'evidence', 'governance'],
    suggestedAction: 'Call contrib_audit_governance to audit patch quality and anti-AI rubric.',
  },
  PR_SUBMITTED: {
    fromPhases: ['GOVERNANCE_AUDITED'],
    requiredArtifacts: ['workspace', 'evidence', 'governance'],
    suggestedAction: 'Call contrib_render_pr_template to prepare PR description.',
  },
  COMPLETED: {
    fromPhases: ['PR_SUBMITTED'],
    requiredArtifacts: ['workspace'],
    suggestedAction: 'Run is complete. Call contrib_sync_flywheel if needed.',
  },
  FAILED: {
    fromPhases: [
      'INITIALIZED',
      'OPPORTUNITY_SCOUTED',
      'CONTEXT_ASSEMBLED',
      'WORKSPACE_PREPARED',
      'PATCH_DRAFTED',
      'EVIDENCE_COLLECTED',
      'GOVERNANCE_AUDITED',
      'PR_SUBMITTED',
    ],
    requiredArtifacts: [],
    suggestedAction: 'Inspect error logs and resume run with contrib_resume_run.',
  },
};

export function validatePhaseGate(
  runSummary: ContributionRunSummary,
  targetPhase: ContributionRunPhase
): { ok: boolean; error?: PhaseGateViolationError } {
  const req = PHASE_REQUIREMENTS[targetPhase];
  if (!req) return { ok: true };

  const currentPhase = runSummary.manifest.currentPhase;
  const availableArtifacts = Object.keys(runSummary.artifacts) as ArtifactType[];

  const missingArtifacts = req.requiredArtifacts.filter(
    (art) => !availableArtifacts.includes(art) || runSummary.artifacts[art as keyof typeof runSummary.artifacts] === undefined
  );

  if (missingArtifacts.length > 0) {
    return {
      ok: false,
      error: new PhaseGateViolationError(
        runSummary.manifest.runId,
        currentPhase,
        targetPhase,
        missingArtifacts.map((a) => `Missing artifact: ${a}`),
        req.suggestedAction
      ),
    };
  }

  if (targetPhase !== 'FAILED' && req.fromPhases.length > 0 && !req.fromPhases.includes(currentPhase)) {
    return {
      ok: false,
      error: new PhaseGateViolationError(
        runSummary.manifest.runId,
        currentPhase,
        targetPhase,
        [`Phase '${currentPhase}' is not an allowed precursor to '${targetPhase}'`],
        req.suggestedAction
      ),
    };
  }

  return { ok: true };
}
