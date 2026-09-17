import { z } from "zod";

export const IssueEvaluationSchema = z.object({
  issueNumber: z.number(),
  title: z.string(),
  isReproducible: z.boolean(),
  estimatedDifficulty: z.enum(["trivial", "easy", "medium", "hard"]),
  rootCauseHypothesis: z.string(),
  recommendedAction: z.string(),
  confidenceScore: z.number().min(0).max(100),
});

export type IssueEvaluation = z.infer<typeof IssueEvaluationSchema>;

export const CodeChangeFileSchema = z.object({
  path: z.string(),
  operation: z.enum(["CREATE", "MODIFY", "DELETE"]),
  content: z.string(),
  mode: z.enum(["100644", "100755", "120000"]).default("100644"),
  explanation: z.string(),
});

export type CodeChangeFile = z.infer<typeof CodeChangeFileSchema>;

export const PatchDraftSchema = z.object({
  title: z.string(),
  summary: z.string(),
  rationale: z.string(),
  targetFiles: z.array(
    z.object({
      path: z.string(),
      reason: z.string(),
    }),
  ),
  files: z.array(CodeChangeFileSchema).default([]),
  implementationSteps: z.array(z.string()),
  regressionTestPlan: z.array(z.string()),
  estimatedDiffLines: z.number(),
});

export type PatchDraft = z.infer<typeof PatchDraftSchema>;

/** Strict autonomous RED design; this is a plan, not evidence. */
export const ReproductionDesignSchema = z.object({
  command: z.string().min(1),
  expectedAssertion: z.string().min(1),
  testFiles: z.array(z.string().min(1)).min(1),
  rationale: z.string().min(1),
  /**
   * Optional reproduction code modifications (e.g. newly created or edited regression test files)
   * that must be applied to the baseline workspace BEFORE capturing RED.
   */
  reproductionFiles: z.array(CodeChangeFileSchema).optional(),
});
export type ReproductionDesign = z.infer<typeof ReproductionDesignSchema>;

export const SubagentReviewEvaluationSchema = z.object({
  maintainerPerspective: z.object({
    acceptanceLikelihood: z.enum(["HIGH", "MEDIUM", "LOW"]),
    styleConformance: z.string(),
    concerns: z.array(z.string()),
  }),
  securityPerspective: z.object({
    vulnerabilitiesDetected: z.boolean(),
    findings: z.array(z.string()),
  }),
  qaPerspective: z.object({
    testAdequacy: z.string(),
    flakyRisk: z.string(),
  }),
  confidenceBreakdown: z.object({
    rootCause: z.number().min(0).max(100),
    implementation: z.number().min(0).max(100),
    regression: z.number().min(0).max(100),
    defensiveCoverage: z.number().min(0).max(100),
    testCoverage: z.number().min(0).max(100),
    styleMatch: z.number().min(0).max(100),
    securityAudit: z.number().min(0).max(100),
  }),
});

export type SubagentReviewEvaluation = z.infer<
  typeof SubagentReviewEvaluationSchema
>;

export const PullRequestDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  branchName: z.string(),
  isDraft: z.boolean().default(true),
  linkedIssueNumber: z.number().optional(),
  labels: z.array(z.string()).default([]),
});

export type PullRequestDraft = z.infer<typeof PullRequestDraftSchema>;
