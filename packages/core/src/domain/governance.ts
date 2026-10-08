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
} from "../contracts/schemas.js";
import { validateMarkdownIntegrity } from "../governance/markdown-validator.js";
import { analyzePatchImpactAndConsistency } from "../governance/impact-analyzer.js";
import { lintAntiHardcode } from "../governance/anti-hardcode.js";

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

export interface AssertionQualityResult {
  isClean: boolean;
  flaggedTautologicalAssertions: string[];
}

function isTestPath(
  normalizedPath: string,
  includeTestPrefixedBasename: boolean,
): boolean {
  const baseName = normalizedPath.slice(normalizedPath.lastIndexOf("/") + 1);
  return (
    /(^|\/)(?:tests?|__tests__)(?:\/|$)/.test(normalizedPath) ||
    /\.(?:test|spec)\.[^/]+$/.test(baseName) ||
    /tests?\.[^/]+$/.test(baseName) ||
    /_test\.[^/]+$/.test(baseName) ||
    /^test_[^/]+\.[^/]+$/.test(baseName) ||
    (includeTestPrefixedBasename && /^test[^/]*\.[^/]+$/.test(baseName))
  );
}

function isTestSourcePath(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  // Assertion analysis treats names such as testUtils.ts as test sources;
  // supporting-file classification intentionally requires clearer test markers.
  return isTestPath(normalized, true);
}

/**
 * Hard Assertion Quality Gate (Anti-Tautological Assertion Linter)
 *
 * Detects lazy/tautological assertions added to test sources (e.g. asserting purely
 * generic tokens like "Error:", "error", "fail", "invalid" without checking concrete
 * error contract messages or domain terms). Production comparisons are not assertions.
 */
export function lintAssertionQuality(patch: string): AssertionQualityResult {
  const flaggedTautologicalAssertions: string[] = [];
  if (!patch) return { isClean: true, flaggedTautologicalAssertions };

  const lines = patch.split("\n");
  let currentFileIsTest: boolean | undefined;
  for (const line of lines) {
    if (line.startsWith("+++ ")) {
      currentFileIsTest = isTestSourcePath(line.slice(4).trim());
      continue;
    }
    if (
      !line.startsWith("+") ||
      line.startsWith("+++") ||
      currentFileIsTest === false
    ) {
      continue;
    }
    const addedContent = line.slice(1).trim();

    // Cover two-argument helpers (Go strings.Contains/assertIn) and common
    // one-argument matcher APIs (Jest/Bun toContain/toThrow).
    const matches = [
      ...addedContent.matchAll(
        /(?:\bcontains\b|\bassertContains\b|\bassert\.Contains\b|\bassertIn\b)\s*\([^,]+,\s*["'`]([^"'`]+)["'`]/gi,
      ),
      ...addedContent.matchAll(
        /\.(?:toContain|toThrow)\s*\(\s*["'`]([^"'`]+)["'`]/gi,
      ),
    ];
    const genericTokens = new Set([
      "error",
      "error:",
      "err",
      "err:",
      "fail",
      "fail:",
      "failed",
      "failed:",
      "invalid",
      "invalid:",
      "exception",
      "exception:",
    ]);
    for (const match of matches) {
      const needle = match[1].trim();
      if (genericTokens.has(needle.toLowerCase())) {
        flaggedTautologicalAssertions.push(
          `Tautological error assertion "${needle}" in: ${addedContent}`,
        );
      }
    }
  }

  return {
    isClean: flaggedTautologicalAssertions.length === 0,
    flaggedTautologicalAssertions,
  };
}

export interface CommentHyperboleResult {
  isClean: boolean;
  flaggedCommentHyperboles: string[];
}

/**
 * Patch Comment Severity & Hyperbole Linter
 *
 * Scans code comments added in the diff (//, /*, *, #) for crash/panic claims
 * (e.g. "crashes", "panics", "fatal crash") that available RED evidence does not
 * establish. Missing evidence is inconclusive and does not authorize the claim.
 */
export function lintPatchCommentHyperbole(
  patch: string,
  evidence?: { exitCode?: number; observedOutputSnippet?: string },
): CommentHyperboleResult {
  const flaggedCommentHyperboles: string[] = [];
  if (!patch) return { isClean: true, flaggedCommentHyperboles };

  const snippet = evidence?.observedOutputSnippet?.toLowerCase() ?? "";
  const isActualCrashOrPanic =
    snippet.includes("panic:") ||
    snippet.includes("sigsegv") ||
    snippet.includes("segmentation fault") ||
    snippet.includes("fatal error: concurrent map") ||
    snippet.includes("deadlock");

  const lines = patch.split("\n");
  for (const line of lines) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const addedContent = line.slice(1).trim();

    if (
      addedContent.startsWith("//") ||
      addedContent.startsWith("/*") ||
      addedContent.startsWith("*") ||
      addedContent.startsWith("#")
    ) {
      const lower = addedContent.toLowerCase();
      const hyperboleWords = [
        /\bcrashes\b/,
        /\bcrashing\b/,
        /\bcrash the\b/,
        /\bcrashes the\b/,
        /\bpanics\b/,
        /\bpanicking\b/,
        /\bfatal crash\b/,
        /\bcatastrophic failure\b/,
      ];

      if (!isActualCrashOrPanic) {
        for (const pattern of hyperboleWords) {
          if (pattern.test(lower)) {
            flaggedCommentHyperboles.push(
              `Unsubstantiated crash/panic claim in comment: "${addedContent}" (available RED evidence does not establish an unhandled process crash/panic).`,
            );
            break;
          }
        }
      }
    }
  }

  return {
    isClean: flaggedCommentHyperboles.length === 0,
    flaggedCommentHyperboles,
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
  coreDiffLines?: number;
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
  // Implementation confidence: based on core logic diff size
  const effectiveCoreLines = input.coreDiffLines !== undefined ? input.coreDiffLines : diffLines;
  const implementation =
    effectiveCoreLines <= 100
      ? 94
      : Math.max(60, 94 - Math.round((effectiveCoreLines - 100) * 0.25));
  // Regression confidence: based on actual test passes
  const regression = testsPassed ? 93 : 50;
  // Defensive coverage comes from executed tests. Changed-code coverage is a
  // separate mandatory policy gate when a trusted policy enables it.
  const defensiveCoverage =
    passedUnitTests > 0 ? 91 : subagentReviewAvailable ? 86 : 75;
  let testCoverage =
    passedUnitTests > 0 ? 92 : subagentReviewAvailable ? 85 : 70;
  if (
    typeof testCoveragePercent === "number" &&
    input.coverageMinimumPercent !== undefined
  ) {
    if (testCoveragePercent >= coverageThreshold) {
      testCoverage = Math.min(
        100,
        Math.round(
          coverageThreshold + (testCoveragePercent - coverageThreshold) * 1.0,
        ),
      );
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
  modifiedFiles?: string[];
  repoContextFiles?: string[];
  baseFileContents?: ReadonlyMap<string, string>;
  coreDiffLines?: number;
  preflightLintResult?: {
    executed: boolean;
    passed: boolean;
    summary: string;
    violations?: string[];
  };
  targetRepo?: string;
  issueNumber?: number;
}

function isNonNegativeLineCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isSupportingFile(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    isTestPath(normalized, false) ||
    /\.(?:md|mdx|rst)$/.test(normalized) ||
    /(^|\/)docs?(?:\/|$)/.test(normalized)
  );
}

function parseDiffPath(rawPath: string): string {
  const path = rawPath.trim();
  return path.startsWith('"') && path.endsWith('"')
    ? path.slice(1, -1).replace(/\\(["\\])/g, "$1")
    : path;
}

function parseGitDiffPaths(line: string): string[] {
  const tokens =
    line
      .slice("diff --git ".length)
      .match(/"(?:\\.|[^"])*"|\S+/g) ?? [];
  return tokens.map(parseDiffPath);
}

function parseUnifiedDiffPath(line: string): string {
  return parseDiffPath(line.slice(4).split("\t", 1)[0] ?? "");
}

interface DiffLineAccountingState {
  currentFile: string;
  oldFilePath: string;
  totalLines: number;
  coreLines: number;
  hasFileHeaders: boolean;
  hasCoreFileHeader: boolean;
  pendingUnifiedFileHeader: boolean;
  inHunk: boolean;
  remainingOldLines: number | undefined;
  remainingNewLines: number | undefined;
}

function recordChangedLine(state: DiffLineAccountingState): void {
  state.totalLines++;
  if (!state.hasFileHeaders || !isSupportingFile(state.currentFile)) {
    state.coreLines++;
  }
}

function recordDiffFile(state: DiffLineAccountingState, path: string): void {
  if (path && !isSupportingFile(path)) state.hasCoreFileHeader = true;
}

function handleGitDiffHeader(
  state: DiffLineAccountingState,
  line: string,
): boolean {
  if (!line.startsWith("diff --git ")) return false;
  state.inHunk = false;
  state.remainingOldLines = undefined;
  state.remainingNewLines = undefined;
  state.hasFileHeaders = true;
  state.pendingUnifiedFileHeader = true;
  state.oldFilePath = "";
  const paths = parseGitDiffPaths(line);
  state.currentFile = paths[1] ?? paths[0] ?? "";
  recordDiffFile(state, state.currentFile);
  return true;
}

function handleHunkHeader(
  state: DiffLineAccountingState,
  line: string,
): boolean {
  if (!line.startsWith("@@")) return false;
  state.pendingUnifiedFileHeader = false;
  const counts = line.match(
    /^@@\s+-\d+(?:,(\d+))?\s+\+\d+(?:,(\d+))?\s+@@/,
  );
  state.inHunk = true;
  state.remainingOldLines = counts ? Number(counts[1] ?? 1) : undefined;
  state.remainingNewLines = counts ? Number(counts[2] ?? 1) : undefined;
  if (state.remainingOldLines === 0 && state.remainingNewLines === 0) {
    state.inHunk = false;
  }
  return true;
}

function handleUnifiedFileHeader(
  state: DiffLineAccountingState,
  line: string,
): boolean {
  if (state.inHunk) return false;
  if (line.startsWith("--- ")) {
    state.hasFileHeaders = true;
    state.pendingUnifiedFileHeader = true;
    state.oldFilePath = parseUnifiedDiffPath(line);
    if (state.oldFilePath !== "/dev/null") {
      state.currentFile = state.oldFilePath;
    }
    recordDiffFile(state, state.currentFile);
    return true;
  }
  if (state.pendingUnifiedFileHeader && line.startsWith("+++ ")) {
    state.hasFileHeaders = true;
    const newFilePath = parseUnifiedDiffPath(line);
    state.currentFile =
      newFilePath === "/dev/null" ? state.oldFilePath : newFilePath;
    state.pendingUnifiedFileHeader = false;
    recordDiffFile(state, state.currentFile);
    return true;
  }
  return false;
}

function handleHunkBody(
  state: DiffLineAccountingState,
  line: string,
): boolean {
  if (!state.inHunk) return false;
  if (line.startsWith("+")) {
    recordChangedLine(state);
    if (state.remainingNewLines !== undefined) state.remainingNewLines--;
  } else if (line.startsWith("-")) {
    recordChangedLine(state);
    if (state.remainingOldLines !== undefined) state.remainingOldLines--;
  } else if (line.startsWith(" ")) {
    if (state.remainingOldLines !== undefined) state.remainingOldLines--;
    if (state.remainingNewLines !== undefined) state.remainingNewLines--;
  }
  if (state.remainingOldLines === 0 && state.remainingNewLines === 0) {
    state.inHunk = false;
  }
  return true;
}

function calculateDiffLines(patch: string): {
  totalLines: number;
  coreLines: number;
} {
  if (!patch) return { totalLines: 0, coreLines: 0 };

  const state: DiffLineAccountingState = {
    currentFile: "",
    oldFilePath: "",
    totalLines: 0,
    coreLines: 0,
    hasFileHeaders: false,
    hasCoreFileHeader: false,
    pendingUnifiedFileHeader: false,
    inHunk: false,
    remainingOldLines: undefined,
    remainingNewLines: undefined,
  };

  const lines = patch.split(/\r?\n/);
  for (const line of lines) {
    if (
      handleGitDiffHeader(state, line) ||
      handleHunkHeader(state, line) ||
      handleUnifiedFileHeader(state, line) ||
      handleHunkBody(state, line)
    ) {
      continue;
    }
    if (line.startsWith("+") || line.startsWith("-")) {
      recordChangedLine(state);
    }
  }

  if (state.totalLines === 0 && lines.length > 0) {
    state.totalLines = lines.length;
    if (!state.hasFileHeaders || state.hasCoreFileHeader) {
      state.coreLines = lines.length;
    }
  }

  return { totalLines: state.totalLines, coreLines: state.coreLines };
}

export function auditGovernance(
  input: AuditGovernanceInput,
): GovernanceAuditResult & {
  overallConfidence: { isPassed: boolean; overallScore: number };
} {
  const patch = input.diffText ?? input.patchContent ?? "";
  const prBody = input.prBodyText || input.prBody || "";
  const validatedLineCount = isNonNegativeLineCount(input.lineCount)
    ? input.lineCount
    : undefined;
  const validatedCoreLineCount = isNonNegativeLineCount(input.coreDiffLines)
    ? input.coreDiffLines
    : undefined;
  let lines = validatedLineCount ?? 0;
  let coreLines = validatedCoreLineCount ?? validatedLineCount ?? 0;
  if (validatedLineCount === undefined && patch) {
    const calculated = calculateDiffLines(patch);
    lines = calculated.totalLines;
    coreLines = validatedCoreLineCount ?? calculated.coreLines;
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
          : undefined,
      diffLines: lines,
      coreDiffLines: coreLines,
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

  // 1b. Assertion Quality & Patch Comment Severity Linting (Anti-Bypass Hard Gates)
  const redEv = input.evidence?.redEvidence;
  const commentHyperboleCheck = lintPatchCommentHyperbole(patch, redEv);
  const assertionQualityCheck = lintAssertionQuality(patch);
  const commentHyperbolePassed = commentHyperboleCheck.isClean;
  const assertionQualityPassed = assertionQualityCheck.isClean;
  const flaggedCommentHyperboles = commentHyperboleCheck.flaggedCommentHyperboles;
  const flaggedTautologicalAssertions = assertionQualityCheck.flaggedTautologicalAssertions;

  // 2. Markdown Integrity & Encoding Check
  const integrityCheck = lintMarkdownIntegrity(prBody);
  const markdownIntegrityPassed = integrityCheck.isClean;
  const corruptedMarkdownIssues = integrityCheck.corruptedIssues;

  // 3. RFC 100-line (or configured maxDiffLines) Gate Check
  const rfcGatePassed = coreLines <= maxDiffAllowed;

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
  const executedTestsGatePassed =
    input.evidence?.zeroAssertionWarning !== true &&
    Number.isSafeInteger(input.evidence?.passedUnitTestsCount) &&
    (input.evidence?.passedUnitTestsCount ?? 0) > 0 &&
    input.evidence?.allTestsPassing !== false &&
    (input.evidence?.failedUnitTestsCount ?? 0) === 0;

  // 3b. Cross-Platform, Collision & Lifecycle Impact Analysis Check
  let impactAnalysisPassed = true;
  const impactAnalysisIssues: string[] = [];
  if (patch) {
    const impactResult = analyzePatchImpactAndConsistency({
      modifiedFiles: input.modifiedFiles || [],
      patchContent: input.diffText ?? patch,
      repoContextFiles: input.repoContextFiles || [],
    });
    impactAnalysisPassed = impactResult.isCompliant;
    impactAnalysisIssues.push(
      ...impactResult.crossPlatformHazards,
      ...impactResult.defensiveRecommendations,
      ...impactResult.consistencyWarnings,
    );
  }

  // 3c. Upstream Pre-Flight Lint & Code Style Gate Check
  let preflightLintPassed = input.preflightLintResult?.passed === true;
  const preflightLintIssues: string[] = [];
  if (!input.preflightLintResult) {
    preflightLintIssues.push(
      'Pre-flight lint result is unavailable; the required check was not supplied.',
    );
  } else if (!preflightLintPassed) {
    preflightLintIssues.push(input.preflightLintResult.summary);
    if (input.preflightLintResult.violations?.length) {
      preflightLintIssues.push(...input.preflightLintResult.violations);
    }
  }

  // 3d. Anti-Hardcode & Generalization Gate Check
  let antiHardcodePassed = true;
  const flaggedHardcodeIssues: string[] = [];
  if (patch) {
    const hardcodeResult = lintAntiHardcode(patch, {
      targetRepo: input.targetRepo,
      issueNumber: input.issueNumber,
      baseFileContents: input.baseFileContents,
    });
    antiHardcodePassed = hardcodeResult.isClean;
    if (!antiHardcodePassed) {
      flaggedHardcodeIssues.push(
        ...hardcodeResult.violations.map(
          (v) => `${v.file}: [${v.rule}] ${v.reason} (line: ${v.line.trim()})`,
        ),
      );
    }
  }

  const isTechnicalGatePassed =
    antiAiCheckPassed &&
    markdownIntegrityPassed &&
    commentHyperbolePassed &&
    assertionQualityPassed &&
    rfcGatePassed &&
    confidence.isPassed &&
    coverageGatePassed &&
    resourceLeakGatePassed &&
    executedTestsGatePassed &&
    impactAnalysisPassed &&
    preflightLintPassed &&
    antiHardcodePassed;

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
  if (!executedTestsGatePassed) {
    remediationSuggestions.push("Evidence contains no verified executed tests. Run a supported test runner with a non-empty test selection before governance audit.");
  }
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
      `Diff exceeds the configured limit of ${maxDiffAllowed} lines (${coreLines} core lines). Split into RFC Discussion issue first.`,
    );
  } else if (lines > maxDiffAllowed) {
    remediationSuggestions.push(
      `Supporting Engineering Exemption: Core production logic is within threshold (${coreLines}/${maxDiffAllowed} lines). Additional ${lines - coreLines} lines are test matrices and documentation.`,
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
        "Missing empirical evidence artifact: Run 'opencontrib evidence capture-red --test-cmd <cmd> --assertion <pattern>' before the fix, then verify GREEN before governance audit.",
      );
    }
  }

  if (!commentHyperbolePassed) {
    remediationSuggestions.push(
      ...flaggedCommentHyperboles.map(
        (issue) =>
          `Comment Severity Gate: ${issue} Provide RED evidence that establishes an unhandled crash/panic or use factual descriptions such as "fails the tool call with a Go error" or "returns a handled error".`,
      ),
    );
  }
  if (!assertionQualityPassed) {
    remediationSuggestions.push(
      ...flaggedTautologicalAssertions.map(
        (issue) =>
          `Assertion Quality Gate: ${issue} Tighten assertion to check domain error semantics (e.g. specific message or error code), not generic prefixes.`,
      ),
    );
  }

  if (!impactAnalysisPassed) {
    remediationSuggestions.push(
      `Impact Gate: ${impactAnalysisIssues.join("; ")}`,
    );
  }

  if (!preflightLintPassed) {
    remediationSuggestions.push(
      `Pre-Flight Lint Gate: Target repository static check failed. ${preflightLintIssues.slice(0, 3).join("; ")}. Fix code formatting and linting errors locally before opening a pull request.`,
    );
  }

  if (!antiHardcodePassed) {
    remediationSuggestions.push(
      `Anti-Hardcode Gate: Detected lazy model shortcuts or hardcoded literals in production logic: ${flaggedHardcodeIssues.slice(0, 3).join("; ")}. Generalize your implementation.`,
    );
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
    assertionQualityPassed,
    flaggedTautologicalAssertions,
    commentHyperbolePassed,
    flaggedCommentHyperboles,
    impactAnalysisPassed,
    impactAnalysisIssues,
    preflightLintPassed,
    preflightLintIssues,
    antiHardcodePassed,
    flaggedHardcodeIssues,
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

export type PrTemplateEvidence = EvidenceReport;

export interface MasterPrTemplateInput {
  issueNumber?: number;
  submissionRoute?: "PUBLIC_ISSUE" | "PRIVATE_SECURITY";
  issueTitle?: string;
  summary?: string;
  problemSummary?: string;
  rootCause?: string;
  keyChanges?: string[];
  verificationCommand?: string;
  validationCommand?: string;
  validationOutputSnippet?: string;
  stressLoopCount?: number;
  confidenceScore?: number;
  riskLevel?: "LOW" | "MEDIUM" | "HIGH";
  isDocumentationOnly?: boolean;
  aiDisclosureRequired?: boolean;
  dcoRequired?: boolean;
  conditionalAiRequired?: boolean;
  nativeTemplateContent?: string;
  evidence?: PrTemplateEvidence;
}

interface MarkdownLineRecord {
  text: string;
  start: number;
  end: number;
  ending: string;
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

function markdownLineRecords(content: string): MarkdownLineRecord[] {
  const records: MarkdownLineRecord[] = [];
  const newlines = /\r\n|\n|\r/g;
  let start = 0;
  let match: RegExpExecArray | null;
  while ((match = newlines.exec(content)) !== null) {
    records.push({
      text: content.slice(start, match.index),
      start,
      end: newlines.lastIndex,
      ending: match[0],
    });
    start = newlines.lastIndex;
  }
  if (start < content.length || records.length === 0) {
    records.push({
      text: content.slice(start),
      start,
      end: content.length,
      ending: "",
    });
  }
  return records;
}

function markdownFenceOpener(line: string): MarkdownFence | undefined {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})/);
  if (!match) return undefined;
  return { marker: match[1][0] as "`" | "~", length: match[1].length };
}

function isMarkdownFenceCloser(line: string, fence: MarkdownFence): boolean {
  const match = line.match(/^ {0,3}(`+|~+)\s*$/);
  return Boolean(
    match &&
      match[1][0] === fence.marker &&
      match[1].length >= fence.length,
  );
}

function findRelatedIssuesSection(content: string): {
  bodyStart: number;
  end: number;
  headingHasNewline: boolean;
} | undefined {
  let fence: MarkdownFence | undefined;
  let section:
    | { bodyStart: number; end: number; headingHasNewline: boolean }
    | undefined;

  for (const line of markdownLineRecords(content)) {
    if (fence) {
      if (isMarkdownFenceCloser(line.text, fence)) fence = undefined;
      continue;
    }
    const opener = markdownFenceOpener(line.text);
    if (opener) {
      fence = opener;
      continue;
    }

    const heading = line.text.match(/^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/);
    if (!heading) continue;
    const level = heading[1].length;
    const title = heading[2]
      .replace(/[ \t]+#+[ \t]*$/, "")
      .trim()
      .toLowerCase();
    if (!section) {
      if (level === 2 && title === "related issues") {
        section = {
          bodyStart: line.end,
          end: content.length,
          headingHasNewline: line.ending.length > 0,
        };
      }
    } else if (level <= 2) {
      section.end = line.start;
      return section;
    }
  }
  return section;
}

function rewriteIssueReferences(
  content: string,
  issueNumber?: number,
  includeFencedCode = false,
): { content: string; replaced: boolean } {
  let replaced = false;
  const pattern =
    issueNumber === undefined
      ? /(?:- \[[ x]\]\s+)?\b(fixes|closes|resolves|related issue|issue)[:\s]+#(?:\d+|<[^>\r\n]+>|\[[^\]\r\n]+\]|(?=[ \t\r\n]|$))/gi
      : /(- \[[ x]\]\s+)?\b(fixes|closes|resolves|related issue|issue)[:\s]+#(?:\d+|<[^>\r\n]+>|\[[^\]\r\n]+\]|(?=[ \t\r\n]|$))/i;
  const rewriteLine = (text: string): string => {
    if (issueNumber !== undefined && replaced) return text;
    return text.replace(pattern, (match, prefix: string | undefined, verb: string) => {
      replaced = true;
      if (issueNumber === undefined) return "";
      const normalizedVerb = /fixes/i.test(verb)
        ? "Fixes"
        : /closes/i.test(verb)
          ? "Closes"
          : /resolves/i.test(verb)
            ? "Resolves"
            : verb;
      if (prefix) {
        return `- [x] ${normalizedVerb} #${issueNumber}`;
      }
      return `${normalizedVerb} #${issueNumber}`;
    });
  };

  let fence: MarkdownFence | undefined;
  const rewritten = markdownLineRecords(content)
    .map((line) => {
      if (fence) {
        const text = includeFencedCode ? rewriteLine(line.text) : line.text;
        if (isMarkdownFenceCloser(line.text, fence)) fence = undefined;
        return `${text}${line.ending}`;
      }
      const opener = markdownFenceOpener(line.text);
      if (opener) {
        fence = opener;
        const text = includeFencedCode ? rewriteLine(line.text) : line.text;
        return `${text}${line.ending}`;
      }
      return `${rewriteLine(line.text)}${line.ending}`;
    })
    .join("");
  return { content: rewritten, replaced };
}

function insertIssueReferenceInSection(
  content: string,
  section: { bodyStart: number; headingHasNewline: boolean },
  reference: string,
): string {
  const newline = content.includes("\r\n")
    ? "\r\n"
    : content.includes("\r")
      ? "\r"
      : "\n";
  const separator = section.headingHasNewline ? "" : newline;
  return `${content.slice(0, section.bodyStart)}${separator}${reference}${newline}${content.slice(section.bodyStart)}`;
}

function updateNativeTemplateIssueReference(
  content: string,
  issueReference: string,
  submissionRoute: "PUBLIC_ISSUE" | "PRIVATE_SECURITY",
  issueNumber?: number,
): string {
  if (submissionRoute === "PRIVATE_SECURITY") {
    const withoutPublicReferences = rewriteIssueReferences(
      content,
      undefined,
      true,
    ).content;
    const section = findRelatedIssuesSection(withoutPublicReferences);
    return section
      ? insertIssueReferenceInSection(
          withoutPublicReferences,
          section,
          issueReference,
        )
      : `${issueReference}\n\n${withoutPublicReferences}`;
  }

  const publicIssueNumber = issueNumber ?? 0;
  const section = findRelatedIssuesSection(content);
  if (section) {
    const body = content.slice(section.bodyStart, section.end);
    const rewrittenBody = rewriteIssueReferences(body, publicIssueNumber);
    return rewrittenBody.replaced
      ? `${content.slice(0, section.bodyStart)}${rewrittenBody.content}${content.slice(section.end)}`
      : insertIssueReferenceInSection(
          content,
          section,
          `closes #${publicIssueNumber}`,
        );
  }

  const rewritten = rewriteIssueReferences(content, publicIssueNumber);
  return rewritten.replaced
    ? rewritten.content
    : `${issueReference}\n\n${content}`;
}

export function renderMasterPrTemplate(data: MasterPrTemplateInput): string {
  const aiDisclosureRequired = data.aiDisclosureRequired === true || data.conditionalAiRequired === true;
  const submissionRoute = data.submissionRoute ?? "PUBLIC_ISSUE";
  if (
    submissionRoute === "PUBLIC_ISSUE" &&
    (!Number.isInteger(data.issueNumber) || (data.issueNumber ?? 0) <= 0)
  ) {
    throw new Error(
      "CanonicalIssueBindingRequiredError: public PR rendering requires a provider-verified positive issue number.",
    );
  }
  const issueReference =
    submissionRoute === "PUBLIC_ISSUE"
      ? `Fixes #${data.issueNumber}`
      : "Security disclosure: provider-verified private channel";
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
    validatedEvidence.redEvidence?.assertionMatched === true &&
    validatedEvidence.redEvidence.exitCode !== 0;
  const canonicalReproductionCommand = reproductionVerified
    ? validatedEvidence.redEvidence?.command
    : undefined;
  const green = validatedEvidence?.greenEvidence;
  const verificationPassed =
    validatedEvidence !== undefined &&
    validatedEvidence.reproductionVerified === true &&
    green?.passed === true &&
    green.exitCode === 0 &&
    green.treeChangedComparedToRed === true &&
    green.treeHashMatchesRed !== true &&
    validatedEvidence.allTestsPassing === true &&
    validatedEvidence.stressLoopPassed === true &&
    validatedEvidence.failedUnitTestsCount === 0 &&
    validatedEvidence.roundsRequested !== undefined &&
    validatedEvidence.roundsCompleted === validatedEvidence.roundsRequested &&
    validatedEvidence.workersPerRound !== undefined &&
    validatedEvidence.executionsExpected !== undefined &&
    validatedEvidence.executionCount === validatedEvidence.executionsExpected;
  const canonicalVerificationCommand = verificationPassed
    ? green?.command
    : undefined;
  const canonicalTestCount = verificationPassed
    ? validatedEvidence?.passedUnitTestsCount
    : undefined;
  const stressLoopCount = verificationPassed
    ? (validatedEvidence?.roundsRequested ?? 0)
    : 0;
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
    ? `passed; ${canonicalTestCount ?? "unit test suite"} test assertions reported across ${stressLoopCount} completed stress loop run(s).`
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
    // Clean common unfilled placeholder brackets
    result = result.replace(
      /\[(?:please\s+)?(?:describe|provide|insert|fill\s+in)\b[^\]\r\n]*\]/gi,
      "",
    );

    result = updateNativeTemplateIssueReference(
      result,
      issueReference,
      submissionRoute,
      data.issueNumber,
    );

    if (
      /## description|## summary|## motivation|### description/i.test(result)
    ) {
      result = result.replace(
        /(##\s*(?:description|summary|motivation)[\s\S]*?)(?=##|$)/i,
        (_match, section) => {
          const headerLine = section.split(/\r?\n/)[0];
          return `${headerLine}\n\n${problemSummary}\n\n**Root Cause**: ${rootCause}\n\n**Key Changes**:\n${keyChanges.map((c) => `- ${c}`).join("\n")}\n\n`;
        },
      );
    }

    // Auto-check Type of Change checkboxes
    if (data.isDocumentationOnly) {
      result = result.replace(/- \[[ x]\] (Documentation(?: update)?)/i, "- [x] $1");
    } else {
      result = result.replace(/- \[[ x]\] (Bug fix[^\r\n]*)/i, "- [x] $1");
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
          `${section.trim()}\n\n${reproductionDetail}\n${verificationLine}\n- Test Suite: ${testSuite}\n${userValidationNote}\n\n`,
      );
    }

    // Contributor attestations are never inferred from pipeline evidence.


    const complianceNotes = [
      aiDisclosureRequired
        ? "Automated assistance disclosure: This contribution was prepared using OpenContrib AI-assisted tooling; specific model details were not recorded in this run."
        : "",
      data.dcoRequired
        ? "DCO requirement: the commits must include a valid Signed-off-by trailer."
        : "",
    ].filter(Boolean);
    return `${result.trim()}${complianceNotes.length ? `\n\n${complianceNotes.join("\n\n")}` : ""}`.trim();
  }

  const changeList = keyChanges.map((c) => `- ${c}`).join("\n");
  let regressionLine = "- **Regression Isolation**: Not recorded.";
  if (validatedEvidence?.baselineFlakyTests?.length) {
    regressionLine = `- **Regression Isolation**: ${validatedEvidence.baselineFlakyTests.length} baseline flaky test(s) observed.`;
  }

  const aiDisclosureSection = aiDisclosureRequired
    ? `\n\n### Automated Assistance Disclosure\nThis contribution was prepared using OpenContrib AI-assisted tooling; specific model details were not recorded in this run.`
    : "";

  return `### Problem Description
${issueReference}
${problemSummary}

### Motivation & Root Cause Analysis
${rootCause}

### Key Implementation Changes
${changeList}

### Verification & Empirical Evidence
${reproductionDetail}
${verificationLine}
${regressionLine}${userValidationNote}${aiDisclosureSection}${
    data.dcoRequired
      ? "\n\n### Community Compliance\nDCO is required; every commit must include a valid `Signed-off-by` trailer."
      : ""
  }
`;
}
