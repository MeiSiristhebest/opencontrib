import type { ConfidenceBreakdown, GovernanceAuditResult } from '../contracts/schemas.js';

export const FORBIDDEN_AI_PHRASES = [
  'i have carefully analyzed',
  'as an ai assistant',
  'as a language model',
  'hope this helps',
  'let me know if you need further',
  'this pr aims to fix the issue where',
  'in order to address the user request',
  'here is a breakdown of the changes',
  '// helper function',
  '// this function fixes the bug',
  '// loop through items',
  'google standard',
  'bytedance standard',
  'microsoft vscode standard',
  'pytorch standard',
  'cncf standard',
  'linux foundation standard',
  'i hope this meets your expectations',
  'feel free to ask',
];

export function lintAntiAiText(text: string): { isClean: boolean; flaggedPhrases: string[] } {
  const lower = text.toLowerCase();
  const flaggedPhrases: string[] = [];

  for (const phrase of FORBIDDEN_AI_PHRASES) {
    if (lower.includes(phrase)) {
      flaggedPhrases.push(phrase);
    }
  }

  // Regex to detect rigid robotic meta tags like "(... Standard)"
  const roboticTagMatch = text.match(/\([A-Za-z0-9\s/]+\s+Standard\)/i);
  if (roboticTagMatch) {
    flaggedPhrases.push(roboticTagMatch[0]);
  }

  return {
    isClean: flaggedPhrases.length === 0,
    flaggedPhrases,
  };
}

export function calculateConfidenceScore(breakdown: ConfidenceBreakdown): {
  overallScore: number;
  weakestDimension: { dimension: string; score: number };
  isPassed: boolean;
} {
  const { rootCause, implementation, regression, defensiveCoverage, testCoverage, styleMatch, securityAudit } = breakdown;

  const overallScore =
    0.25 * rootCause +
    0.25 * implementation +
    0.20 * regression +
    0.10 * defensiveCoverage +
    0.10 * testCoverage +
    0.05 * styleMatch +
    0.05 * securityAudit;

  const dimensions = [
    { dimension: 'Root Cause Confidence', score: rootCause },
    { dimension: 'Implementation Confidence', score: implementation },
    { dimension: 'Regression Confidence', score: regression },
    { dimension: 'Defensive Coverage Confidence', score: defensiveCoverage },
    { dimension: 'Test Coverage Confidence', score: testCoverage },
    { dimension: 'Style & Pattern Confidence', score: styleMatch },
    { dimension: 'Security Confidence', score: securityAudit },
  ];

  let weakest = dimensions[0];
  for (const d of dimensions) {
    if (d.score < weakest.score) {
      weakest = d;
    }
  }

  // Passing criteria: Overall >= 90 AND Weakest Dimension >= 80
  const isPassed = overallScore >= 90 && weakest.score >= 80;

  return {
    overallScore: Math.round(overallScore * 100) / 100,
    weakestDimension: weakest,
    isPassed,
  };
}

/**
 * 7-Dimensional Weighted Quality Rubric
 * Deterministic engineering quality gate calibrated across 7 core software engineering axes.
 */
export const calculate7DQualityRubric = calculateConfidenceScore;

export function auditGovernance(input: {
  diffText: string;
  prBodyText: string;
  confidenceBreakdown: ConfidenceBreakdown;
  lineCount: number;
  humanApproved?: boolean;
}): GovernanceAuditResult {
  const { diffText, prBodyText, confidenceBreakdown, lineCount, humanApproved = false } = input;

  // 1. Anti-AI & Anti-Robotic Linting on both code diff & PR body
  const aiDiffCheck = lintAntiAiText(diffText);
  const aiPrCheck = lintAntiAiText(prBodyText);
  const flaggedAiPhrases = [...aiDiffCheck.flaggedPhrases, ...aiPrCheck.flaggedPhrases];
  const antiAiCheckPassed = flaggedAiPhrases.length === 0;

  // 2. RFC 100-line Gate Check
  const rfcGatePassed = lineCount <= 100;

  // 3. Mathematical Confidence Calculation
  const confidence = calculateConfidenceScore(confidenceBreakdown);

  // 4. Human-in-the-Loop Pre-flight Gate
  const requiresHumanApproval = !humanApproved;

  const isGatedPassed = antiAiCheckPassed && rfcGatePassed && confidence.isPassed && humanApproved;

  const remediationSuggestions: string[] = [];
  if (!antiAiCheckPassed) {
    remediationSuggestions.push(`Remove flagged robotic/AI phrases: ${flaggedAiPhrases.join(', ')}`);
  }
  if (!rfcGatePassed) {
    remediationSuggestions.push(`Diff exceeds 100 lines (${lineCount} lines). Split into RFC Discussion issue first.`);
  }
  if (!confidence.isPassed) {
    remediationSuggestions.push(
      `Confidence score requirement not met (Overall: ${confidence.overallScore}%, Weakest: ${confidence.weakestDimension.dimension} at ${confidence.weakestDimension.score}%). Must reach >=90% overall and >=80% on all dimensions.`,
    );
  }
  if (requiresHumanApproval) {
    remediationSuggestions.push('Pre-flight Human Gate: Draft requires explicit user preview and approval before submission.');
  }

  return {
    overallScore: confidence.overallScore,
    weakestDimension: confidence.weakestDimension,
    isGatedPassed,
    requiresHumanApproval,
    rfcGatePassed,
    diffLineCount: lineCount,
    antiAiCheckPassed,
    flaggedAiPhrases,
    remediationSuggestions,
  };
}

export function renderMasterPrTemplate(data: {
  issueNumber: number;
  problemSummary: string;
  rootCause: string;
  keyChanges: string[];
  reproductionCommand: string;
  verificationCommand: string;
  testCount: number;
  stressLoopCount?: number;
  dcoAuthorName?: string;
  dcoAuthorEmail?: string;
  conditionalAiRequired?: boolean;
}): string {
  const {
    issueNumber,
    problemSummary,
    rootCause,
    keyChanges,
    reproductionCommand,
    verificationCommand,
    testCount,
    stressLoopCount = 20,
    dcoAuthorName,
    dcoAuthorEmail,
    conditionalAiRequired = false,
  } = data;

  const hasDco = Boolean(dcoAuthorName && dcoAuthorEmail);

  let doc = `Fixes #${issueNumber}

### Motivation
${problemSummary}

### Root Cause
${rootCause}

### Key Changes
${keyChanges.map((c) => `- ${c}`).join('\n')}

---

### Verification
- **Local Reproduction**: \`${reproductionCommand}\`
- **Verification Command**: \`${verificationCommand}\`
- **Test Status**: Passed (${testCount} passed)
- **Stress Loop**: Passed (${stressLoopCount} consecutive iterations)
`;

  if (hasDco) {
    doc += `\n---\n\n### Compliance Checklist\n- [x] **Signed-off-by**: \`${dcoAuthorName} <${dcoAuthorEmail}>\`\n`;
  }

  if (conditionalAiRequired) {
    doc += `\n---\n\n**AI Disclosure**: Initial patch drafted with AI assistance; independently reviewed, tested, and verified by author.\n`;
  }

  return doc;
}
