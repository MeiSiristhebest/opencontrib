/**
 * Contribution risk assessment — pure, dependency-free domain logic.
 *
 * Relocated into the `domain/` layer (Task 8). Pure decision-making over its
 * inputs; no I/O, no process-environment access.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export type ValidationStatus =
  | 'VALIDATED'
  | 'NO_TEST_AVAILABLE'
  | 'VALIDATION_FAILED'
  | 'VALIDATION_UNAVAILABLE';

export interface ContributionRiskInput {
  repoFullName: string;
  issueAgeDays?: number;
  diffLines: number;
  filesCount: number;
  validationStatus: ValidationStatus;
  subagentQualityScore: number;
  hasBlockingLabels?: boolean;
}

export interface RiskAssessment {
  riskLevel: RiskLevel;
  riskScore: number; // 0 (safest) to 100 (highest risk)
  recommendedPolicy: 'autonomous_headless' | 'interactive' | 'blocked';
  reasons: string[];
}

/**
 * Evaluates holistic multidimensional contribution risk
 * Unifies discovery, validation, diff size, and governance into an actionable policy decision.
 */
export function assessContributionRisk(input: ContributionRiskInput): RiskAssessment {
  const {
    repoFullName,
    issueAgeDays = 10,
    diffLines,
    filesCount,
    validationStatus,
    subagentQualityScore,
    hasBlockingLabels = false,
  } = input;

  const reasons: string[] = [];
  let riskScore = 15; // Base minimal risk

  // 1. Critical Hard Blockers
  if (hasBlockingLabels) {
    return {
      riskLevel: 'CRITICAL',
      riskScore: 100,
      recommendedPolicy: 'blocked',
      reasons: ['Issue contains blocking labels (wontfix/duplicate/invalid).'],
    };
  }

  if (validationStatus === 'VALIDATION_FAILED') {
    return {
      riskLevel: 'CRITICAL',
      riskScore: 95,
      recommendedPolicy: 'blocked',
      reasons: ['Sandbox test validation failed. Code patch did not pass regression checks.'],
    };
  }

  // 2. Validation Status Risk Factor
  if (validationStatus === 'NO_TEST_AVAILABLE') {
    riskScore += 30;
    reasons.push('No automated test suite detected in repository. Physical changes cannot be empirically verified.');
  } else if (validationStatus === 'VALIDATION_UNAVAILABLE') {
    riskScore += 40;
    reasons.push('Validation runner encountered runtime errors or missing toolchains.');
  }

  // 3. Diff Size & Complexity Risk Factor
  if (diffLines > 100) {
    const penalty = Math.min(30, Math.round((diffLines - 100) * 0.3));
    riskScore += penalty;
    reasons.push(`Diff size (${diffLines} lines) exceeds 100-line surgical threshold.`);
  }

  if (filesCount > 3) {
    riskScore += 15;
    reasons.push(`Patch touches ${filesCount} files across repository.`);
  }

  // 4. Subagent Quality Score Factor
  if (subagentQualityScore < 90) {
    riskScore += 25;
    reasons.push(`Subagent quality score (${subagentQualityScore}%) is below 90% target threshold.`);
  }

  // 5. Issue Stale Risk Factor
  if (issueAgeDays > 180) {
    riskScore += 10;
    reasons.push(`Issue has been inactive for >180 days (${issueAgeDays} days old).`);
  }

  // Determine Risk Level & Policy
  riskScore = Math.max(0, Math.min(100, riskScore));

  let riskLevel: RiskLevel = 'LOW';
  let recommendedPolicy: 'autonomous_headless' | 'interactive' | 'blocked' = 'autonomous_headless';

  if (riskScore >= 75) {
    riskLevel = 'HIGH';
    recommendedPolicy = 'interactive';
  } else if (riskScore >= 45) {
    riskLevel = 'MEDIUM';
    recommendedPolicy = 'interactive';
  } else {
    riskLevel = 'LOW';
    recommendedPolicy = 'autonomous_headless';
  }

  return {
    riskLevel,
    riskScore,
    recommendedPolicy,
    reasons,
  };
}
