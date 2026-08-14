import { z } from 'zod';

export const IssueEvaluationSchema = z.object({
  issueNumber: z.number(),
  title: z.string(),
  isReproducible: z.boolean(),
  estimatedDifficulty: z.enum(['trivial', 'easy', 'medium', 'hard']),
  rootCauseHypothesis: z.string(),
  recommendedAction: z.string(),
  confidenceScore: z.number().min(0).max(100),
});

export type IssueEvaluation = z.infer<typeof IssueEvaluationSchema>;

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
  implementationSteps: z.array(z.string()),
  regressionTestPlan: z.array(z.string()),
  estimatedDiffLines: z.number(),
});

export type PatchDraft = z.infer<typeof PatchDraftSchema>;

export const PullRequestDraftSchema = z.object({
  title: z.string(),
  body: z.string(),
  branchName: z.string(),
  isDraft: z.boolean().default(true),
  linkedIssueNumber: z.number().optional(),
  labels: z.array(z.string()).default([]),
});

export type PullRequestDraft = z.infer<typeof PullRequestDraftSchema>;

export const CodeChangeFileSchema = z.object({
  path: z.string(),
  operation: z.enum(['CREATE', 'MODIFY', 'DELETE']),
  content: z.string(),
  explanation: z.string(),
});

export type CodeChangeFile = z.infer<typeof CodeChangeFileSchema>;
