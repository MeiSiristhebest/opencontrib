/**
 * Governance audit, quality rubric, anti-AI linting, and PR-template rendering —
 * pure, dependency-free domain logic.
 *
 * Relocated into the `domain/` layer (Task 8). The only external dependency is
 * `validateMarkdownIntegrity` from the (also pure) markdown-validator, which is
 * imported via a relative path. Neither the filesystem nor the subprocess or
 * process-environment modules are permitted here — the architecture guard enforces this.
 */

import {
  EvidenceReportSchema,
  type ConfidenceBreakdown,
  type GovernanceAuditResult,
  type EvidenceReport,
  type GreenEvidence,
  type RedEvidence,
} from "../contracts/schemas.js";
import { validateMarkdownIntegrity } from "../governance/markdown-validator.js";

/**
 * Advanced Semantic & Behavioral Anti-AI Patterns
 * Targets robotic tropes, AI disclaimers, boilerplate fluff, and mechanical comments.
 */
export const ANTI_AI_PHRASE_PATTERNS = [
  "as an ai language model",
  "as an ai assistant",
  "i do not have access to",
  "i apologize for the confusion",
  "i have carefully analyzed",
  "i have crafted a solution",
  "here is a breakdown of the changes",
  "in this pull request, i have",
  "in this pull request i have",
  "this pr aims to fix",
  "hope this helps!",
  "let me know if you need anything else",
  "feel free to ask if you have any questions",
  "ai-generated",
  "generated with claude",
  "generated with chatgpt",
  "generated with cursor",
  "generated with copilot",
  "// helper function",
  "// auto-generated function",
  "google / bytedance standard",
  "microsoft vscode standard",
];

export const FORBIDDEN_AI_PHRASES = [...ANTI_AI_PHRASE_PATTERNS];

export function lintAntiAiText(text: string): {
  isClean: boolean;
  isAiFlagged: boolean;
  flaggedPhrases: string[];
  cleanText: string;
} {
  const lower = text.toLowerCase();
  const flaggedPhrases: string[] = [];

  for (const phrase of ANTI_AI_PHRASE_PATTERNS) {
    if (lower.includes(phrase)) {
      flaggedPhrases.push(phrase);
    }
  }

  // Regex checks for generic patterns
  const genericPatterns = [
    /\b(?:as an ai(?:\s+language)?\s+model|as an ai assistant)\b/i,
    /\b(?:generated with (?:claude|chatgpt|copilot|cursor|deepseek))\b/i,
    /[🚀🔥✨🎉💯]{3,}/u,
  ];

  for (const pat of genericPatterns) {
    const m = text.match(pat);
    if (m && !flaggedPhrases.includes(m[0].toLowerCase())) {
      flaggedPhrases.push(m[0].toLowerCase());
    }
  }

  // Remove robotic header prefixes
  const cleanText = text
    .replace(/^#\s*\(Google\s+Standard\)\s*/i, "")
    .replace(/^#\s*\(Microsoft\s+VSCode\s+Standard\)\s*/i, "")
    .replace(/^#\s*\(PyTorch\s+Standard\)\s*/i, "")
    .replace(/^#\s*\(CloudWeGo\s+Standard\)\s*/i, "")
    .replace(/^#\s*\(CNCF\s+Standard\)\s*/i, "")
    .replace(/^#\s*\(Linux\s+Kernel\s+Standard\)\s*/i, "");

  const isAiFlagged = flaggedPhrases.length > 0;
  return {
    isClean: !isAiFlagged,
    isAiFlagged,
    flaggedPhrases,
    cleanText: cleanText.trim(),
  };
}

export function calculateConfidenceScore(breakdown: ConfidenceBreakdown): {
  overallScore: number;
  weakestDimension: { dimension: string; score: number };
  isPassed: boolean;
} {
  const {
    rootCause,
    implementation,
    regression,
    defensiveCoverage,
    testCoverage,
    styleMatch,
    securityAudit,
  } = breakdown;

  const overallScore =
    0.25 * rootCause +
    0.25 * implementation +
    0.2 * regression +
    0.1 * defensiveCoverage +
    0.1 * testCoverage +
    0.05 * styleMatch +
    0.05 * securityAudit;

  const dimensions = [
    { dimension: "Root Cause Confidence", score: rootCause },
    { dimension: "Implementation Confidence", score: implementation },
    { dimension: "Regression Confidence", score: regression },
    { dimension: "Defensive Coverage Confidence", score: defensiveCoverage },
    { dimension: "Test Coverage Confidence", score: testCoverage },
    { dimension: "Style & Pattern Confidence", score: styleMatch },
    { dimension: "Security Confidence", score: securityAudit },
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

/**
 * Evidence-Backed Quality Rubric Derivation
 * Grounded in empirical reproduction, sandbox stress loops, and surgical diff size.
 * If subagent review is unavailable or empirical evidence is absent, scores strictly reflect the gap.
 */
export function deriveEvidenceBackedQualityRubric(input: {
  hasReproductionAssertion?: boolean;
  testsPassed?: boolean;
  passedUnitTestsCount?: number;
  /** @deprecated Use passedUnitTestsCount */
  passedTestsCount?: number;
  testCoveragePercent?: number;
  diffLines?: number;
  styleScore?: number;
  securityScore?: number;
  subagentReviewAvailable?: boolean;
  coverageMinimumPercent?: number;
}): {
  breakdown: ConfidenceBreakdown;
  rubricResult: ReturnType<typeof calculate7DQualityRubric>;
} {
  const passedUnitTests =
    input.passedUnitTestsCount ?? input.passedTestsCount ?? 0;
  const {
    hasReproductionAssertion = false,
    testsPassed = false,
    testCoveragePercent,
    diffLines = 15,
    styleScore,
    securityScore,
    subagentReviewAvailable = true,
  } = input;

  const coverageThreshold = input.coverageMinimumPercent ?? 85;

  // Root cause confidence: 95 only if empirical failure reproduction was confirmed, 90 if standard tests passed, 65 if untested
  const rootCause = hasReproductionAssertion ? 95 : testsPassed ? 90 : 65;
  // Implementation confidence: based on surgical diff size
  const implementation =
    diffLines <= 100
      ? 94
      : Math.max(60, 94 - Math.round((diffLines - 100) * 0.25));
  // Regression confidence: based on actual test passes
  const regression = testsPassed ? 93 : 50;
  // Defensive and test coverage: based on real passed unit tests count and test coverage percentage (>=85% required)
  const defensiveCoverage =
    passedUnitTests > 0 ? 91 : subagentReviewAvailable ? 86 : 75;
  let testCoverage =
    passedUnitTests > 0 ? 92 : subagentReviewAvailable ? 85 : 70;
  if (typeof testCoveragePercent === "number") {
    if (testCoveragePercent >= coverageThreshold) {
      testCoverage = Math.min(
        100,
        Math.round(
          coverageThreshold + (testCoveragePercent - coverageThreshold) * 1.0,
        ),
      );
    } else {
      // Coverage below the repository threshold strictly caps the score below 80.
      testCoverage = Math.max(50, Math.round(testCoveragePercent * 0.85));
    }
  }

  // Style and Security scores: grounded in Subagent Review if available, or calibrated conservative defaults if not
  const styleMatch =
    typeof styleScore === "number"
      ? styleScore
      : subagentReviewAvailable
        ? 90
        : 80;
  const securityAudit =
    typeof securityScore === "number"
      ? securityScore
      : subagentReviewAvailable
        ? 90
        : 80;

  const breakdown: ConfidenceBreakdown = {
    rootCause,
    implementation,
    regression,
    defensiveCoverage,
    testCoverage,
    styleMatch,
    securityAudit,
  };

  const rubricResult = calculate7DQualityRubric(breakdown);
  return { breakdown, rubricResult };
}

export function lintMarkdownIntegrity(text: string): {
  isClean: boolean;
  corruptedIssues: string[];
} {
  const report = validateMarkdownIntegrity(text);
  return {
    isClean: report.isValid,
    corruptedIssues: report.errors.map(
      (e) =>
        `[${e.ruleId}${e.line ? ` Line ${e.line}` : ""}] ${e.message} (Fix: ${e.suggestedFix})`,
    ),
  };
}

export interface GovernanceDecisionOutput {
  overallScore: number;
  weakestDimension: { dimension: string; score: number };
  technicalGate: {
    status: "PASS" | "FAIL";
    passed: boolean;
  };
  approvalGate: {
    status: "PENDING" | "APPROVED" | "WAIVED";
    approved: boolean;
  };
  submissionDecision: {
    allowed: boolean;
    status: "ALLOWED" | "BLOCKED" | "WAIVED";
    reason?: string;
  };
  rfcGatePassed: boolean;
  diffLineCount: number;
  antiAiCheckPassed: boolean;
  flaggedAiPhrases: string[];
  markdownIntegrityPassed?: boolean;
  corruptedMarkdownIssues?: string[];
  remediationSuggestions: string[];
  guidance: {
    isPassed: boolean;
    forbiddenActions: string[];
    invariants: string[];
    nextCommand: string;
  };
}

export interface CoveragePolicy {
  required?: boolean;
  minimumChangedLineCoverage?: number;
}

export interface ResourceLeakPolicy {
  required?: boolean;
}

export interface AuditGovernanceInput {
  diffText?: string;
  patchContent?: string;
  prBodyText?: string;
  prTitle?: string;
  prBody?: string;
  confidenceBreakdown?: ConfidenceBreakdown;
  lineCount?: number;
  maxDiffLines?: number;
  evidence?: Partial<EvidenceReport>;
  coveragePolicy?: CoveragePolicy;
  resourceLeakPolicy?: ResourceLeakPolicy;
  subagentQualityScore?: number;
  isAutonomousPrSubmission?: boolean;
  variantHuntConducted?: boolean;
  impactAnalysisConducted?: boolean;
}

export function auditGovernance(
  input: AuditGovernanceInput,
): GovernanceAuditResult & {
  overallConfidence: { isPassed: boolean; overallScore: number };
} {
  const patch = input.diffText || input.patchContent || "";
  const prBody = input.prBodyText || input.prBody || "";
  let lines = typeof input.lineCount === "number" ? input.lineCount : 0;
  if (typeof input.lineCount !== "number") {
    if (patch) {
      // Calculate true added/removed line changes from unified diff hunks
      const diffHunkLines = patch
        .split("\n")
        .filter(
          (l) =>
            (l.startsWith("+") || l.startsWith("-")) &&
            !l.startsWith("+++") &&
            !l.startsWith("---"),
        );
      lines =
        diffHunkLines.length > 0
          ? diffHunkLines.length
          : patch.split("\n").length;
    }
  }
  const maxDiffAllowed = input.maxDiffLines ?? 100;

  const configuredCoverageMinimum =
    input.coveragePolicy?.minimumChangedLineCoverage;
  const coverageMinimumIsValid =
    configuredCoverageMinimum === undefined ||
    (typeof configuredCoverageMinimum === "number" &&
      Number.isFinite(configuredCoverageMinimum) &&
      configuredCoverageMinimum >= 0 &&
      configuredCoverageMinimum <= 100);
  const minimumChangedLineCoverage = coverageMinimumIsValid
    ? (configuredCoverageMinimum ?? 85)
    : 101;

  let breakdown = input.confidenceBreakdown;
  if (!breakdown) {
    const passedUnitTestsCount =
      input.evidence?.passedUnitTestsCount ??
      (input.evidence?.allTestsPassing ? 1 : 0);

    const calibrated = deriveEvidenceBackedQualityRubric({
      hasReproductionAssertion: Boolean(input.evidence?.reproductionVerified),
      testsPassed: Boolean(
        input.evidence?.allTestsPassing ?? passedUnitTestsCount > 0,
      ),
      passedUnitTestsCount,
      testCoveragePercent: input.evidence?.testCoveragePercent,
      coverageMinimumPercent:
        input.coveragePolicy?.required === true
          ? minimumChangedLineCoverage
          : 85,
      diffLines: lines,
      styleScore: input.subagentQualityScore,
      securityScore: input.subagentQualityScore,
      subagentReviewAvailable: typeof input.subagentQualityScore === "number",
    });
    breakdown = calibrated.breakdown;
    // Reward in-domain deep defense if variant hunt was conducted
    if (input.variantHuntConducted) {
      breakdown.defensiveCoverage = Math.max(breakdown.defensiveCoverage, 96);
    }
  }

  // 1. Anti-AI & Anti-Robotic Linting
  const aiDiffCheck = lintAntiAiText(patch);
  const aiPrCheck = lintAntiAiText(prBody);
  const flaggedAiPhrases = [
    ...aiDiffCheck.flaggedPhrases,
    ...aiPrCheck.flaggedPhrases,
  ];
  const antiAiCheckPassed = flaggedAiPhrases.length === 0;

  // 2. Markdown Integrity & Encoding Check
  const integrityCheck = lintMarkdownIntegrity(prBody);
  const markdownIntegrityPassed = integrityCheck.isClean;
  const corruptedMarkdownIssues = integrityCheck.corruptedIssues;

  // 3. RFC 100-line (or configured maxDiffLines) Gate Check
  const rfcGatePassed = lines <= maxDiffAllowed;

  // 4. Mathematical Quality Rubric Calculation
  const confidence = calculateConfidenceScore(breakdown!);

  // 5. Human approval is a separate trusted-host capability. This technical
  // audit never accepts a caller-supplied approval boolean.
  const requiresHumanApproval = true;

  const coverageGatePassed =
    coverageMinimumIsValid &&
    (input.coveragePolicy?.required !== true ||
      (input.evidence?.changedCodeCoverageStatus === "PASS" &&
        typeof input.evidence.changedCodeCoveragePercent === "number" &&
        input.evidence.changedCodeCoveragePercent >=
          minimumChangedLineCoverage));
  const resourceLeakGatePassed =
    input.resourceLeakPolicy?.required !== true ||
    input.evidence?.handleLeakCheckPassed === "PASS";

  const isTechnicalGatePassed =
    antiAiCheckPassed &&
    markdownIntegrityPassed &&
    rfcGatePassed &&
    confidence.isPassed &&
    coverageGatePassed &&
    resourceLeakGatePassed;

  const isGatedPassed = isTechnicalGatePassed;

  const technicalGate = {
    status: isTechnicalGatePassed ? ("PASS" as const) : ("FAIL" as const),
    passed: isTechnicalGatePassed,
  };

  const approvalGate = {
    status: "PENDING" as const,
    approved: false,
  };

  let submissionStatus: "ALLOWED" | "BLOCKED" | "WAIVED";
  let submissionReason: string | undefined;
  if (isGatedPassed) {
    submissionStatus = "BLOCKED";
    submissionReason =
      "Pending external approval from a trusted human/policy authority";
  } else {
    submissionStatus = "BLOCKED";
    submissionReason = "Technical quality gate criteria not met";
  }

  const submissionDecision = {
    allowed: false,
    status: submissionStatus,
    reason: submissionReason,
  };

  const remediationSuggestions: string[] = [];
  if (!markdownIntegrityPassed) {
    remediationSuggestions.push(
      `Fix Markdown encoding/corruption issues: ${corruptedMarkdownIssues.join("; ")}`,
    );
  }
  if (!antiAiCheckPassed) {
    remediationSuggestions.push(
      `Remove flagged robotic/AI phrases: ${flaggedAiPhrases.join(", ")}`,
    );
  }
  if (!rfcGatePassed) {
    remediationSuggestions.push(
      `Diff exceeds 100 lines (${lines} lines). Split into RFC Discussion issue first.`,
    );
  }
  if (!coverageMinimumIsValid) {
    remediationSuggestions.push(
      "Coverage policy minimum must be a finite number between 0 and 100; invalid thresholds fail closed.",
    );
  } else if (input.coveragePolicy?.required === true && !coverageGatePassed) {
    const measured = input.evidence?.changedCodeCoveragePercent;
    remediationSuggestions.push(
      typeof measured === "number"
        ? `Changed-code coverage is below the required ${minimumChangedLineCoverage}% threshold (Current: ${measured}%). Run GREEN with the repository coverage adapter and cover all modified branches.`
        : `Changed-code coverage is unavailable. Run GREEN with the repository coverage adapter before governance audit; UNAVAILABLE cannot satisfy a required coverage policy.`,
    );
  } else if (
    typeof input.evidence?.testCoveragePercent === "number" &&
    input.evidence.testCoveragePercent < 85
  ) {
    remediationSuggestions.push(
      `PR accompanying test coverage is below the 85% advisory threshold (Current: ${input.evidence.testCoveragePercent}%). Add tests to cover modified branches or enable the repository coverage policy.`,
    );
  }
  if (input.resourceLeakPolicy?.required === true && !resourceLeakGatePassed) {
    remediationSuggestions.push(
      "Resource-leak evidence is unavailable or failed. Run the trusted handle/process leak check before governance audit.",
    );
  }
  if (!confidence.isPassed) {
    remediationSuggestions.push(
      `Confidence score requirement not met (Overall: ${confidence.overallScore}%, Weakest: ${confidence.weakestDimension.dimension} at ${confidence.weakestDimension.score}%). Must reach >=90% overall and >=80% on all dimensions.`,
    );
    if (!input.evidence) {
      remediationSuggestions.push(
        "Missing empirical evidence artifact: Run 'opencontrib evidence --test-cmd <cmd>' before governance audit to record fail-first and post-fix assertions.",
      );
    }
  }

  if (!input.variantHuntConducted) {
    remediationSuggestions.push(
      "In-Domain Defense Recommendation: Run Variant Hunting sweep across sister modules to ensure zero parallel structural defects.",
    );
  }
  if (requiresHumanApproval) {
    remediationSuggestions.push(
      "Pre-flight Human Gate: Draft requires explicit user preview and approval before submission.",
    );
  }

  return {
    overallScore: confidence.overallScore,
    weakestDimension: confidence.weakestDimension,
    technicalGate,
    approvalGate,
    submissionDecision,
    isGatedPassed,
    requiresHumanApproval,
    rfcGatePassed,
    diffLineCount: lines,
    antiAiCheckPassed,
    flaggedAiPhrases,
    markdownIntegrityPassed,
    corruptedMarkdownIssues,
    remediationSuggestions,
    overallConfidence: {
      isPassed: isTechnicalGatePassed,
      overallScore: confidence.overallScore,
    },
    guidance: {
      isPassed: isGatedPassed,
      forbiddenActions: isGatedPassed
        ? []
        : [
            `Overall Quality Score (${confidence.overallScore.toFixed(1)}/100) is below required 90.0% threshold.`,
            `Weakest dimension: ${confidence.weakestDimension.dimension} (${confidence.weakestDimension.score}/100).`,
            "STRICTLY FORBIDDEN: Do NOT commit or create a PR with failing governance audit score.",
          ],
      invariants: isGatedPassed
        ? [
            "Present the patch diff and audit report to the user at Checkpoint 3 before pushing.",
          ]
        : [
            "Improve test coverage or add negative assertion cases to increase confidence.",
            "Run variant hunting across sister modules to verify no parallel defects.",
            "Do not bypass a failed technical gate; request any exception through a trusted host authority.",
          ],
      nextCommand: isGatedPassed
        ? 'opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>"'
        : 'opencontrib governance audit --run-id <run_id> --pr-title "<title>"',
    },
  };
}

export type PrTemplateEvidence = Omit<
  Partial<EvidenceReport>,
  "redEvidence" | "greenEvidence"
> & {
  redEvidence?: Partial<RedEvidence>;
  greenEvidence?: Partial<GreenEvidence>;
};

export interface MasterPrTemplateInput {
  issueNumber: number;
  issueTitle?: string;
  summary?: string;
  problemSummary?: string;
  rootCause?: string;
  keyChanges?: string[];
  reproductionCommand?: string;
  verificationCommand?: string;
  validationCommand?: string;
  validationOutputSnippet?: string;
  testCount?: number;
  stressLoopCount?: number;
  dcoAuthorName?: string;
  dcoAuthorEmail?: string;
  confidenceScore?: number;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  isDocumentationOnly?: boolean;
  aiDisclosureRequired?: boolean;
  conditionalAiRequired?: boolean;
  nativeTemplateContent?: string;
  evidence?: PrTemplateEvidence;
}

export function renderMasterPrTemplate(data: MasterPrTemplateInput): string {
  const issueNumber = data.issueNumber;
  const problemSummary =
    data.problemSummary ||
    data.summary ||
    data.issueTitle ||
    "Unavailable (issue description not recorded)";
  const rootCause =
    data.rootCause || "Unavailable (root cause rationale not recorded)";
  const keyChanges =
    data.keyChanges && data.keyChanges.length > 0
      ? data.keyChanges
      : ["Unavailable (key implementation steps not recorded)"];
  const evidence = data.evidence;
  const canonicalEvidence = EvidenceReportSchema.safeParse(evidence);
  const validatedEvidence = canonicalEvidence.success
    ? canonicalEvidence.data
    : undefined;
  const reproductionVerified =
    validatedEvidence?.reproductionVerified === true &&
    validatedEvidence.redEvidence?.assertionMatched === true;
  const canonicalReproductionCommand = reproductionVerified
    ? validatedEvidence.redEvidence?.command
    : undefined;
  const explicitGreenResult = validatedEvidence?.greenEvidence?.passed;
  const verificationPassed =
    validatedEvidence !== undefined &&
    (explicitGreenResult !== undefined
      ? explicitGreenResult
      : validatedEvidence.allTestsPassing === true);
  const canonicalVerificationCommand = verificationPassed
    ? validatedEvidence?.greenEvidence?.command
    : undefined;
  const canonicalTestCount = verificationPassed
    ? validatedEvidence?.passedUnitTestsCount
    : undefined;
  const stressLoopCount = verificationPassed
    ? (validatedEvidence?.stressLoopRuns ?? 1)
    : 0;
  const dcoAuthorName = data.dcoAuthorName;
  const dcoAuthorEmail = data.dcoAuthorEmail;
  const userValidationNote =
    !validatedEvidence &&
    (data.verificationCommand ||
      data.validationCommand ||
      data.validationOutputSnippet)
      ? `\n- **User-provided validation note (not verified)**: ${[
          data.verificationCommand || data.validationCommand,
          data.validationOutputSnippet,
        ]
          .filter(Boolean)
          .join(" — ")}`
      : "";

  const reproductionDetail = canonicalReproductionCommand
    ? `- **Reproduction**: \`${canonicalReproductionCommand}\` confirmed failing assertion prior to fix.`
    : `- **Reproduction**: Not recorded.`;
  const verificationDetail = canonicalVerificationCommand
    ? stressLoopCount > 1
      ? `passed cleanly across ${stressLoopCount} consecutive stress loop runs (${canonicalTestCount ?? "all"} test assertions passed).`
      : `passed cleanly (${canonicalTestCount ?? "unit test suite"} test assertions passed, 0 regressions).`
    : "Not recorded.";
  const verificationLine = canonicalVerificationCommand
    ? `- **Verification**: \`${canonicalVerificationCommand}\` ${verificationDetail}`
    : `- **Verification**: ${verificationDetail}`;

  // If target repository provides a native template, merge into it. All
  // verification facts in this branch are still read from canonical evidence.
  if (
    data.nativeTemplateContent &&
    data.nativeTemplateContent.trim().length > 10
  ) {
    let result = data.nativeTemplateContent;
    result = result.replace(/<!--[\s\S]*?-->/g, ""); // strip comments
    if (/fixes #|closes #|resolves #/i.test(result)) {
      result = result.replace(
        /(fixes|closes|resolves)\s+#\d*/i,
        `$1 #${issueNumber}`,
      );
    } else {
      result = `Fixes #${issueNumber}\n\n` + result;
    }
    if (
      /## description|## summary|## motivation|### description/i.test(result)
    ) {
      result = result.replace(
        /(##\s*(?:description|summary|motivation)[\s\S]*?)(?=##|$)/i,
        (_match, section) =>
          `${section}\n${problemSummary}\n\n**Root Cause**: ${rootCause}\n\n**Key Changes**:\n${keyChanges.map((c) => `- ${c}`).join("\n")}\n\n`,
      );
    }
    if (
      /## test plan|## verification|## how has this been tested|### test plan/i.test(
        result,
      )
    ) {
      const testSuite =
        canonicalTestCount === undefined
          ? "Not recorded"
          : `${canonicalTestCount} tests passed`;
      result = result.replace(
        /(##\s*(?:test plan|verification|how has this been tested)[\s\S]*?)(?=##|$)/i,
        (_match, section) =>
          `${section}\n${reproductionDetail}\n${verificationLine}\n- Test Suite: ${testSuite}\n${userValidationNote}\n\n`,
      );
    }
    const nativeDcoTrailer =
      dcoAuthorName && dcoAuthorEmail
        ? `\n\nSigned-off-by: ${dcoAuthorName} <${dcoAuthorEmail}>`
        : "";
    return `${result.trim()}${nativeDcoTrailer}`;
  }

  const changeList = keyChanges.map((c) => `- ${c}`).join("\n");
  const dcoTrailer =
    dcoAuthorName && dcoAuthorEmail
      ? `\n\nSigned-off-by: ${dcoAuthorName} <${dcoAuthorEmail}>`
      : "";

  let regressionLine = "- **Regression Isolation**: Not recorded.";
  if (validatedEvidence?.baselineFlakyTests !== undefined) {
    if (validatedEvidence.baselineFlakyTests.length === 0) {
      regressionLine =
        "- **Regression Isolation**: Verified 0 flaky baseline regressions across sandbox runs.";
    } else {
      regressionLine = `- **Regression Isolation**: ${validatedEvidence.baselineFlakyTests.length} baseline flaky test(s) observed.`;
    }
  }

  const aiDisclosureSection = data.aiDisclosureRequired
    ? `\n\n### Automated Assistance Disclosure\nIn accordance with repository policies, this contribution was developed with AI-assisted tooling (OpenContrib autonomous engine) with deterministic local reproduction and human verification.`
    : "";

  return `### Problem Description
Fixes #${issueNumber}
${problemSummary}

### Motivation & Root Cause Analysis
${rootCause}

### Key Implementation Changes
${changeList}

### Verification & Empirical Evidence
${reproductionDetail}
${verificationLine}
${regressionLine}${userValidationNote}${dcoTrailer}${aiDisclosureSection}
`;
}
