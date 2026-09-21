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

// ─── Canonical action definitions (derived from PROTOCOL_CONTRACT_PHASES) ────

/** Tool name → action verb mapping (single source of truth for benchmark). */
export const TOOL_TO_ACTION: Record<string, string> = {
  contrib_create_run: 'CREATE_RUN',
  contrib_scout: 'SCOUT',
  contrib_probe_run: 'PROBE_RUN',
  contrib_assemble_context: 'ASSEMBLE_CONTEXT',
  contrib_prepare_workspace: 'PREPARE_WORKSPACE',
  contrib_capture_red: 'CAPTURE_RED',
  contrib_verify_poc: 'VERIFY_POC',
  contrib_save_artifact: 'SAVE_ARTIFACT',
  contrib_verify_green: 'VERIFY_GREEN',
  contrib_render_pr_template: 'RENDER_PR_TEMPLATE',
  contrib_audit_governance: 'AUDIT_GOVERNANCE',
  contrib_request_approval: 'REQUEST_APPROVAL',
  contrib_submit_pr: 'SUBMIT_PR',
  contrib_sync_flywheel: 'SYNC_FLYWHEEL',
  contrib_resume_run: 'RESUME_RUN',
};

/** Action verb → tool name (reverse lookup for bundle cross-validation). */
const ACTION_TO_TOOL: Record<string, string> = Object.fromEntries(
  Object.entries(TOOL_TO_ACTION).map(([k, v]) => [v, k]),
);

/** Action verb → expected run event phase (for bundle cross-validation). */
const ACTION_TO_PHASE: Record<string, string> = {
  CREATE_RUN: 'INITIALIZED',
  SCOUT: 'OPPORTUNITY_SCOUTED',
  PROBE_RUN: 'PROBE_COMPLETED',
  ASSEMBLE_CONTEXT: 'CONTEXT_ASSEMBLED',
  PREPARE_WORKSPACE: 'WORKSPACE_PREPARED',
  CAPTURE_RED: 'RED_CAPTURED',
  VERIFY_POC: 'POC_GENERATED',
  SAVE_ARTIFACT: 'PATCH_DRAFTED',
  VERIFY_GREEN: 'EVIDENCE_COLLECTED',
  RENDER_PR_TEMPLATE: 'GOVERNANCE_AUDITED',
  AUDIT_GOVERNANCE: 'GOVERNANCE_AUDITED',
  REQUEST_APPROVAL: 'GOVERNANCE_AUDITED',
  SUBMIT_PR: 'PR_SUBMITTED',
  SYNC_FLYWHEEL: 'COMPLETED',
};

/** Action verb → required artifact types (for bundle cross-validation). */
const ACTION_TO_ARTIFACTS: Record<string, string[]> = {
  CREATE_RUN: ['workspace'],
  CAPTURE_RED: ['evidence_red'],
  SAVE_ARTIFACT: ['patch'],
  VERIFY_GREEN: ['evidence', 'validated_patch'],
  AUDIT_GOVERNANCE: ['governance'],
  SUBMIT_PR: ['submission'],
  SYNC_FLYWHEEL: ['result'],
};

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
function checkCreateRunFirst(actions: ProtocolAction[]): string | null {
  const contribActions = actions.filter((a) => a.action in ACTION_TO_TOOL);
  if (contribActions.length === 0) return null;
  const first = contribActions[0];
  if (first.action !== 'CREATE_RUN') {
    return `CREATE_RUN must be the first protocol action (found ${first.action} at step ${first.stepIndex}).`;
  }
  return null;
}

/** Check all canonical ordering constraints. */
function checkOrdering(
  actions: ProtocolAction[],
  required: string[],
): string[] {
  const errors: string[] = [];
  for (const [first, second] of CANONICAL_ORDERING) {
    if (!required.includes(first) || !required.includes(second)) continue;
    const firstIdx = actions.findIndex((a) => a.action === first);
    const secondIdx = actions.findIndex((a) => a.action === second);
    if (firstIdx === -1 || secondIdx === -1) continue; // missing is checked separately
    if (firstIdx >= secondIdx) {
      errors.push(
        `Ordering violation: ${first} (step ${firstIdx}) must precede ${second} (step ${secondIdx}).`,
      );
    }
  }
  return errors;
}

// ─── Scenarios ───────────────────────────────────────────────────────────────

export const STANDARD_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'track-a-0day-ssrf-ipv6',
    isSynthetic: true,
    name: 'Track A: Proactive 0-Day WHATWG IPv6 SSRF Defect Discovery & Remediation',
    track: 'TRACK_A_PROACTIVE_PROBE',
    targetRepo: 'mock/agent-memory-hub',
    expectedDefectCwe: 'CWE-918',
    maxAllowedSteps: 25,
    requiredActions: [
      'CREATE_RUN',
      'PROBE_RUN',
      'PREPARE_WORKSPACE',
      'CAPTURE_RED',
      'SAVE_ARTIFACT',
      'VERIFY_GREEN',
      'RENDER_PR_TEMPLATE',
      'AUDIT_GOVERNANCE',
      'REQUEST_APPROVAL',
      'SUBMIT_PR',
    ],
  },
  {
    id: 'track-b-reactive-mutex-leak',
    isSynthetic: true,
    name: 'Track B: Reactive Open Issue Scouting, Qualification & Mutex Fix',
    track: 'TRACK_B_ISSUE_DISCOVERY',
    targetRepo: 'mock/microservice-go',
    expectedDefectCwe: 'CWE-667',
    maxAllowedSteps: 25,
    requiredActions: [
      'CREATE_RUN',
      'SCOUT',
      'ASSEMBLE_CONTEXT',
      'PREPARE_WORKSPACE',
      'CAPTURE_RED',
      'SAVE_ARTIFACT',
      'VERIFY_GREEN',
      'RENDER_PR_TEMPLATE',
      'AUDIT_GOVERNANCE',
      'REQUEST_APPROVAL',
      'SUBMIT_PR',
    ],
  },
];

// ─── Bundle cross-validation ────────────────────────────────────────────────

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

  if (!bundle.eventPhases || bundle.eventPhases.length === 0) {
    return { verified: false, errors: ['No run events available for cross-validation.'] };
  }

  const phases = new Set(bundle.eventPhases);
  const artifacts = new Set(bundle.artifactTypes ?? []);

  for (const action of actions) {
    if (action.action === 'UNKNOWN') continue;

    // Check that the corresponding phase event exists
    const expectedPhase = ACTION_TO_PHASE[action.action];
    if (expectedPhase && !phases.has(expectedPhase)) {
      errors.push(
        `Transcript action ${action.action} has no corresponding run event (expected phase: ${expectedPhase}).`,
      );
    }

    // Check that required artifacts exist
    const requiredArtifacts = ACTION_TO_ARTIFACTS[action.action];
    if (requiredArtifacts) {
      for (const artifact of requiredArtifacts) {
        if (!artifacts.has(artifact)) {
          errors.push(
            `Transcript action ${action.action} requires artifact "${artifact}" but it is missing from the run bundle.`,
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
  const createRunError = checkCreateRunFirst(executedActions);
  if (createRunError) errors.push(createRunError);

  errors.push(...checkOrdering(executedActions, required));

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
    actionSequenceVerified: missingActionErrors.length === 0,
    runBundleVerified,
    errors,
  };
}
