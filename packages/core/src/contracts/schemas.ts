import { z } from "zod";

// ==========================================
// 1. User Profile & Configuration
// ==========================================
export const UserProfileSchema = z.object({
  techStack: z
    .array(z.string())
    .default(["typescript", "javascript", "nodejs"]),
  proficiency: z
    .enum(["beginner", "intermediate", "advanced"])
    .default("intermediate"),
  focusAreas: z.array(z.string()).default(["frontend", "backend", "tooling"]),
  githubUsername: z.string().optional(),
  minMatchScore: z.number().min(0).max(100).default(70),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

// ==========================================
// 2. Issue Discovery & Feasibility Contracts
// ==========================================
export const FeasibilityLevelSchema = z.enum([
  "fully_feasible",
  "likely_fixable",
  "needs_investigation",
  "likely_blocked",
  "hard_blocked",
]);
export type FeasibilityLevel = z.infer<typeof FeasibilityLevelSchema>;

export const FeasibilityAssessmentSchema = z.object({
  level: FeasibilityLevelSchema,
  scorePenalty: z.number().default(0),
  scope: z.enum([
    "small_code_change",
    "docs_only",
    "runtime_bug",
    "performance",
    "complex_refactor",
    "hardware_specific",
  ]),
  detectedRisks: z.array(z.string()),
  missingCapabilities: z.array(z.string()),
  mitigations: z.array(z.string()),
  rationale: z.string(),
});
export type FeasibilityAssessment = z.infer<typeof FeasibilityAssessmentSchema>;

export const QualificationResultSchema = z.object({
  isQualified: z.boolean(),
  disqualifyReason: z.string().optional(),
  track: z.enum(["fast_track", "standard_track"]),
  hasExistingPr: z.boolean(),
  hasClaimant: z.boolean(),
  authorFirstRightActive: z.boolean(),
  authorFirstRightDetails: z.string().optional(),
  inspectedCommentsCount: z.number(),
  botRules: z.array(z.string()),
});
export type QualificationResult = z.infer<typeof QualificationResultSchema>;

export const OpportunitySchema = z.object({
  repoFullName: z.string(),
  repoStars: z.number(),
  issueNumber: z.number(),
  title: z.string(),
  url: z.string(),
  body: z.string(),
  labels: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
  matchScore: z.number().min(0).max(100),
  feasibility: FeasibilityAssessmentSchema,
  /**
   * Raw composite score before diversity reranking or penalty adjustments.
   * Optional for backward compatibility; defaults to matchScore when omitted.
   */
  rawScore: z.number().min(0).max(100).optional(),
  /**
   * Calibrated score after freshness, actionability and feasibility penalties.
   * Serves as the primary sorting metric for candidate qualification.
   */
  adjustedScore: z.number().min(0).max(100),
  diversityPenalty: z.number().default(0).optional(),
  rankScore: z.number().min(0).max(100).optional(),
  qualification: QualificationResultSchema,
  estimatedWorkload: z.string(),
  coreDemand: z.string(),
  discoveryMode: z.enum(["targeted_repo", "global_discovery"]).optional(),
  matchedSignals: z
    .object({
      techStack: z.array(z.string()),
      focusAreas: z.array(z.string()),
      labels: z.array(z.string()),
      freshnessModifier: z.number(),
      actionabilityModifier: z.number(),
    })
    .optional(),
});
export type Opportunity = z.infer<typeof OpportunitySchema>;

// ==========================================
// 3. Proactive Probe Contracts
// ==========================================
export const ProbeSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum([
    "dx_docs",
    "ci_workflow",
    "type_safety",
    "code_hygiene",
    "security",
  ]),
  summary: z.string(),
  rationale: z.string(),
  targetFiles: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    }),
  ),
  proposedChanges: z.array(z.string()),
  validationPlan: z.array(z.string()),
  estimatedDiffLines: z.number().max(100),
  prPotentialScore: z.number().min(0).max(100),
});
export type ProbeSuggestion = z.infer<typeof ProbeSuggestionSchema>;

export const RepoProbeResultSchema = z.object({
  repoFullName: z.string(),
  scannedFiles: z.array(z.string()),
  identifiedWorkflows: z.array(z.string()),
  suggestions: z.array(ProbeSuggestionSchema),
  timestamp: z.string(),
});
export type RepoProbeResult = z.infer<typeof RepoProbeResultSchema>;

// ==========================================
// 4. Empirical Evidence Contracts (Evidence V2)
// ==========================================
// TestIdentity binds the concrete test file(s) a command targets (by path +
// content sha256), so GREEN must prove the SAME test body went fail -> pass,
// not just that the same command string now exits 0.
export const TestIdentityFileSchema = z.object({
  path: z.string(),
  sha256: z.string(),
});
export type TestIdentityFile = z.infer<typeof TestIdentityFileSchema>;

export const TestIdentitySchema = z.object({
  normalizedCommand: z.string(),
  // A canonical RED→GREEN bundle must identify at least one concrete test
  // file. Broad commands with no deterministic test-file resolution are
  // diagnostic-only and cannot advance the run.
  testFiles: z.array(TestIdentityFileSchema).min(1),
  expectedAssertion: z.string().optional(),
  identitySha256: z.string(),
});
export type TestIdentity = z.infer<typeof TestIdentitySchema>;

export const TestMutationPolicySchema = z.object({
  allowed: z.boolean(),
  expectedDiffSha256: z.string(),
  reason: z.string().optional(),
});
export type TestMutationPolicy = z.infer<typeof TestMutationPolicySchema>;

export const RedEvidenceSchema = z.object({
  command: z.string(),
  expectedAssertion: z.string().optional(),
  observedOutputSnippet: z.string(),
  exitCode: z.number(),
  sourceTreeSha256: z.string(),
  testFileSha256: z.string().optional(),
  baselineCommitSha: z.string().optional(),
  capturedAt: z.string(),
  assertionMatched: z.boolean(),
  assertionMatchedFingerprint: z.string().optional(),
  testIdentity: TestIdentitySchema.optional(),
  testMutationAllowed: z.boolean().optional(),
  testMutationPolicy: TestMutationPolicySchema.optional(),
});
export type RedEvidence = z.infer<typeof RedEvidenceSchema>;

export const GreenEvidenceSchema = z.object({
  command: z.string(),
  exitCode: z.number(),
  outputSnippet: z.string(),
  passed: z.boolean(),
  sourceTreeSha256: z.string(),
  capturedAt: z.string(),
  treeChangedComparedToRed: z.boolean(),
  treeHashMatchesRed: z.boolean().optional(),
  stressLoopPassed: z.boolean().optional(),
  allTestsPassing: z.boolean().optional(),
  assertionMatchedFingerprint: z.string().optional(),
  testIdentity: TestIdentitySchema.optional(),
  testDiffSha256: z.string().optional(),
  actualTestDiffSha256: z.string().optional(),
  appliedPatchSha256: z.string(),
});
export type GreenEvidence = z.infer<typeof GreenEvidenceSchema>;

export const ValidatedPatchFileSchema = z.object({
  path: z.string(),
  mode: z.enum(["100644", "100755", "120000"]),
  operation: z.enum(["CREATE", "MODIFY", "DELETE"]),
  contentSha256: z.string(),
});
export type ValidatedPatchFile = z.infer<typeof ValidatedPatchFileSchema>;

export const ValidatedPatchArtifactSchema = z.object({
  runId: z.string(),
  patchSha256: z.string(),
  actualDeltaSha256: z.string(),
  baseCommitSha: z.string(),
  redTreeSha256: z.string(),
  greenTreeSha256: z.string(),
  artifactSha256: z.string(),
  changedLines: z.number().int().nonnegative(),
  files: z.array(ValidatedPatchFileSchema),
  validatedAt: z.string(),
});
export type ValidatedPatchArtifact = z.infer<
  typeof ValidatedPatchArtifactSchema
>;

export const SubmissionIntentFileSchema = z.object({
  path: z.string(),
  content: z.string(),
  mode: z.enum(["100644", "100755", "120000"]).default("100644"),
  operation: z.enum(["CREATE", "MODIFY", "DELETE"]).default("MODIFY"),
  contentSha256: z.string(),
});
export type SubmissionIntentFile = z.infer<typeof SubmissionIntentFileSchema>;

export const SubmissionIntentArtifactSchema = z.object({
  runId: z.string(),
  upstreamOwner: z.string(),
  upstreamRepo: z.string(),
  baseBranch: z.string().default("main"),
  baseCommitSha: z.string(),
  branchName: z.string(),
  title: z.string(),
  body: z.string(),
  bodySha256: z.string(),
  commitMessage: z.string(),
  isDraft: z.boolean().default(true),
  files: z.array(SubmissionIntentFileSchema),
  patchSha256: z.string(),
  evidenceSha256: z.string(),
  governanceSha256: z.string(),
  policySha256: z.string(),
  intentSha256: z.string(),
  createdAt: z.string(),
});
export type SubmissionIntentArtifact = z.infer<
  typeof SubmissionIntentArtifactSchema
>;

export const ApprovalArtifactSchema = z.object({
  runId: z.string(),
  intentSha256: z.string(),
  patchSha256: z.string(),
  evidenceSha256: z.string(),
  governanceSha256: z.string(),
  policySha256: z.string(),
  prBodySha256: z.string(),
  approvedBy: z.string().min(1),
  approvedAt: z.string(),
  approvalMode: z.enum(["explicit_human", "policy_waived"]),
  signingKeyId: z.string().min(1),
  signature: z.string().min(1),
});
export type ApprovalArtifact = z.infer<typeof ApprovalArtifactSchema>;

export const SubmissionArtifactSchema = z.object({
  runId: z.string(),
  provider: z.literal("github"),
  owner: z.string(),
  repo: z.string(),
  baseBranch: z.string(),
  baseCommitSha: z.string(),
  branchName: z.string(),
  intentSha256: z.string(),
  patchSha256: z.string(),
  evidenceSha256: z.string(),
  governanceSha256: z.string(),
  policySha256: z.string(),
  prNumber: z.number(),
  prUrl: z.string(),
  headSha: z.string(),
  submittedAt: z.string(),
  verified: z.boolean(),
});
export type SubmissionArtifact = z.infer<typeof SubmissionArtifactSchema>;

export const FlakyTestRecordSchema = z.object({
  testName: z.string(),
  runCount: z.number(),
  failCount: z.number(),
  isFlakyOnBaseline: z.boolean(),
});
export type FlakyTestRecord = z.infer<typeof FlakyTestRecordSchema>;

export const MeasurementStatusSchema = z.enum(["PASS", "FAIL", "UNAVAILABLE"]);
export type MeasurementStatus = z.infer<typeof MeasurementStatusSchema>;

export const EvidenceReportSchema = z.object({
  baselineTestedAt: z.string(),
  baselineFlakyTests: z.array(FlakyTestRecordSchema),
  // Stress semantics: one round starts workersPerRound workers; requested
  // executions are roundsRequested * workersPerRound.
  stressLoopRuns: z.number().default(1),
  roundsRequested: z.number().int().positive().optional(),
  roundsCompleted: z.number().int().nonnegative().optional(),
  workersPerRound: z.number().int().positive().optional(),
  executionsExpected: z.number().int().positive().optional(),
  stressLoopPassed: z.boolean(),
  executionCount: z.number().default(1),
  maxConcurrentObserved: z.number().default(1),
  concurrencyWorkers: z.number().default(1).optional(),
  concurrencyStampedePassed: z.boolean().default(true).optional(),
  raceCollisionsDetected: z.number().default(0).optional(),
  latencyJitterMs: z.number().optional(),
  zeroAssertionWarning: z.boolean().default(false).optional(),
  handleLeakCheckPassed: MeasurementStatusSchema,
  initialDescriptorCount: z.number().optional(),
  finalDescriptorCount: z.number().optional(),
  passedUnitTestsCount: z.number(),
  failedUnitTestsCount: z.number().default(0).optional(),
  addedUnitTestsCount: z.number().optional(),
  testCoveragePercent: z.number().min(0).max(100).optional(),
  testCoverageStatus: MeasurementStatusSchema,
  changedCodeCoveragePercent: z.number().min(0).max(100).optional(),
  changedCodeCoverageStatus: MeasurementStatusSchema,
  reproductionVerified: z.boolean().optional(),
  allTestsPassing: z.boolean().optional(),
  redEvidence: RedEvidenceSchema.optional(),
  greenEvidence: GreenEvidenceSchema.optional(),
  dualStage: z
    .object({
      preFixFailingAssertionCaptured: z.boolean().optional(),
      preFixOutput: z.string().optional(),
      postFixPassed: z.boolean().optional(),
      postFixOutput: z.string().optional(),
      isReproductionVerified: z.boolean().optional(),
      stressLoopPassed: z.boolean().optional(),
      completedRuns: z.number().optional(),
    })
    .optional(),
  benchmarkMetrics: z.record(z.string(), z.string()).optional(),
  rawExecutionLogs: z.string().optional(),
});
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;

export const EvidenceBundleV2Schema = z.object({
  redEvidence: RedEvidenceSchema.extend({
    testIdentity: TestIdentitySchema,
  }),
  greenEvidence: GreenEvidenceSchema.extend({
    testIdentity: TestIdentitySchema,
    actualTestDiffSha256: z.string().optional(),
    validatedPatchArtifactSha256: z.string(),
  }),
  reproductionVerified: z.literal(true),
  allTestsPassing: z.literal(true),
});
export type EvidenceBundleV2 = z.infer<typeof EvidenceBundleV2Schema>;

// ==========================================
// 5. Governance & Confidence Contracts
// ==========================================
export const ConfidenceBreakdownSchema = z.object({
  rootCause: z.number().min(0).max(100), // 25%
  implementation: z.number().min(0).max(100), // 25%
  regression: z.number().min(0).max(100), // 20%
  defensiveCoverage: z.number().min(0).max(100), // 10%
  testCoverage: z.number().min(0).max(100), // 10%
  styleMatch: z.number().min(0).max(100), // 5%
  securityAudit: z.number().min(0).max(100), // 5%
});
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdownSchema>;

export const GovernanceAuditResultSchema = z.object({
  overallScore: z.number(),
  weakestDimension: z.object({
    dimension: z.string(),
    score: z.number(),
  }),
  technicalGate: z
    .object({
      status: z.enum(["PASS", "FAIL"]),
      passed: z.boolean(),
    })
    .optional(),
  approvalGate: z
    .object({
      status: z.enum(["PENDING", "APPROVED", "WAIVED"]),
      approved: z.boolean(),
    })
    .optional(),
  submissionDecision: z
    .object({
      allowed: z.boolean(),
      status: z.enum(["ALLOWED", "BLOCKED", "WAIVED"]),
      reason: z.string().optional(),
    })
    .optional(),
  isGatedPassed: z.boolean(),
  requiresHumanApproval: z.boolean(),
  rfcGatePassed: z.boolean(),
  diffLineCount: z.number(),
  antiAiCheckPassed: z.boolean(),
  flaggedAiPhrases: z.array(z.string()),
  markdownIntegrityPassed: z.boolean().default(true).optional(),
  corruptedMarkdownIssues: z.array(z.string()).default([]).optional(),
  remediationSuggestions: z.array(z.string()),
  guidance: z
    .object({
      isPassed: z.boolean(),
      forbiddenActions: z.array(z.string()),
      invariants: z.array(z.string()),
      nextCommand: z.string(),
    })
    .default({
      isPassed: false,
      forbiddenActions: [],
      invariants: [],
      nextCommand: "",
    }),
});
export type GovernanceAuditResult = z.infer<typeof GovernanceAuditResultSchema>;

export const GovernanceDecisionArtifactSchema = z.object({
  runId: z.string(),
  patchSha256: z.string(),
  evidenceSha256: z.string(),
  prDraftSha256: z.string(),
  prTitle: z.string(),
  prTitleSha256: z.string(),
  auditResult: GovernanceAuditResultSchema,
  coveragePolicy: z
    .object({
      required: z.boolean().optional(),
      minimumChangedLineCoverage: z.number().optional(),
    })
    .optional(),
  resourceLeakPolicy: z.object({ required: z.boolean().optional() }).optional(),
  policySha256: z.string(),
  passed: z.boolean(),
  auditedAt: z.string(),
});
export type GovernanceDecisionArtifact = z.infer<
  typeof GovernanceDecisionArtifactSchema
>;

export const ResultArtifactSchema = z.object({
  runId: z.string(),
  submission: SubmissionArtifactSchema,
  submissionVerified: z.literal(true),
  prNumber: z.number(),
  prUrl: z.string(),
  completedAt: z.string(),
});
export type ResultArtifact = z.infer<typeof ResultArtifactSchema>;

// ==========================================
// 6. Memory & Contribution Flywheel Contracts
// ==========================================
export const RepoMemoryEntrySchema = z.object({
  repoFullName: z.string(),
  lastAnalyzedAt: z.string(),
  conventions: z.object({
    commitFormat: z.string().optional(),
    requiresDco: z.boolean().default(false),
    requiresAiDisclosure: z.boolean().default(false),
    prTemplatePath: z.string().optional(),
  }),
  pastFailures: z.array(
    z.object({
      date: z.string(),
      reason: z.string(),
      context: z.string(),
    }),
  ),
  successfulContributions: z.array(
    z.object({
      issueNumber: z.number().optional(),
      prNumber: z.number().optional(),
      prUrl: z.string(),
      title: z.string(),
      status: z
        .enum([
          "submitted",
          "in_review",
          "changes_requested",
          "merged",
          "closed",
        ])
        .optional()
        .default("submitted"),
      provenance: z
        .object({
          source: z
            .enum(["agent_claim", "github_verified", "system_recorded"])
            .default("agent_claim"),
          verified: z.boolean().default(false),
          verifiedAt: z.string().optional(),
        })
        .optional()
        .default({ source: "agent_claim", verified: false }),
      submittedAt: z.string().optional(),
      mergedAt: z.string().optional(),
      closedAt: z.string().optional(),
    }),
  ),
});
export type RepoMemoryEntry = z.infer<typeof RepoMemoryEntrySchema>;

export const ContributionRecordSchema = z.object({
  id: z.string(),
  repoFullName: z.string(),
  issueNumber: z.number().optional(),
  issueTitle: z.string(),
  prNumber: z.number().optional(),
  prUrl: z.string(),
  status: z.enum(["draft", "submitted", "in_review", "merged", "closed"]),
  provenance: z
    .object({
      source: z
        .enum(["agent_claim", "github_verified", "system_recorded"])
        .default("agent_claim"),
      verified: z.boolean().default(false),
      verifiedAt: z.string().optional(),
    })
    .optional()
    .default({ source: "agent_claim", verified: false }),
  submittedAt: z.string(),
  mergedAt: z.string().optional(),
  diffStat: z.string(),
  evidenceSummary: z.string(),
});

export type ContributionRecord = z.infer<typeof ContributionRecordSchema>;
