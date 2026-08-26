import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  analyzePatchImpactAndConsistency,
  auditGovernance,
  ConfidenceBreakdownSchema,
  parseCiRawLogs,
  ProfileFlywheel,
  renderMasterPrTemplate,
  RepoMemoryLedger,
} from '@opencontrib/core';

function wrapHandler(fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (err: any) {
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }, null, 2) }],
      };
    }
  };
}

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
    wrapHandler(async (args) => {
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
        content: [{
          type: 'text',
          text: JSON.stringify(
            { status: audit.overallConfidence.isPassed ? 'passed' : 'failed', audit },
            null,
            2,
          ),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_analyze_impact (360° 关联文件与跨平台防御扫描)
  // -------------------------------------------------------------
  server.tool(
    'contrib_analyze_impact',
    'Analyze patch for cross-platform anti-patterns (e.g. filepath.ToSlash on Linux, CRLF regex bugs) and identify overlooked sibling files',
    {
      modifiedFiles: z.array(z.string()).describe('List of files modified in the patch'),
      patchContent: z.string().describe('Git unified diff content'),
      repoContextFiles: z.array(z.string()).optional().describe('Optional list of existing repository file paths for sister file detection'),
    },
    wrapHandler(async (args) => {
      const analysis = analyzePatchImpactAndConsistency({
        modifiedFiles: args.modifiedFiles,
        patchContent: args.patchContent,
        repoContextFiles: args.repoContextFiles,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            { status: analysis.isCompliant ? 'compliant' : 'warnings_found', analysis },
            null,
            2,
          ),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_diagnose_ci (GitHub Actions CI 失败日志秒级提取与诊断)
  // -------------------------------------------------------------
  server.tool(
    'contrib_diagnose_ci',
    'Parse GitHub Actions or local CI terminal raw logs to extract exact failing test names, line numbers, and root-cause summaries without guessing',
    {
      rawLogText: z.string().describe('Raw terminal output or GitHub Actions step log'),
      repoFullName: z.string().optional().describe('Target repository, e.g. "alibaba/open-code-review"'),
      pullNumber: z.number().optional().describe('Pull request number'),
    },
    wrapHandler(async (args) => {
      const report = parseCiRawLogs(args.rawLogText);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            { status: report.hasFailure ? 'failure_detected' : 'healthy', report },
            null,
            2,
          ),
        }],
      };
    }),
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
      validationCommand: z.string().optional().describe('Command used to empirically verify the fix (optional for docs/config PRs)'),
      validationOutputSnippet: z.string().optional().describe('Concise excerpt of test passing logs (optional for docs/config PRs)'),
      confidenceScore: z.number().optional().describe('Mathematical quality confidence score (e.g. 95)'),
      riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH']).optional().describe('Assessed risk tier'),
      isDocumentationOnly: z.boolean().optional().describe('Whether changes are purely documentation/typo fix'),
      aiDisclosureRequired: z.boolean().optional().describe('Set true ONLY if repo CONTRIBUTING.md explicitly demands AI disclosure'),
    },
    wrapHandler(async (args) => {
      const prBody = renderMasterPrTemplate({
        nativeTemplateContent: args.nativeTemplateContent,
        issueNumber: typeof args.issueNumber === 'string' ? parseInt(args.issueNumber, 10) || 1 : args.issueNumber,
        issueTitle: args.issueTitle,
        summary: args.summary,
        validationCommand: args.validationCommand || 'bun test',
        validationOutputSnippet: args.validationOutputSnippet || 'All unit tests pass cleanly.',
        confidenceScore: args.confidenceScore,
        riskLevel: args.riskLevel,
        isDocumentationOnly: args.isDocumentationOnly,
        aiDisclosureRequired: args.aiDisclosureRequired,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', prBody }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_render_issue_claim (Issue-First 认领声明与 Issue 模板生成)
  // -------------------------------------------------------------
  server.tool(
    'contrib_render_issue_claim',
    'Generate an authoritative Issue-First Claim statement or 0-day issue proposal with reproduction proof before submitting a PR',
    {
      issueNumber: z.union([z.string(), z.number()]).describe('GitHub issue number (or temporary id)'),
      issueTitle: z.string().describe('Title of the issue'),
      findingSummary: z.string().optional().describe('Summary of the identified defect and root cause file/line'),
      reproductionTestSnippet: z.string().optional().describe('Reproduction test case or verification snippet'),
    },
    wrapHandler(async (args) => {
      const { ClaimProtocol } = await import('@opencontrib/core');
      const num = typeof args.issueNumber === 'string' ? parseInt(args.issueNumber, 10) || 0 : args.issueNumber;
      const payload = ClaimProtocol.generateClaimPayload(num, args.issueTitle);

      if (args.findingSummary) {
        payload.findingSummary = args.findingSummary;
      }
      if (args.reproductionTestSnippet) {
        payload.claimComment += `\n\n\`\`\`\n${args.reproductionTestSnippet}\n\`\`\``;
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', payload }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_sync_flywheel (飞轮沉淀与经验提炼)
  // -------------------------------------------------------------
  server.tool(
    'contrib_sync_flywheel',
    'Persist completed or in-flight contribution memory, update developer skill weights, and refine repo-specific heuristics',
    {
      repoFullName: z.string().describe('Target repository, e.g. "owner/repo"'),
      record: z.object({
        runId: z.string().describe('Unique contribution run identifier'),
        issueNumber: z.number().optional().describe('GitHub issue number'),
        prNumber: z.number().optional().describe('GitHub PR number if created'),
        status: z.enum(['merged', 'open', 'closed', 'rejected', 'in_progress']).describe('Contribution state'),
        techStack: z.array(z.string()).describe('Tech stack tags (e.g. ["typescript", "react"])'),
        qualityRubricScore: z.number().min(0).max(100).describe('Evidence-backed confidence rubric score'),
        maintainerFeedback: z.string().optional().describe('Maintainer review comments or bot feedback'),
        failureLessons: z.string().optional().describe('Key insights or failure root causes learned during this run'),
      }),
    },
    wrapHandler(async (args) => {
      const result = flywheel.recordContribution(args.repoFullName, {
        runId: args.record.runId,
        repoFullName: args.repoFullName,
        issueNumber: args.record.issueNumber,
        prNumber: args.record.prNumber,
        status: args.record.status === 'merged' ? 'merged' : 'submitted',
        techStack: args.record.techStack,
        qualityRubricScore: args.record.qualityRubricScore,
        maintainerFeedback: args.record.maintainerFeedback,
        failureLessons: args.record.failureLessons,
        timestamp: new Date().toISOString(),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', flywheelResult: result }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_track_pr_status (PR 状态与审查反馈追踪)
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
    wrapHandler(async (args) => {
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
        reviews: (args.reviews ?? []).map((r: any) => ({
          id: r.id,
          user: r.user,
          state: r.state,
          body: r.body,
          submittedAt: r.submittedAt,
        })),
        checkRuns: (args.checkRuns ?? []).map((c: any) => ({
          id: c.id,
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
          detailsUrl: c.detailsUrl,
        })),
        comments: (args.comments ?? []).map((c: any) => ({
          id: c.id,
          user: c.user,
          body: c.body,
          createdAt: c.createdAt,
        })),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', evaluation }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_lint_markdown (5层工业级 Markdown 静态完整性校验)
  // -------------------------------------------------------------
  server.tool(
    'contrib_lint_markdown',
    'Run 5-layer industrial static validation on Markdown text to prevent mojibake, unclosed tags, corrupted links, or broken codeblocks before creating issues/PRs',
    {
      markdownContent: z.string().describe('Markdown text content to validate'),
    },
    wrapHandler(async (args) => {
      const { validateMarkdownIntegrity } = await import('@opencontrib/core');
      const report = validateMarkdownIntegrity(args.markdownContent);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: report.isValid ? 'passed' : 'failed', report }, null, 2),
        }],
      };
    }),
  );
}
