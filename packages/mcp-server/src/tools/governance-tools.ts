import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  auditGovernance,
  ConfidenceBreakdownSchema,
  ProfileFlywheel,
  renderMasterPrTemplate,
  RepoMemoryLedger,
  type ContributionRecord,
} from '@opencontrib/core';

export function registerGovernanceTools(
  server: McpServer,
  memory: RepoMemoryLedger,
  flywheel: ProfileFlywheel,
): void {
  // -------------------------------------------------------------
  // Tool: contrib_audit_governance (多维质量红线与置信度审计)
  // -------------------------------------------------------------
  server.tool(
    'contrib_audit_governance',
    'Audit patch diff size, anti-AI text patterns, and compute evidence-backed 7D quality rubric & confidence breakdown',
    {
      patchContent: z.string().describe('Git unified diff string'),
      prTitle: z.string().describe('Proposed PR title'),
      prBody: z.string().describe('Proposed PR body text'),
      evidence: z
        .object({
          stressLoopPassed: z.boolean(),
          passedTestsCount: z.number(),
          hasReproductionAssertion: z.boolean().optional(),
          handleLeakFree: z.boolean().optional(),
        })
        .optional()
        .describe('Empirical evidence from contrib_collect_evidence for ground-truth rubric calculation'),
      subagentQualityScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe('Optional empirical score from external subagent review'),
      isAutonomousPrSubmission: z
        .boolean()
        .optional()
        .describe('Whether the caller is preparing for autonomous PR submission (demands empirical evidence)'),
      confidenceBreakdown: ConfidenceBreakdownSchema.optional().describe('Optional detailed 7-dimensional confidence scores'),
    },
    async (args) => {
      const audit = auditGovernance({
        patchContent: args.patchContent,
        prTitle: args.prTitle,
        prBody: args.prBody,
        evidence: args.evidence,
        subagentQualityScore: args.subagentQualityScore,
        isAutonomousPrSubmission: args.isAutonomousPrSubmission,
        confidenceBreakdown: args.confidenceBreakdown,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: audit.overallConfidence.isPassed ? 'passed' : 'failed',
                audit,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_render_pr_template (六厂融合/仓库原生 PR 描述渲染)
  // -------------------------------------------------------------
  server.tool(
    'contrib_render_pr_template',
    'Render a clean, human-engineered PR description adhering strictly to target repository template or Master 6-Tier standard',
    {
      nativeTemplateContent: z.string().optional().describe('Raw markdown of target repo .github/PULL_REQUEST_TEMPLATE.md from GitHub MCP'),
      issueNumber: z.union([z.string(), z.number()]).describe('Fixed issue number or task id'),
      issueTitle: z.string().describe('Title of the issue being solved'),
      summary: z.string().describe('Concise description of the fix root cause and solution'),
      validationCommand: z.string().describe('Command used to empirically verify the fix'),
      validationOutputSnippet: z.string().describe('Concise excerpt of test passing logs and stress loop result'),
      confidenceScore: z.number().optional().describe('Mathematical quality confidence score (e.g. 95)'),
      riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Assessed risk tier'),
      isDocumentationOnly: z.boolean().optional().describe('Whether changes are purely documentation/typo fix'),
      aiDisclosureRequired: z.boolean().optional().describe('Set true ONLY if repo CONTRIBUTING.md explicitly demands AI disclosure'),
    },
    async (args) => {
      const prBody = renderMasterPrTemplate({
        nativeTemplateContent: args.nativeTemplateContent,
        issueNumber: args.issueNumber,
        issueTitle: args.issueTitle,
        summary: args.summary,
        validationCommand: args.validationCommand,
        validationOutputSnippet: args.validationOutputSnippet,
        confidenceScore: args.confidenceScore ?? 95,
        riskLevel: args.riskLevel ?? 'LOW',
        isDocumentationOnly: args.isDocumentationOnly,
        aiDisclosureRequired: args.aiDisclosureRequired,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                prBody,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_sync_flywheel (本地经验记忆库与 Profile 飞轮同步)
  // -------------------------------------------------------------
  server.tool(
    'contrib_sync_flywheel',
    'Record contribution success/failure in local memory ledger and update GitHub Profile README markdown',
    {
      repoFullName: z.string().describe('Target repository full name (e.g. "bytedance/flowgram.ai")'),
      issueTitle: z.string().describe('Title of the issue worked on'),
      prUrl: z.string().optional().describe('URL of submitted pull request if created'),
      issueNumber: z.number().optional().describe('Target issue number'),
      prNumber: z.number().optional().describe('Created pull request number'),
      diffStat: z.string().optional().describe('Git diffstat string, e.g. "2 files changed, 14 insertions(+)"'),
      evidenceSummary: z.string().optional().describe('Summary of verification evidence'),
      failureReason: z.string().optional().describe('If contribution failed, the reason/pitfall encountered'),
      feedbackNotes: z.string().optional().describe('Maintainer or CI feedback notes to remember for this repo'),
    },
    async (args) => {
      memory.recordContribution({
        repoFullName: args.repoFullName,
        issueNumber: args.issueNumber,
        prNumber: args.prNumber,
        status: args.failureReason ? 'rejected' : 'merged',
        failureReason: args.failureReason,
        lessonsLearned: args.feedbackNotes ? [args.feedbackNotes] : undefined,
        provenance: {
          source: 'agent_claim',
          verified: false,
        },
      });

      const record: ContributionRecord = {
        id: `${args.repoFullName}#${args.prNumber || Date.now()}`,
        repoFullName: args.repoFullName,
        issueTitle: args.issueTitle,
        prUrl: args.prUrl,
        issueNumber: args.issueNumber,
        prNumber: args.prNumber,
        status: 'submitted',
        provenance: {
          source: 'agent_claim',
          verified: false,
        },
        submittedAt: new Date().toISOString(),
        diffStat: args.diffStat,
        evidenceSummary: args.evidenceSummary,
      };

      const result = flywheel.saveRecord(record);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                message: 'Flywheel synced and local memory ledger updated',
                profileSnippet: result.profileSnippet,
                totalContributions: result.allRecords.length,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_track_pr_status (PR 审查与 CI 状态全景监控)
  // -------------------------------------------------------------
  server.tool(
    'contrib_track_pr_status',
    'Track PR merge readiness, CI check runs, review feedback, and suggest next action (e.g. reply to maintainer, address CI failure)',
    {
      pr: z.object({
        number: z.number().describe('Pull request number'),
        state: z.enum(['open', 'closed']).describe('PR state'),
        merged: z.boolean().describe('Whether PR is merged'),
        mergeable: z.boolean().nullable().optional().describe('Whether PR can be cleanly merged'),
        mergeableState: z.string().optional().describe('Mergeable state (e.g. clean, dirty, blocked, behind)'),
        draft: z.boolean().optional().describe('Whether PR is draft'),
        headSha: z.string().describe('Head commit SHA of PR branch'),
      }),
      reviews: z
        .array(
          z.object({
            id: z.number(),
            user: z.object({ login: z.string() }),
            state: z.enum(['APPROVED', 'CHANGES_REQUESTED', 'COMMENTED', 'DISMISSED']),
            body: z.string().optional(),
            submittedAt: z.string().optional(),
          }),
        )
        .optional()
        .describe('Reviews list from GitHub MCP'),
      checkRuns: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
            status: z.enum(['queued', 'in_progress', 'completed']),
            conclusion: z.enum(['success', 'failure', 'neutral', 'cancelled', 'timed_out', 'action_required', 'skipped']).nullable(),
            detailsUrl: z.string().optional(),
          }),
        )
        .optional()
        .describe('Check runs / CI jobs list from GitHub MCP'),
      comments: z
        .array(
          z.object({
            id: z.number(),
            user: z.object({ login: z.string() }),
            body: z.string(),
            createdAt: z.string(),
          }),
        )
        .optional()
        .describe('Issue comments on PR from GitHub MCP'),
    },
    async (args) => {
      const { trackPrStatus } = await import('@opencontrib/core');

      const evaluation = trackPrStatus({
        pr: {
          number: args.pr.number,
          state: args.pr.state,
          merged: args.pr.merged,
          mergeable: args.pr.mergeable,
          mergeableState: args.pr.mergeableState,
          draft: args.pr.draft,
          headSha: args.pr.headSha,
        },
        reviews: (args.reviews ?? []).map((r) => ({
          id: r.id,
          user: r.user,
          state: r.state,
          body: r.body,
          submittedAt: r.submittedAt,
        })),
        checkRuns: (args.checkRuns ?? []).map((c) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          detailsUrl: c.detailsUrl,
        })),
        comments: (args.comments ?? []).map((c) => ({
          id: c.id,
          user: c.user,
          body: c.body,
          createdAt: c.createdAt,
        })),
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                evaluation,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );
}
