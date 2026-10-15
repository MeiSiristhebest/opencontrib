import type { DefectCategory, FindingSeverity, PointerStub } from '../kernel/contract.js';
import {
  evaluateDefectSignificance,
  type DefectSignificanceResult,
} from '../domain/defect-value-gate.js';

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
  significance?: DefectSignificanceResult;
}

export interface TriageOptions {
  limit?: number;
  minConfidence?: number;
  includeAll?: boolean;
  weights?: TriageWeightsConfig;
  communityPhilosophy?: 'minimal_core' | 'standard' | 'enterprise';
  /**
   * Filter out low-value defensive anti-patterns and Tier 5 hygiene (Default: true)
   */
  filterAntiPatterns?: boolean;
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
  const {
    limit = 5,
    minConfidence = 80,
    includeAll = false,
    weights = {},
    communityPhilosophy = 'standard',
    filterAntiPatterns = true,
  } = options;

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

    // Evaluate significance using ODCR Universal Standards
    const significance = evaluateDefectSignificance({
      title: ptr.title,
      description: ptr.slice?.ruleExplanation || ptr.slice?.codeSnippet || (ptr as any).description || '',
      category: ptr.category,
      communityPhilosophy,
      hasExecutableRepro: false,
    });

    const significanceMultiplier = significance.isAccepted
      ? 1.0 + (significance.significanceScore / 200) // Up to +50% bonus for Tier 1-3
      : 0.2; // Massive penalty for anti-patterns and Tier 5

    const triageScore = Math.round(sevWeight * catMult * (conf / 100) * significanceMultiplier);

    return {
      ...ptr,
      triageScore,
      significance,
      resolveCommand: `opencontrib pointer resolve ${ptr.uri} --view slice`,
    };
  });

  const validPointers = (filterAntiPatterns && !includeAll)
    ? scored.filter((p) => p.significance?.isAccepted !== false)
    : scored;

  const filtered = validPointers.filter((p) => (p.confidence ?? 80) >= minConfidence);
  const sorted = filtered.sort((a, b) => b.triageScore - a.triageScore);
  const topPointers = includeAll ? sorted : sorted.slice(0, limit);

  return {
    totalCount: pointers.length,
    triagedCount: topPointers.length,
    topPointers,
    summary: `Triaged ${pointers.length} raw findings to top ${topPointers.length} actionable high-value defect pointers (min confidence: ${minConfidence}%, ODCR anti-pattern filter: ${filterAntiPatterns ? 'active' : 'disabled'}).`,
  };
}
