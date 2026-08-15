import { describe, expect, it } from 'bun:test';
import { assessContributionRisk } from '../src/risk/risk-engine.js';
import { deriveEvidenceBackedQualityRubric } from '../src/governance/governance-auditor.js';

describe('Contribution Risk Engine & Evidence-Backed Quality Rubric', () => {
  it('classifies low-risk, verified small PRs as LOW risk with autonomous execution', () => {
    const assessment = assessContributionRisk({
      repoFullName: 'bytedance/flowgram.ai',
      diffLines: 25,
      filesCount: 1,
      validationStatus: 'VALIDATED',
      subagentQualityScore: 94,
    });

    expect(assessment.riskLevel).toBe('LOW');
    expect(assessment.recommendedPolicy).toBe('autonomous_headless');
    expect(assessment.riskScore).toBeLessThan(45);
  });

  it('elevates risk to MEDIUM when tests are missing or diff is moderately large', () => {
    const assessment = assessContributionRisk({
      repoFullName: 'bytedance/flowgram.ai',
      diffLines: 120,
      filesCount: 2,
      validationStatus: 'NO_TEST_AVAILABLE',
      subagentQualityScore: 92,
    });

    expect(assessment.riskLevel).toBe('MEDIUM');
    expect(assessment.recommendedPolicy).toBe('interactive');
    expect(assessment.reasons.some((r) => r.includes('No automated test suite'))).toBe(true);
  });

  it('blocks PR with CRITICAL risk when validation fails or blocking labels present', () => {
    const assessment = assessContributionRisk({
      repoFullName: 'bytedance/flowgram.ai',
      diffLines: 30,
      filesCount: 1,
      validationStatus: 'VALIDATION_FAILED',
      subagentQualityScore: 85,
    });

    expect(assessment.riskLevel).toBe('CRITICAL');
    expect(assessment.recommendedPolicy).toBe('blocked');
  });

  it('derives empirical evidence-backed quality rubric scores mathematically', () => {
    const result = deriveEvidenceBackedQualityRubric({
      hasReproductionAssertion: true,
      testsPassed: true,
      passedTestsCount: 5,
      diffLines: 18,
      styleScore: 95,
      securityScore: 94,
    });

    expect(result.breakdown.rootCause).toBe(95);
    expect(result.breakdown.regression).toBe(93);
    expect(result.breakdown.implementation).toBe(94);
    expect(result.rubricResult.isPassed).toBe(true);
    expect(result.rubricResult.overallScore).toBeGreaterThanOrEqual(90);
  });
});
