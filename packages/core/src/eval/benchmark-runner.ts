/**
 * Automated Benchmark Runner for Dual-Track Contribution Scenarios
 */

import type { BenchmarkResult, BenchmarkScenario } from './types.js';

export const STANDARD_BENCHMARK_SCENARIOS: BenchmarkScenario[] = [
  {
    id: 'track-a-0day-ssrf-ipv6',
    isSynthetic: true,
    name: 'Track A: Proactive 0-Day WHATWG IPv6 SSRF Defect Discovery & Remediation',
    track: 'TRACK_A_PROACTIVE_PROBE',
    targetRepo: 'mock/agent-memory-hub',
    expectedDefectCwe: 'CWE-918',
    maxAllowedSteps: 25,
    requiredPhaseSequence: [
      'PROBE_SCANNED',
      'WORKSPACE_PREPARED',
      'RED_REPRODUCED',
      'GREEN_FIXED',
      'EVIDENCE_COLLECTED',
      'GOVERNANCE_AUDITED',
      'PR_TEMPLATE_MERGED',
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
    requiredPhaseSequence: [
      'OPPORTUNITY_SCOUTED',
      'CLAIM_QUALIFIED',
      'CONTEXT_ASSEMBLED',
      'WORKSPACE_PREPARED',
      'RED_REPRODUCED',
      'GREEN_FIXED',
      'EVIDENCE_COLLECTED',
      'GOVERNANCE_AUDITED',
      'PR_OPENED',
    ],
  },
];

export function executeBenchmarkScenario(
  scenario: BenchmarkScenario,
  executedPhaseSequence: string[],
  stepsCount: number,
  durationMs: number
): BenchmarkResult {
  const errors: string[] = [];

  // 1. Verify Phase Gating Sequence
  let currentIdx = 0;
  for (const reqPhase of scenario.requiredPhaseSequence) {
    const foundIdx = executedPhaseSequence.indexOf(reqPhase, currentIdx);
    if (foundIdx === -1) {
      errors.push(`Missing required pipeline phase: ${reqPhase}`);
    } else {
      currentIdx = foundIdx + 1;
    }
  }

  // 2. Verify Step Economy
  if (stepsCount > scenario.maxAllowedSteps) {
    errors.push(`Step count (${stepsCount}) exceeded maximum budget of ${scenario.maxAllowedSteps} steps.`);
  }

  const success = errors.length === 0;

  return {
    scenarioId: scenario.id,
    success,
    stepsTaken: stepsCount,
    durationMs,
    phaseGatingVerified: errors.filter((e) => e.startsWith('Missing required')).length === 0,
    errors,
  };
}
