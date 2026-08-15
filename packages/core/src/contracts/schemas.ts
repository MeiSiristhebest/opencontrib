import { z } from 'zod';

// ==========================================
// 1. User Profile & Configuration
// ==========================================
export const UserProfileSchema = z.object({
  techStack: z.array(z.string()).default(['typescript', 'javascript', 'nodejs']),
  proficiency: z.enum(['beginner', 'intermediate', 'advanced']).default('intermediate'),
  focusAreas: z.array(z.string()).default(['frontend', 'backend', 'tooling']),
  githubUsername: z.string().optional(),
  minMatchScore: z.number().min(0).max(100).default(70),
});
export type UserProfile = z.infer<typeof UserProfileSchema>;

// ==========================================
// 2. Issue Discovery & Feasibility Contracts
// ==========================================
export const FeasibilityLevelSchema = z.enum([
  'fully_feasible',
  'likely_fixable',
  'needs_investigation',
  'likely_blocked',
  'hard_blocked',
]);
export type FeasibilityLevel = z.infer<typeof FeasibilityLevelSchema>;

export const FeasibilityAssessmentSchema = z.object({
  level: FeasibilityLevelSchema,
  scorePenalty: z.number().default(0),
  scope: z.enum(['small_code_change', 'docs_only', 'runtime_bug', 'performance', 'complex_refactor', 'hardware_specific']),
  detectedRisks: z.array(z.string()),
  missingCapabilities: z.array(z.string()),
  mitigations: z.array(z.string()),
  rationale: z.string(),
});
export type FeasibilityAssessment = z.infer<typeof FeasibilityAssessmentSchema>;

export const QualificationResultSchema = z.object({
  isQualified: z.boolean(),
  disqualifyReason: z.string().optional(),
  track: z.enum(['fast_track', 'standard_track']),
  hasExistingPr: z.boolean(),
  hasClaimant: z.boolean(),
  authorFirstRightActive: z.boolean(),
  authorFirstRightDetails: z.string().optional(),
  inspectedCommentsCount: z.number(),
  botRules: z.array(z.string()),
});
export type QualificationResult = z.infer<typeof QualificationResultSchema>;

export const OpportunityOpportunitySchema = z.object({
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
  rawScore: z.number().min(0).max(100).optional(),
  adjustedScore: z.number().min(0).max(100),
  diversityPenalty: z.number().default(0).optional(),
  rankScore: z.number().min(0).max(100).optional(),
  qualification: QualificationResultSchema,
  estimatedWorkload: z.string(),
  coreDemand: z.string(),
  discoveryMode: z.enum(['targeted_repo', 'global_discovery']).optional(),
  matchedSignals: z.object({
    techStack: z.array(z.string()),
    focusAreas: z.array(z.string()),
    labels: z.array(z.string()),
    freshnessModifier: z.number(),
    actionabilityModifier: z.number(),
  }).optional(),
});
export type Opportunity = z.infer<typeof OpportunityOpportunitySchema>;

// ==========================================
// 3. Proactive Probe Contracts
// ==========================================
export const ProbeSuggestionSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(['dx_docs', 'ci_workflow', 'type_safety', 'code_hygiene', 'security']),
  summary: z.string(),
  rationale: z.string(),
  targetFiles: z.array(z.object({
    path: z.string(),
    reason: z.string(),
  })),
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
// 4. Empirical Evidence Contracts
// ==========================================
export const FlakyTestRecordSchema = z.object({
  testName: z.string(),
  runCount: z.number(),
  failCount: z.number(),
  isFlakyOnBaseline: z.boolean(),
});

export const EvidenceReportSchema = z.object({
  baselineTestedAt: z.string(),
  baselineFlakyTests: z.array(FlakyTestRecordSchema),
  stressLoopRuns: z.number().default(20),
  stressLoopPassed: z.boolean(),
  handleLeakCheckPassed: z.boolean(),
  initialDescriptorCount: z.number().optional(),
  finalDescriptorCount: z.number().optional(),
  passedUnitTestsCount: z.number(),
  addedUnitTestsCount: z.number(),
  benchmarkMetrics: z.record(z.string(), z.string()).optional(),
  rawExecutionLogs: z.string().optional(),
});
export type EvidenceReport = z.infer<typeof EvidenceReportSchema>;

// ==========================================
// 5. Governance & Confidence Contracts
// ==========================================
export const ConfidenceBreakdownSchema = z.object({
  rootCause: z.number().min(0).max(100),       // 25%
  implementation: z.number().min(0).max(100),  // 25%
  regression: z.number().min(0).max(100),      // 20%
  defensiveCoverage: z.number().min(0).max(100),// 10%
  testCoverage: z.number().min(0).max(100),    // 10%
  styleMatch: z.number().min(0).max(100),      // 5%
  securityAudit: z.number().min(0).max(100),   // 5%
});
export type ConfidenceBreakdown = z.infer<typeof ConfidenceBreakdownSchema>;

export const GovernanceAuditResultSchema = z.object({
  overallScore: z.number(),
  weakestDimension: z.object({
    dimension: z.string(),
    score: z.number(),
  }),
  isGatedPassed: z.boolean(),
  requiresHumanApproval: z.boolean(),
  rfcGatePassed: z.boolean(),
  diffLineCount: z.number(),
  antiAiCheckPassed: z.boolean(),
  flaggedAiPhrases: z.array(z.string()),
  remediationSuggestions: z.array(z.string()),
});
export type GovernanceAuditResult = z.infer<typeof GovernanceAuditResultSchema>;

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
  pastFailures: z.array(z.object({
    date: z.string(),
    reason: z.string(),
    context: z.string(),
  })),
  successfulContributions: z.array(z.object({
    issueNumber: z.number().optional(),
    prNumber: z.number().optional(),
    prUrl: z.string(),
    title: z.string(),
    status: z.enum(['submitted', 'in_review', 'changes_requested', 'merged', 'closed']).optional().default('submitted'),
    provenance: z.object({
      source: z.enum(['agent_claim', 'github_verified', 'system_recorded']).default('agent_claim'),
      verified: z.boolean().default(false),
      verifiedAt: z.string().optional(),
    }).optional().default({ source: 'agent_claim', verified: false }),
    submittedAt: z.string().optional(),
    mergedAt: z.string().optional(),
    closedAt: z.string().optional(),
  })),
});
export type RepoMemoryEntry = z.infer<typeof RepoMemoryEntrySchema>;


export const ContributionRecordSchema = z.object({
  id: z.string(),
  repoFullName: z.string(),
  issueNumber: z.number().optional(),
  issueTitle: z.string(),
  prNumber: z.number().optional(),
  prUrl: z.string(),
  status: z.enum(['draft', 'submitted', 'in_review', 'merged', 'closed']),
  provenance: z.object({
    source: z.enum(['agent_claim', 'github_verified', 'system_recorded']).default('agent_claim'),
    verified: z.boolean().default(false),
    verifiedAt: z.string().optional(),
  }).optional().default({ source: 'agent_claim', verified: false }),
  submittedAt: z.string(),
  mergedAt: z.string().optional(),
  diffStat: z.string(),
  evidenceSummary: z.string(),
});

export type ContributionRecord = z.infer<typeof ContributionRecordSchema>;
