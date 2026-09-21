/**
 * Automated Benchmark Runner for Dual-Track Contribution Scenarios
 */

import type { BenchmarkResult, BenchmarkScenario, ProtocolAction } from './types.js';

export const STANDARD_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'track-a-0day-ssrf-ipv6',
    isSynthetic: true,
    name: 'Track A: Proactive 0-Day WHATWG IPv6 SSRF Defect Discovery & Remediation',
    track: 'TRACK_A_PROACTIVE_PROBE',
    targetRepo: 'mock/agent-memory-hub',
    expectedDefectCwe: 'CWE-918',
    maxAllowedSteps: 25,
    requiredActionSequence: [
      'contrib_probe_run',
      'contrib_prepare_workspace',
      'contrib_capture_red',
      'contrib_verify_green',
      'contrib_audit_governance',
      'contrib_render_pr_template',
      'contrib_submit_pr',
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
    requiredActionSequence: [
      'contrib_scout',
      'contrib_assemble_context',
      'contrib_prepare_workspace',
      'contrib_capture_red',
      'contrib_verify_green',
      'contrib_audit_governance',
      'contrib_submit_pr',
    ],
  },
];

export function executeBenchmarkScenario(
  scenario: BenchmarkScenario,
  executedActions: ProtocolAction[],
  stepsCount: number,
  durationMs: number,
): BenchmarkResult {
  const errors: string[] = [];

  // 1. Verify action gating sequence against observed protocol actions only.
  let currentIdx = 0;
  for (const reqAction of scenario.requiredActionSequence) {
    const foundIdx = executedActions.findIndex(
      (action, index) => index >= currentIdx && action.toolName === reqAction,
    );
    if (foundIdx === -1) {
      errors.push(`Missing required protocol action: ${reqAction}`);
    } else {
      currentIdx = foundIdx + 1;
    }
  }

  // 2. Verify step economy.
  if (stepsCount > scenario.maxAllowedSteps) {
    errors.push(
      `Step count (${stepsCount}) exceeded maximum budget of ${scenario.maxAllowedSteps} steps.`,
    );
  }

  const missingActionErrors = errors.filter((e) =>
    e.startsWith('Missing required protocol action'),
  );

  return {
    scenarioId: scenario.id,
    success: errors.length === 0,
    stepsTaken: stepsCount,
    durationMs,
    phaseGatingVerified: missingActionErrors.length === 0,
    errors,
  };
}
