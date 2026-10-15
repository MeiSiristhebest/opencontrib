/**
 * Universal Open-Source Defect & Contribution Rubric (ODCR v2.0)
 *
 * Pure domain logic: Evaluates defect candidates against real-world open-source
 * maintainer standards, preventing pedantic defensive programming and low-value noise.
 */

export type DefectTier =
  | 'tier1_critical'          // Critical systemic breach: Security, data corruption, process crash
  | 'tier2_concurrency'       // Concurrency & lifecycle: Deadlock, resource/fd leak, infinite spin/hang
  | 'tier3_contract_drift'     // Protocol & state machine contract drift: state machine inconsistency, bypassed decisions
  | 'tier4_environment'        // Cross-platform, network proxy, path/locale invariants
  | 'tier5_internal_hygiene';  // Trivial defensive checks, typo, style, dead defense (REJECTED by default)

export type DefectAntiPattern =
  | 'GHOST_HUNTING_DEFENSE'        // Speculative null/type checks in internal scope where invariants already hold
  | 'TRIVIAL_UNWRAP_SWALLOWING'    // Mechanically changing unwrap to unwrap_or_default / swallowing errors
  | 'SPECULATIVE_OVER_ENGINEERING' // Adding premature abstractions, factories, or options in a minimal core
  | 'STYLE_LINTER_CHURN'           // Whitespace, imports, or variable renaming that pollutes git blame
  | 'NO_REPRODUCER_THEORETICAL'    // Speculative complaints with no executable test or reproduction
  | 'AI_BOILERPLATE_FLUFF';        // Generic AI template phrases and fluff

export interface DefectEvaluationInput {
  title: string;
  description: string;
  proposedFix?: string;
  category?: string;
  language?: string;
  isPublicApiOrCli?: boolean;
  hasExecutableRepro?: boolean;
  isInternalPrivateScope?: boolean;
  communityPhilosophy?: 'minimal_core' | 'standard' | 'enterprise';
}

export interface DefectSignificanceResult {
  isAccepted: boolean;
  tier: DefectTier;
  detectedAntiPatterns: DefectAntiPattern[];
  rejectionReasons: string[];
  significanceScore: number; // 0 - 100
  requiredEvidence: string[];
}

const TIER1_KEYWORDS = [
  /\b(?:cwe-\d+|ssrf|rce|remote code execution|prototype pollution|sql injection|path traversal|arbitrary file read)\b/i,
  /\b(?:data corruption|memory corruption|heap buffer overflow|use-after-free|double-free)\b/i,
  /\b(?:auth bypass|authentication bypass|privilege escalation)\b/i,
];

const TIER2_KEYWORDS = [
  /\b(?:deadlock|data race|race condition|goroutine leak|memory leak|fd leak|socket leak|handle leak)\b/i,
  /\b(?:infinite loop|infinite spin|busy-wait|100% cpu|hang forever|process freeze)\b/i,
  /\b(?:unhandled promise rejection|crash on start|panic on launch)\b/i,
];

const TIER3_KEYWORDS = [
  /\b(?:contract drift|state machine|inconsistent state|short-circuit|ignored decision)\b/i,
  /\b(?:protocol violation|serialization drift|deserialization error|truncated response|missing event)\b/i,
  /\b(?:clock monotonicity|dst jump|time rollback)\b/i,
];

const TIER4_KEYWORDS = [
  /\b(?:no_proxy|http_proxy|crlf|filepath|backslash|cross-platform|windows path|case-insensitive)\b/i,
  /\b(?:locale|unicode normalization|cjk punctuation|encoding)\b/i,
];

const TIER5_KEYWORDS = [
  /\b(?:typo|spelling|readme|format|formatting|code style|whitespace|indentation)\b/i,
  /\b(?:rename variable|unused import|dead code removal|defensive check)\b/i,
  /\b(?:add null check|optional chaining|just in case|theoretical)\b/i,
];

/**
 * Evaluates whether a proposed defect or candidate conforms to real-world OSS quality.
 */
export function evaluateDefectSignificance(
  input: DefectEvaluationInput,
): DefectSignificanceResult {
  const fullText = `${input.title} ${input.description} ${input.proposedFix || ''}`.toLowerCase();
  const detectedAntiPatterns: DefectAntiPattern[] = [];
  const rejectionReasons: string[] = [];

  // 1. Anti-Pattern: TRIVIAL_UNWRAP_SWALLOWING
  if (
    /unwrap_or_default\(\)|unwrap_or\(|except Exception:\s*pass|catch\s*\([^)]*\)\s*\{\s*\}|catch\s*\{\s*return\s+(?:false|null|undefined);?\s*\}/i.test(
      fullText,
    )
  ) {
    detectedAntiPatterns.push('TRIVIAL_UNWRAP_SWALLOWING');
    rejectionReasons.push(
      'Rejected: Trivial unwrap/exception swallowing masks underlying logic errors and destroys fail-fast invariants.',
    );
  }

  // 2. Anti-Pattern: GHOST_HUNTING_DEFENSE
  const hasGhostDefenseWords =
    /\b(?:just in case|defensively check|might be null|safeguard against null|defensive guard)\b/i.test(
      fullText,
    );
  if (
    (input.isInternalPrivateScope === true || hasGhostDefenseWords) &&
    !input.isPublicApiOrCli &&
    !input.hasExecutableRepro
  ) {
    detectedAntiPatterns.push('GHOST_HUNTING_DEFENSE');
    rejectionReasons.push(
      'Rejected: Ghost-hunting defensive checks in private/internal scope without external entry reachability proof.',
    );
  }

  // 3. Anti-Pattern: SPECULATIVE_OVER_ENGINEERING
  if (
    input.communityPhilosophy === 'minimal_core' &&
    /\b(?:abstract factory|extensible provider framework|generic abstraction layer|new configuration flag|redesign architecture)\b/i.test(
      fullText,
    )
  ) {
    detectedAntiPatterns.push('SPECULATIVE_OVER_ENGINEERING');
    rejectionReasons.push(
      'Rejected: Speculative over-engineering directly violates the Minimal Core philosophy of the repository.',
    );
  }

  // 4. Anti-Pattern: STYLE_LINTER_CHURN
  if (
    /\b(?:linter fix|clean up whitespace|organize imports|reformat|rename parameters?)\b/i.test(
      input.title,
    )
  ) {
    detectedAntiPatterns.push('STYLE_LINTER_CHURN');
    rejectionReasons.push(
      'Rejected: Unrelated style/linter churn creates git blame pollution and is unwelcome in upstream projects.',
    );
  }

  // 5. Anti-Pattern: NO_REPRODUCER_THEORETICAL
  if (
    input.hasExecutableRepro === false &&
    /\b(?:theoretically possible|hypothetically could fail|in theory this might)\b/i.test(
      fullText,
    )
  ) {
    detectedAntiPatterns.push('NO_REPRODUCER_THEORETICAL');
    rejectionReasons.push(
      'Rejected: Theoretical defect with no reproducible test case (RED PoC).',
    );
  }

  // 6. Anti-Pattern: AI_BOILERPLATE_FLUFF
  if (
    /\b(?:as an ai language model|i have carefully analyzed|i have crafted a solution|hope this helps|in this pull request i have)\b/i.test(
      fullText,
    )
  ) {
    detectedAntiPatterns.push('AI_BOILERPLATE_FLUFF');
    rejectionReasons.push(
      'Rejected: Contains robotic AI boilerplate/fluff that signals automated spam to maintainers.',
    );
  }

  // 2. Classify Defect Tier
  let tier: DefectTier = 'tier5_internal_hygiene';
  let baseScore = 20;

  if (TIER1_KEYWORDS.some((kw) => kw.test(fullText))) {
    tier = 'tier1_critical';
    baseScore = 95;
  } else if (TIER2_KEYWORDS.some((kw) => kw.test(fullText))) {
    tier = 'tier2_concurrency';
    baseScore = 85;
  } else if (TIER3_KEYWORDS.some((kw) => kw.test(fullText))) {
    tier = 'tier3_contract_drift';
    baseScore = 75;
  } else if (TIER4_KEYWORDS.some((kw) => kw.test(fullText))) {
    tier = 'tier4_environment';
    baseScore = 60;
  } else if (TIER5_KEYWORDS.some((kw) => kw.test(fullText))) {
    tier = 'tier5_internal_hygiene';
    baseScore = 15;
  }

  // Tier 5 rejection
  if (tier === 'tier5_internal_hygiene') {
    rejectionReasons.push(
      'Rejected: Tier 5 internal hygiene/style issues are not worth opening PRs for.',
    );
  }

  // Minimal core penalty for Tier 4 without strong repro
  if (
    input.communityPhilosophy === 'minimal_core' &&
    tier === 'tier4_environment' &&
    !input.hasExecutableRepro
  ) {
    rejectionReasons.push(
      'Rejected: Minimal-core community requires verified executable reproduction for environment-level adjustments.',
    );
  }

  // Required evidence list
  const requiredEvidence: string[] = [];
  if (!input.hasExecutableRepro) {
    requiredEvidence.push('Executable failing test (RED PoC)');
  }
  if (!input.isPublicApiOrCli && input.isInternalPrivateScope) {
    requiredEvidence.push('Reachability trace from public API/CLI to internal site');
  }

  const isAccepted = detectedAntiPatterns.length === 0 && rejectionReasons.length === 0;
  const significanceScore = isAccepted
    ? baseScore + (input.hasExecutableRepro ? 5 : 0)
    : 0;

  return {
    isAccepted,
    tier,
    detectedAntiPatterns,
    rejectionReasons,
    significanceScore,
    requiredEvidence,
  };
}
