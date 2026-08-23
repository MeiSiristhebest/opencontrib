import type { DefectCategory, FindingSeverity, PointerStub } from '../kernel/contract.js';

export interface TriageWeightsConfig {
  severityWeights?: Partial<Record<FindingSeverity, number>>;
  categoryMultipliers?: Partial<Record<DefectCategory, number>>;
}

export const DEFAULT_SEVERITY_WEIGHTS: Record<FindingSeverity, number> = {
  critical: 100,
  high: 85,
  medium: 60,
  low: 30,
};

export const DEFAULT_CATEGORY_MULTIPLIERS: Record<string, number> = {
  lifecycle_leak: 1.2,
  concurrency_race: 1.2,
  protocol_drift: 1.15,
  security_cwe: 1.1,
  numerical_bounds: 1.05,
  dead_code: 0.9,
  ci_workflow: 0.95,
};

export interface TriagedPointerFinding extends PointerStub {
  triageScore: number;
  resolveCommand: string;
}

export interface TriageOptions {
  limit?: number;
  minConfidence?: number;
  includeAll?: boolean;
  weights?: TriageWeightsConfig;
}

/**
 * Pure domain function to calculate triage score and rank Smart Pointer findings.
 * Follows Pure Functions & Side-Effect Isolation principles.
 */
export function triagePointerFindings(
  pointers: PointerStub[],
  options: TriageOptions = {},
): {
  totalCount: number;
  triagedCount: number;
  topPointers: TriagedPointerFinding[];
  summary: string;
} {
  const { limit = 5, minConfidence = 80, includeAll = false, weights = {} } = options;

  const severityWeights: Record<FindingSeverity, number> = {
    ...DEFAULT_SEVERITY_WEIGHTS,
    ...weights.severityWeights,
  };

  const categoryMultipliers: Record<string, number> = {
    ...DEFAULT_CATEGORY_MULTIPLIERS,
    ...weights.categoryMultipliers,
  };

  const scored: TriagedPointerFinding[] = pointers.map((ptr) => {
    const sevWeight = severityWeights[ptr.severity] || 50;
    const catMult = categoryMultipliers[ptr.category] || 1.0;
    const conf = typeof ptr.confidence === 'number' ? ptr.confidence : 80;
    const triageScore = Math.round(sevWeight * catMult * (conf / 100));

    return {
      ...ptr,
      triageScore,
      resolveCommand: `opencontrib pointer resolve ${ptr.uri} --view slice`,
    };
  });

  const filtered = scored.filter((p) => (p.confidence ?? 80) >= minConfidence);
  const sorted = filtered.sort((a, b) => b.triageScore - a.triageScore);
  const topPointers = includeAll ? sorted : sorted.slice(0, limit);

  return {
    totalCount: pointers.length,
    triagedCount: topPointers.length,
    topPointers,
    summary: `Triaged ${pointers.length} raw findings to top ${topPointers.length} actionable high-value defect pointers (min confidence: ${minConfidence}%).`,
  };
}
