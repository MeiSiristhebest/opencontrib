/**
 * Automated Benchmark Runner for Dual-Track Contribution Scenarios.
 *
 * Required action sequences are derived from PROTOCOL_CONTRACT_PHASES and
 * checked against canonical invariants, not hand-written phase lists.
 * The transcript alone is not sufficient — optional run-bundle cross-validation
 * checks that transcript actions correspond to real run events and artifacts.
 */

import type {
  BenchmarkBundle,
  BenchmarkResult,
  BenchmarkScenario,
  ProtocolAction,
} from './types.js';
import { createHash } from 'node:crypto';
import {
  ApprovalArtifactSchema,
  AuthoritativeRedEvidenceSchema,
  EvidenceBundleV2Schema,
  GovernanceDecisionArtifactSchema,
  IssueBindingArtifactSchema,
  ResultArtifactSchema,
  SecurityDisclosureArtifactSchema,
  SecurityDisclosureEventArtifactSchema,
  SubmissionArtifactSchema,
  SubmissionIntentArtifactSchema,
  ValidatedPatchArtifactSchema,
} from '../contracts/schemas.js';
import {
  PROTOCOL_CONTRACT_PHASES,
  type ProtocolContractPhase,
} from '../workflow/protocol-contract.js';

// ─── Canonical action definitions (derived from PROTOCOL_CONTRACT_PHASES) ────

interface ContractActionDefinition {
  action: string;
  tool: string;
  phase: string;
  requiredArtifacts: string[];
  requiredArtifactRoutes: Array<{
    id: "PUBLIC_ISSUE" | "PRIVATE_SECURITY";
    requiredArtifacts: string[];
  }>;
}

function actionFromTool(tool: string): string {
  return tool.replace(/^contrib_/, '').toUpperCase();
}

function actionsForContractPhase(
  phase: string,
  definition: ProtocolContractPhase,
): ContractActionDefinition[] {
  const configured = definition.benchmark?.actions;
  if (configured && configured.length > 0) {
    return configured.map((entry) => ({
      action: entry.action,
      tool: entry.tool,
      phase,
      requiredArtifacts: [...(entry.requiredArtifacts ?? [])],
      requiredArtifactRoutes: (entry.requiredArtifactRoutes ?? []).map((route) => ({
        id: route.id,
        requiredArtifacts: [...route.requiredArtifacts],
      })),
    }));
  }
  return [
    {
      action: actionFromTool(definition.mcp.tool),
      tool: definition.mcp.tool,
      phase,
      requiredArtifacts: [...(definition.benchmark?.requiredArtifacts ?? [])],
      requiredArtifactRoutes: (definition.benchmark?.requiredArtifactRoutes ?? []).map(
        (route) => ({
          id: route.id,
          requiredArtifacts: [...route.requiredArtifacts],
        }),
      ),
    },
  ];
}

const CONTRACT_ACTIONS: ContractActionDefinition[] = Object.entries(
  PROTOCOL_CONTRACT_PHASES,
).flatMap(([phase, definition]) =>
  actionsForContractPhase(phase, definition),
);

/** Tool name → action verb mapping, derived from the protocol contract. */
export const TOOL_TO_ACTION: Record<string, string> = Object.fromEntries(
  CONTRACT_ACTIONS.map(({ tool, action }) => [tool, action]),
);

/** Action verb → tool name (reverse lookup for bundle cross-validation). */
const ACTION_TO_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_TO_ACTION).map(([k, v]) => [v, k]),
);

/** Action verb → expected run event phase (for bundle cross-validation). */
const ACTION_TO_PHASE: Record<string, string> = Object.fromEntries(
  CONTRACT_ACTIONS.map(({ action, phase }) => [action, phase]),
);

/** Action verb → required artifact types (for bundle cross-validation). */
const ACTION_TO_ARTIFACTS: Record<string, string[]> = Object.fromEntries(
  CONTRACT_ACTIONS.map(({ action, requiredArtifacts }) => [
    action,
    requiredArtifacts,
  ]),
);

/** Action verb → policy-dependent artifact alternatives. */
const ACTION_TO_ARTIFACT_ROUTES: Record<
  string,
  ContractActionDefinition["requiredArtifactRoutes"]
> = Object.fromEntries(
  CONTRACT_ACTIONS.map(({ action, requiredArtifactRoutes }) => [
    action,
    requiredArtifactRoutes,
  ]),
);

// ─── Canonical invariants ────────────────────────────────────────────────────

/** Ordering pairs that must hold for any valid run: first < second. */
const CANONICAL_ORDERING: [string, string][] = [
  ['CAPTURE_RED', 'SAVE_ARTIFACT'],
  ['SAVE_ARTIFACT', 'VERIFY_GREEN'],
  ['RENDER_PR_TEMPLATE', 'AUDIT_GOVERNANCE'],
  ['AUDIT_GOVERNANCE', 'REQUEST_APPROVAL'],
  ['REQUEST_APPROVAL', 'SUBMIT_PR'],
];

/** Check that the first non-noise action in the transcript is CREATE_RUN. */
interface BenchmarkInvariantIssue {
  code: "CREATE_RUN_ORDER" | "CANONICAL_ORDER";
  message: string;
}

function checkCreateRunFirst(
  actions: ProtocolAction[],
): BenchmarkInvariantIssue | null {
  const contribActions = actions.filter((a) => a.action in ACTION_TO_TOOL);
  if (contribActions.length === 0) return null;
  const first = contribActions[0];
  if (first.action !== 'CREATE_RUN') {
    return {
      code: "CREATE_RUN_ORDER",
      message: `CREATE_RUN must be the first protocol action (found ${first.action} at step ${first.stepIndex}).`,
    };
  }
  return null;
}

/** Check all canonical ordering constraints. */
function checkOrdering(
  actions: ProtocolAction[],
  required: string[],
): BenchmarkInvariantIssue[] {
  const errors: BenchmarkInvariantIssue[] = [];
  for (const [first, second] of CANONICAL_ORDERING) {
    if (!required.includes(first) || !required.includes(second)) continue;
    const firstIdx = actions.findIndex((a) => a.action === first);
    const secondIdx = actions.findIndex((a) => a.action === second);
    if (firstIdx === -1 || secondIdx === -1) continue; // missing is checked separately
    if (firstIdx >= secondIdx) {
      errors.push({
        code: "CANONICAL_ORDER",
        message: `Ordering violation: ${first} (step ${firstIdx}) must precede ${second} (step ${secondIdx}).`,
      });
    }
  }
  return errors;
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

function actionsForPhases(phases: string[]): string[] {
  return phases.flatMap((phase) =>
    CONTRACT_ACTIONS.filter((definition) => definition.phase === phase).map(
      (definition) => definition.action,
    ),
  );
}

const TRACK_A_PHASES = [
  'INITIALIZED',
  'PROBE_COMPLETED',
  'WORKSPACE_PREPARED',
  'RED_CAPTURED',
  'PATCH_DRAFTED',
  'EVIDENCE_COLLECTED',
  'GOVERNANCE_AUDITED',
  'PR_SUBMITTED',
];

const TRACK_B_PHASES = [
  'INITIALIZED',
  'OPPORTUNITY_SCOUTED',
  'CONTEXT_ASSEMBLED',
  'WORKSPACE_PREPARED',
  'RED_CAPTURED',
  'PATCH_DRAFTED',
  'EVIDENCE_COLLECTED',
  'GOVERNANCE_AUDITED',
  'PR_SUBMITTED',
];

export const STANDARD_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'track-a-0day-ssrf-ipv6',
    isSynthetic: true,
    name: 'Track A: Proactive 0-Day WHATWG IPv6 SSRF Defect Discovery & Remediation',
    track: 'TRACK_A_PROACTIVE_PROBE',
    targetRepo: 'mock/agent-memory-hub',
    expectedDefectCwe: 'CWE-918',
    maxAllowedSteps: 25,
    requiredActions: actionsForPhases(TRACK_A_PHASES),
  },
  {
    id: 'track-b-reactive-mutex-leak',
    isSynthetic: true,
    name: 'Track B: Reactive Open Issue Scouting, Qualification & Mutex Fix',
    track: 'TRACK_B_ISSUE_DISCOVERY',
    targetRepo: 'mock/microservice-go',
    expectedDefectCwe: 'CWE-667',
    maxAllowedSteps: 25,
    requiredActions: actionsForPhases(TRACK_B_PHASES),
  },
];

// ─── Bundle cross-validation ────────────────────────────────────────────────

function hashBundleArtifact(value: unknown): string {
  const content = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return createHash('sha256').update(content).digest('hex');
}

function hasBundleArtifact(bundle: BenchmarkBundle, type: string): boolean {
  if (bundle.artifacts) {
    if (
      Object.prototype.hasOwnProperty.call(bundle.artifacts, type) &&
      bundle.artifacts[type] !== undefined
    ) {
      return true;
    }
  }
  return new Set(bundle.artifactTypes ?? []).has(type);
}

function validateBundleArtifacts(bundle: BenchmarkBundle): string[] {
  if (!bundle.artifacts) return [];
  const errors: string[] = [];
  const schemas: Record<string, { safeParse(value: unknown): { success: boolean; error?: { issues: Array<{ message: string }> } } }> = {
    evidence_red: AuthoritativeRedEvidenceSchema,
    validated_patch: ValidatedPatchArtifactSchema,
    evidence: EvidenceBundleV2Schema,
    governance: GovernanceDecisionArtifactSchema,
    submission_intent: SubmissionIntentArtifactSchema,
    approval: ApprovalArtifactSchema,
    submission: SubmissionArtifactSchema,
    result: ResultArtifactSchema,
    issue_binding: IssueBindingArtifactSchema,
    security_disclosure: SecurityDisclosureArtifactSchema,
    security_disclosure_event: SecurityDisclosureEventArtifactSchema,
  };

  for (const [type, schema] of Object.entries(schemas)) {
    if (
      !bundle.artifacts ||
      !Object.prototype.hasOwnProperty.call(bundle.artifacts, type) ||
      bundle.artifacts[type] === undefined
    ) {
      continue;
    }
    const result = schema.safeParse(bundle.artifacts[type]);
    if (!result.success) {
      errors.push(
        `Artifact "${type}" failed canonical schema validation: ${result.error?.issues[0]?.message ?? 'invalid artifact'}.`,
      );
    }
  }

  for (const [type, value] of Object.entries(bundle.artifacts)) {
    if (!value || typeof value !== 'object') continue;
    const artifactRunId = (value as Record<string, unknown>).runId;
    if (
      typeof artifactRunId === 'string' &&
      bundle.manifest?.runId &&
      artifactRunId !== bundle.manifest.runId
    ) {
      errors.push(
        `Artifact "${type}" runId (${artifactRunId}) does not match bundle manifest runId (${bundle.manifest.runId}).`,
      );
    }
  }

  const patch = bundle.artifacts.patch;
  const validatedPatch = bundle.artifacts.validated_patch as Record<string, unknown> | undefined;
  if (patch !== undefined && validatedPatch?.patchSha256 !== undefined) {
    if (validatedPatch.patchSha256 !== hashBundleArtifact(patch)) {
      errors.push('validated_patch.patchSha256 does not match the canonical patch artifact.');
    }
  }

  const evidence = bundle.artifacts.evidence as Record<string, unknown> | undefined;
  const greenEvidence = evidence?.greenEvidence as Record<string, unknown> | undefined;
  if (
    greenEvidence?.validatedPatchArtifactSha256 &&
    validatedPatch !== undefined &&
    greenEvidence.validatedPatchArtifactSha256 !== hashBundleArtifact(validatedPatch)
  ) {
    errors.push('evidence.greenEvidence.validatedPatchArtifactSha256 does not match validated_patch.');
  }

  const governance = bundle.artifacts.governance as Record<string, unknown> | undefined;
  if (governance && patch !== undefined && governance.patchSha256 !== hashBundleArtifact(patch)) {
    errors.push('governance.patchSha256 does not match the canonical patch artifact.');
  }
  if (governance && evidence !== undefined && governance.evidenceSha256 !== hashBundleArtifact(evidence)) {
    errors.push('governance.evidenceSha256 does not match the canonical evidence artifact.');
  }

  const intent = bundle.artifacts.submission_intent as Record<string, unknown> | undefined;
  if (intent) {
    if (typeof intent.body === 'string' && intent.bodySha256 !== hashBundleArtifact(intent.body)) {
      errors.push('submission_intent.bodySha256 does not match the canonical PR body.');
    }
    if (patch !== undefined && intent.patchSha256 !== hashBundleArtifact(patch)) {
      errors.push('submission_intent.patchSha256 does not match the canonical patch artifact.');
    }
    if (evidence !== undefined && intent.evidenceSha256 !== hashBundleArtifact(evidence)) {
      errors.push('submission_intent.evidenceSha256 does not match the canonical evidence artifact.');
    }
    if (governance !== undefined && intent.governanceSha256 !== hashBundleArtifact(governance)) {
      errors.push('submission_intent.governanceSha256 does not match the canonical governance artifact.');
    }
  }

  const approval = bundle.artifacts.approval as Record<string, unknown> | undefined;
  if (approval && intent) {
    const approvalBindings: Array<[string, string, string]> = [
      ['intentSha256', 'intentSha256', 'approval.intentSha256 does not match submission_intent.intentSha256.'],
      ['patchSha256', 'patchSha256', 'approval.patchSha256 does not match submission_intent.patchSha256.'],
      ['evidenceSha256', 'evidenceSha256', 'approval.evidenceSha256 does not match submission_intent.evidenceSha256.'],
      ['governanceSha256', 'governanceSha256', 'approval.governanceSha256 does not match submission_intent.governanceSha256.'],
      ['prBodySha256', 'bodySha256', 'approval.prBodySha256 does not match submission_intent.bodySha256.'],
    ];
    for (const [approvalKey, intentKey, message] of approvalBindings) {
      if (approval[approvalKey] !== intent[intentKey]) errors.push(message);
    }
    if (governance && approval.policySha256 !== governance.policySha256) {
      errors.push('approval.policySha256 does not match governance.policySha256.');
    }
    if (governance && approval.communityGateSha256 !== governance.communityGateSha256) {
      errors.push('approval.communityGateSha256 does not match governance.communityGateSha256.');
    }
  }

  const submission = bundle.artifacts.submission as Record<string, unknown> | undefined;
  if (submission && approval) {
    const submissionBindings: Array<[string, string, string]> = [
      ['runId', 'runId', 'submission.runId does not match approval.runId.'],
      ['intentSha256', 'intentSha256', 'submission.intentSha256 does not match approval.intentSha256.'],
      ['patchSha256', 'patchSha256', 'submission.patchSha256 does not match approval.patchSha256.'],
      ['evidenceSha256', 'evidenceSha256', 'submission.evidenceSha256 does not match approval.evidenceSha256.'],
      ['governanceSha256', 'governanceSha256', 'submission.governanceSha256 does not match approval.governanceSha256.'],
      ['policySha256', 'policySha256', 'submission.policySha256 does not match approval.policySha256.'],
      ['communityGateSha256', 'communityGateSha256', 'submission.communityGateSha256 does not match approval.communityGateSha256.'],
    ];
    for (const [submissionKey, approvalKey, message] of submissionBindings) {
      if (submission[submissionKey] !== approval[approvalKey]) errors.push(message);
    }
  }

  const result = bundle.artifacts.result as Record<string, unknown> | undefined;
  const resultSubmission = result?.submission as Record<string, unknown> | undefined;
  if (result && resultSubmission && submission) {
    if (result.runId !== bundle.manifest?.runId || resultSubmission.runId !== submission.runId) {
      errors.push('result and nested submission must match the canonical run identity.');
    }
    if (result.prNumber !== submission.prNumber || result.prUrl !== submission.prUrl) {
      errors.push('result PR identity does not match the canonical submission artifact.');
    }
  }

  return errors;
}

function validateBundleEvents(bundle: BenchmarkBundle): string[] {
  if (!bundle.events) return [];

  const errors: string[] = [];
  const eventIds = new Set<string>();
  let previousTimestamp = Number.NEGATIVE_INFINITY;
  let previousPhase: string | undefined;

  for (const event of bundle.events) {
    if (eventIds.has(event.eventId)) {
      errors.push(`Run event id ${event.eventId} is duplicated.`);
    }
    eventIds.add(event.eventId);

    const timestamp =
      typeof event.timestamp === "string"
        ? Date.parse(event.timestamp)
        : Number.NaN;
    if (!Number.isFinite(timestamp)) {
      errors.push(`Run event ${event.eventId} has an invalid timestamp.`);
    } else if (timestamp < previousTimestamp) {
      errors.push(`Run events are not ordered by timestamp at event ${event.eventId}.`);
    } else {
      previousTimestamp = timestamp;
    }

    const definition = PROTOCOL_CONTRACT_PHASES[
      event.phase as keyof typeof PROTOCOL_CONTRACT_PHASES
    ];
    if (!definition) {
      errors.push(`Run event ${event.eventId} has an unknown phase ${event.phase}.`);
    } else if (
      previousPhase &&
      previousPhase !== event.phase &&
      !(definition.allowedFromPhases as readonly string[]).includes(previousPhase)
    ) {
      errors.push(
        `Run event ${event.eventId} moves from ${previousPhase} to ${event.phase}, which is not allowed by the protocol DAG.`,
      );
    }

    if (typeof event.eventType !== "string" || !event.eventType.trim()) {
      errors.push(`Run event ${event.eventId} is missing eventType.`);
    }
    if (event.eventType === "RUN_CREATED" && event.phase !== "INITIALIZED") {
      errors.push(`RUN_CREATED event ${event.eventId} must be in INITIALIZED.`);
    }
    if (event.eventType === "PHASE_TRANSITION") {
      const payload = event.payload;
      if (
        !payload ||
        typeof payload.fromPhase !== "string" ||
        typeof payload.toPhase !== "string" ||
        payload.toPhase !== event.phase
      ) {
        errors.push(
          `PHASE_TRANSITION event ${event.eventId} must bind fromPhase/toPhase to its phase.`,
        );
      } else if (previousPhase && payload.fromPhase !== previousPhase) {
        errors.push(
          `PHASE_TRANSITION event ${event.eventId} claims fromPhase ${payload.fromPhase}, but the previous canonical phase is ${previousPhase}.`,
        );
      }
    }
    if (event.eventType === "ARTIFACT_SAVED") {
      if (!event.payload || typeof event.payload.artifactType !== "string") {
        errors.push(
          `ARTIFACT_SAVED event ${event.eventId} must identify its artifactType.`,
        );
      }
    }
    if (definition) previousPhase = event.phase;
  }

  return errors;
}

/**
 * Cross-validate transcript actions against the run bundle.
 * Checks that each transcript action has a corresponding run event and
 * required artifacts. This prevents a forged transcript from passing.
 */
export function crossValidateWithBundle(
  actions: ProtocolAction[],
  bundle: BenchmarkBundle,
): { verified: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!bundle.manifest?.runId || !bundle.manifest.currentPhase) {
    errors.push('Canonical manifest is required and must contain runId and currentPhase.');
  } else if (!Object.prototype.hasOwnProperty.call(PROTOCOL_CONTRACT_PHASES, bundle.manifest.currentPhase)) {
    errors.push(`Canonical manifest currentPhase is unknown: ${bundle.manifest.currentPhase}.`);
  }
  if (bundle.parseErrors?.length) {
    errors.push(...bundle.parseErrors.map((error) => `Run bundle parse error: ${error}`));
  }

  const eventPhases = bundle.events?.map((event) => event.phase) ?? bundle.eventPhases ?? [];
  if (eventPhases.length === 0) {
    return { verified: false, errors: ['No run events available for cross-validation.'] };
  }

  if (bundle.events && bundle.manifest?.runId) {
    for (const event of bundle.events) {
      if (event.runId !== bundle.manifest.runId) {
        errors.push(
          `Run event ${event.eventId} runId (${event.runId}) does not match bundle manifest runId (${bundle.manifest.runId}).`,
        );
      }
    }
  }
  if (bundle.events?.length && bundle.manifest?.currentPhase) {
    const lastEvent = bundle.events[bundle.events.length - 1];
    if (lastEvent.phase !== bundle.manifest.currentPhase) {
      errors.push(
        `Last run event phase (${lastEvent.phase}) does not match manifest currentPhase (${bundle.manifest.currentPhase}).`,
      );
    }
  }

  const phases = new Set(eventPhases);
  const bundleRunId = bundle.manifest?.runId;
  const strictIdentity = Boolean(bundleRunId);
  errors.push(...validateBundleEvents(bundle));
  const artifactErrors = validateBundleArtifacts(bundle);
  errors.push(...artifactErrors);
  let phaseCursor = -1;
  let previousPhase: string | undefined;

  for (const action of actions) {
    if (action.action === 'UNKNOWN') continue;

    if (strictIdentity) {
      if (action.action === 'CREATE_RUN') {
        // CREATE_RUN cannot know its id at ingress. Only the provider/tool
        // result is authoritative for the run identity it created.
        const createdRunId = action.outputRunId;
        if (!createdRunId) {
          errors.push(
            'Transcript action CREATE_RUN is missing the runId returned by its tool result.',
          );
        } else if (createdRunId !== bundleRunId) {
          errors.push(
            `CREATE_RUN output runId (${createdRunId}) does not match bundle manifest runId (${bundleRunId}).`,
          );
        }
        if (
          bundle.events &&
          !bundle.events.some(
            (event) =>
              event.eventType === "RUN_CREATED" &&
              event.phase === "INITIALIZED",
          )
        ) {
          errors.push("CREATE_RUN has no canonical RUN_CREATED event.");
        }
      } else {
        const inputRunId = action.inputRunId ?? action.runId;
        if (!inputRunId) {
          errors.push(
            `Transcript action ${action.action} is missing runId and cannot be bound to the canonical run bundle.`,
          );
        } else if (inputRunId !== bundleRunId) {
          errors.push(
            `Transcript action runId (${inputRunId}) does not match bundle manifest runId (${bundleRunId}).`,
          );
        }
      }
    }

    // Check that the corresponding phase event exists
    const expectedPhase = ACTION_TO_PHASE[action.action];
    if (expectedPhase && !phases.has(expectedPhase)) {
      errors.push(
        `Transcript action ${action.action} has no corresponding run event (expected phase: ${expectedPhase}).`,
      );
    } else if (expectedPhase) {
      const canReuseCurrentPhase = previousPhase === expectedPhase;
      const nextPhaseIndex = canReuseCurrentPhase
        ? phaseCursor
        : eventPhases.findIndex(
            (phase, index) => index > phaseCursor && phase === expectedPhase,
          );
      if (nextPhaseIndex === -1) {
        errors.push(
          `Transcript action ${action.action} is out of event order (expected phase: ${expectedPhase}).`,
        );
      } else {
        phaseCursor = nextPhaseIndex;
        previousPhase = expectedPhase;
      }
    }

    // Check policy-dependent artifact routes before ordinary requirements.
    const artifactRoutes = ACTION_TO_ARTIFACT_ROUTES[action.action] ?? [];
    if (artifactRoutes.length > 0) {
      const workspace = bundle.artifacts?.workspace as
        | { communityGate?: { policy?: { privateVulnerabilityDisclosure?: boolean } } }
        | undefined;
      const privateRoute =
        workspace?.communityGate?.policy?.privateVulnerabilityDisclosure === true;
      const routeId = privateRoute ? "PRIVATE_SECURITY" : "PUBLIC_ISSUE";
      const route = artifactRoutes.find((candidate) => candidate.id === routeId);
      if (!route) {
        errors.push(
          `Transcript action ${action.action} has no protocol route for ${routeId}.`,
        );
      } else {
        for (const artifact of route.requiredArtifacts) {
          if (!hasBundleArtifact(bundle, artifact)) {
            errors.push(
              `Transcript action ${action.action} requires ${routeId} artifact "${artifact}" but it is missing from the run bundle.`,
            );
          }
          if (
            bundle.events &&
            !bundle.events.some(
              (event) =>
                event.eventType === "ARTIFACT_SAVED" &&
                event.payload?.artifactType === artifact,
            )
          ) {
            errors.push(
              `Transcript action ${action.action} has no ARTIFACT_SAVED event for ${routeId} artifact "${artifact}".`,
            );
          }
        }
      }
    }

    // Check ordinary required artifacts.
    const requiredArtifacts = ACTION_TO_ARTIFACTS[action.action];
    if (requiredArtifacts) {
      for (const artifact of requiredArtifacts) {
        if (!hasBundleArtifact(bundle, artifact)) {
          errors.push(
            `Transcript action ${action.action} requires artifact "${artifact}" but it is missing from the run bundle.`,
          );
        }
        if (
          bundle.events &&
          !bundle.events.some(
            (event) =>
              event.eventType === "ARTIFACT_SAVED" &&
              event.payload?.artifactType === artifact,
          )
        ) {
          errors.push(
            `Transcript action ${action.action} has no ARTIFACT_SAVED event for artifact "${artifact}".`,
          );
        }
      }
    }
  }

  return { verified: errors.length === 0, errors };
}

// ─── Main evaluation ─────────────────────────────────────────────────────────

export function executeBenchmarkScenario(
  scenario: BenchmarkScenario,
  executedActions: ProtocolAction[],
  stepsCount: number,
  durationMs: number,
  bundle?: BenchmarkBundle,
): BenchmarkResult {
  const errors: string[] = [];
  const required = scenario.requiredActions;

  // 1. Verify required actions are present and in order.
  let currentIdx = 0;
  for (const reqAction of required) {
    const foundIdx = executedActions.findIndex(
      (action, index) => index >= currentIdx && action.action === reqAction,
    );
    if (foundIdx === -1) {
      errors.push(`Missing required action: ${reqAction}`);
    } else {
      currentIdx = foundIdx + 1;
    }
  }

  // 2. Verify canonical invariants.
  const invariantIssues: BenchmarkInvariantIssue[] = [];
  const createRunError = checkCreateRunFirst(executedActions);
  if (createRunError) invariantIssues.push(createRunError);
  invariantIssues.push(...checkOrdering(executedActions, required));
  errors.push(...invariantIssues.map((issue) => issue.message));

  // 3. Verify step economy.
  if (stepsCount > scenario.maxAllowedSteps) {
    errors.push(
      `Step count (${stepsCount}) exceeded maximum budget of ${scenario.maxAllowedSteps} steps.`,
    );
  }

  // 4. Cross-validate with run bundle (if provided).
  let runBundleVerified: boolean | undefined;
  if (bundle) {
    const { verified, errors: bundleErrors } = crossValidateWithBundle(
      executedActions,
      bundle,
    );
    runBundleVerified = verified;
    errors.push(...bundleErrors);
  }

  const missingActionErrors = errors.filter((e) =>
    e.startsWith('Missing required action'),
  );

  return {
    scenarioId: scenario.id,
    success: errors.length === 0,
    stepsTaken: stepsCount,
    durationMs,
    actionSequenceVerified:
      missingActionErrors.length === 0 && invariantIssues.length === 0,
    runBundleVerified,
    errors,
  };
}
