import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  analyzePatchImpactAndConsistency,
  auditGovernance,
  ConfidenceBreakdownSchema,
  parseCiRawLogs,
  ProfileFlywheel,
  renderMasterPrTemplate,
  RepoMemoryLedger,
  type ContributionRunManager,
} from "@opencontrib/core";

function wrapHandler(fn: (args: any) => Promise<any>) {
  return async (args: any) => {
    try {
      return await fn(args);
    } catch (err: any) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "error", message: err.message },
              null,
              2,
            ),
          },
        ],
      };
    }
  };
}

export function registerGovernanceTools(
  server: McpServer,
  _memory: RepoMemoryLedger,
  flywheel: ProfileFlywheel,
  runManager: ContributionRunManager,
): void {
  // -------------------------------------------------------------
  // Tool: contrib_audit_governance (多维质量红线与置信度审计)
  // -------------------------------------------------------------
  server.tool(
    "contrib_audit_governance",
    "Audit patch diff size, anti-AI text patterns, and compute evidence-backed 7D quality rubric & confidence breakdown",
    {
      runId: z
        .string()
        .optional()
        .describe(
          "Contribution run ID to perform canonical audit and advance to GOVERNANCE_AUDITED",
        ),
      patchContent: z
        .string()
        .optional()
        .describe(
          "Git unified diff string for diagnostic inspection (ignored when runId is provided)",
        ),
      prTitle: z.string().optional().describe("Proposed PR title"),
      prBody: z.string().optional().describe("Proposed PR body text"),
      evidence: z
        .object({
          stressLoopPassed: z.boolean().optional(),
          passedUnitTestsCount: z.number().optional(),
          failedUnitTestsCount: z.number().optional(),
          reproductionVerified: z.boolean().optional(),
          allTestsPassing: z.boolean().optional(),
          testCoveragePercent: z.number().optional(),
          handleLeakCheckPassed: z.boolean().optional(),
        })
        .passthrough()
        .optional()
        .describe(
          "Empirical evidence report (EvidenceReport) from contrib_collect_evidence",
        ),
      subagentQualityScore: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Optional empirical score from external subagent review"),
      isAutonomousPrSubmission: z
        .boolean()
        .optional()
        .describe(
          "Whether the caller is preparing for autonomous PR submission (demands empirical evidence)",
        ),
      confidenceBreakdown: ConfidenceBreakdownSchema.optional().describe(
        "Optional detailed 7-dimensional confidence scores",
      ),
    },
    wrapHandler(async (args) => {
      if (args.runId) {
        const { GovernanceService } = await import("@opencontrib/core");
        const govService = new GovernanceService(runManager);
        const decision = govService.audit(args.runId, {
          prTitle: args.prTitle,
          prBody: args.prBody,
          subagentScore: args.subagentQualityScore,
          isAutonomous: args.isAutonomousPrSubmission,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: decision.passed ? "passed" : "failed",
                  governanceDecision: decision,
                  audit: decision.auditResult,
                },
                null,
                2,
              ),
            },
          ],
        };
      }

      const audit = auditGovernance({
        patchContent: args.patchContent || "",
        prTitle: args.prTitle || "chore: opencontrib contribution",
        prBody: args.prBody,
        evidence: args.evidence,
        subagentQualityScore: args.subagentQualityScore,
        isAutonomousPrSubmission: args.isAutonomousPrSubmission,
        confidenceBreakdown: args.confidenceBreakdown,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: audit.overallConfidence.isPassed ? "passed" : "failed",
                audit,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_analyze_impact (360° 关联文件与跨平台防御扫描)
  // -------------------------------------------------------------
  server.tool(
    "contrib_analyze_impact",
    "Analyze patch for cross-platform anti-patterns (e.g. filepath.ToSlash on Linux, CRLF regex bugs) and identify overlooked sibling files",
    {
      modifiedFiles: z
        .array(z.string())
        .describe("List of files modified in the patch"),
      patchContent: z.string().describe("Git unified diff content"),
      repoContextFiles: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of existing repository file paths for sister file detection",
        ),
    },
    wrapHandler(async (args) => {
      const analysis = analyzePatchImpactAndConsistency({
        modifiedFiles: args.modifiedFiles,
        patchContent: args.patchContent,
        repoContextFiles: args.repoContextFiles,
      });

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: analysis.isCompliant ? "compliant" : "warnings_found",
                analysis,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_diagnose_ci (GitHub Actions CI 失败日志秒级提取与诊断)
  // -------------------------------------------------------------
  server.tool(
    "contrib_diagnose_ci",
    "Parse GitHub Actions or local CI terminal raw logs to extract exact failing test names, line numbers, and root-cause summaries without guessing",
    {
      rawLogText: z
        .string()
        .describe("Raw terminal output or GitHub Actions step log"),
      repoFullName: z
        .string()
        .optional()
        .describe('Target repository, e.g. "alibaba/open-code-review"'),
      pullNumber: z.number().optional().describe("Pull request number"),
    },
    wrapHandler(async (args) => {
      const report = parseCiRawLogs(args.rawLogText);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: report.hasFailure ? "failure_detected" : "healthy",
                report,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_render_pr_template (六厂融合/仓库原生 PR 描述渲染)
  // -------------------------------------------------------------
  server.tool(
    "contrib_render_pr_template",
    "Render a clean, human-engineered PR description adhering strictly to target repository template or Master 6-Tier standard",
    {
      nativeTemplateContent: z
        .string()
        .optional()
        .describe(
          "Raw markdown of target repo .github/PULL_REQUEST_TEMPLATE.md from GitHub MCP",
        ),
      issueNumber: z
        .union([z.string(), z.number()])
        .describe("Fixed issue number or task id"),
      issueTitle: z.string().describe("Title of the issue being solved"),
      summary: z
        .string()
        .describe("Concise description of the fix root cause and solution"),
      validationCommand: z
        .string()
        .optional()
        .describe(
          "Command used to empirically verify the fix (optional for docs/config PRs)",
        ),
      validationOutputSnippet: z
        .string()
        .optional()
        .describe(
          "Concise excerpt of test passing logs (optional for docs/config PRs)",
        ),
      confidenceScore: z
        .number()
        .optional()
        .describe("Mathematical quality confidence score (e.g. 95)"),
      riskLevel: z
        .enum(["LOW", "MEDIUM", "HIGH"])
        .optional()
        .describe("Assessed risk tier"),
      isDocumentationOnly: z
        .boolean()
        .optional()
        .describe("Whether changes are purely documentation/typo fix"),
      aiDisclosureRequired: z
        .boolean()
        .optional()
        .describe(
          "Set true ONLY if repo CONTRIBUTING.md explicitly demands AI disclosure",
        ),
      runId: z
        .string()
        .optional()
        .describe(
          "Contribution run ID to automatically persist pr_draft artifact",
        ),
    },
    wrapHandler(async (args) => {
      const prBody = renderMasterPrTemplate({
        nativeTemplateContent: args.nativeTemplateContent,
        issueNumber:
          typeof args.issueNumber === "string"
            ? parseInt(args.issueNumber, 10) || 1
            : args.issueNumber,
        issueTitle: args.issueTitle,
        summary: args.summary,
        validationCommand: args.validationCommand,
        validationOutputSnippet: args.validationOutputSnippet,
        confidenceScore: args.confidenceScore,
        riskLevel: args.riskLevel,
        isDocumentationOnly: args.isDocumentationOnly,
        aiDisclosureRequired: args.aiDisclosureRequired,
      });

      let savedArtifact = false;
      if (args.runId) {
        runManager.saveArtifact(args.runId, "pr_draft", prBody);
        savedArtifact = true;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                prBody,
                savedToRun: savedArtifact ? args.runId : undefined,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_render_issue_claim (Issue-First 认领声明与 Issue 模板生成)
  // -------------------------------------------------------------
  server.tool(
    "contrib_render_issue_claim",
    "Generate an authoritative Issue-First Claim statement or 0-day issue proposal with reproduction proof before submitting a PR",
    {
      issueNumber: z
        .union([z.string(), z.number()])
        .describe("GitHub issue number (or temporary id)"),
      issueTitle: z.string().describe("Title of the issue"),
      findingSummary: z
        .string()
        .optional()
        .describe("Summary of the identified defect and root cause file/line"),
      reproductionTestSnippet: z
        .string()
        .optional()
        .describe("Reproduction test case or verification snippet"),
    },
    wrapHandler(async (args) => {
      const { ClaimProtocol } = await import("@opencontrib/core");
      const num =
        typeof args.issueNumber === "string"
          ? parseInt(args.issueNumber, 10) || 0
          : args.issueNumber;
      const payload = ClaimProtocol.generateClaimPayload(num, args.issueTitle);

      if (args.findingSummary) {
        payload.findingSummary = args.findingSummary;
      }
      if (args.reproductionTestSnippet) {
        payload.claimComment += `\n\n\`\`\`\n${args.reproductionTestSnippet}\n\`\`\``;
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "success", payload }, null, 2),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_sync_flywheel (飞轮沉淀与经验提炼)
  // -------------------------------------------------------------
  server.tool(
    "contrib_sync_flywheel",
    "Persist completed or in-flight contribution memory, update developer skill weights, and refine repo-specific heuristics",
    {
      runId: z.string().describe("Canonical contribution run identifier"),
      repoFullName: z
        .string()
        .optional()
        .describe("Optional expected repository; must match the run manifest"),
    },
    wrapHandler(async (args) => {
      const run = runManager.getRun(args.runId);
      if (!run) throw new Error(`Unknown contribution run: ${args.runId}`);
      if (
        args.repoFullName &&
        args.repoFullName.toLowerCase() !==
          run.manifest.repoFullName.toLowerCase()
      ) {
        throw new Error(
          "FlywheelSyncError: repository does not match the run manifest.",
        );
      }
      const result = flywheel.syncFromRun(runManager, args.runId);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: "success", flywheelResult: result },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_track_pr_status (PR 状态与审查反馈追踪)
  // -------------------------------------------------------------
  server.tool(
    "contrib_track_pr_status",
    "Track PR merge readiness, CI check runs, review feedback, and suggest next action (e.g. reply to maintainer, address CI failure)",
    {
      pr: z.object({
        number: z.number().describe("Pull request number"),
        state: z.enum(["open", "closed"]).describe("PR state"),
        merged: z.boolean().describe("Whether PR is merged"),
        mergeable: z
          .boolean()
          .nullable()
          .optional()
          .describe("Whether PR can be cleanly merged"),
        mergeableState: z
          .string()
          .optional()
          .describe("Mergeable state (e.g. clean, dirty, blocked, behind)"),
        draft: z.boolean().optional().describe("Whether PR is draft"),
        headSha: z.string().describe("Head commit SHA of PR branch"),
      }),
      reviews: z
        .array(
          z.object({
            id: z.number(),
            user: z.object({ login: z.string() }),
            state: z.enum([
              "APPROVED",
              "CHANGES_REQUESTED",
              "COMMENTED",
              "DISMISSED",
            ]),
            body: z.string().optional(),
            submittedAt: z.string().optional(),
          }),
        )
        .optional()
        .describe("Reviews list from GitHub MCP"),
      checkRuns: z
        .array(
          z.object({
            id: z.number(),
            name: z.string(),
            status: z.enum(["queued", "in_progress", "completed"]),
            conclusion: z
              .enum([
                "success",
                "failure",
                "neutral",
                "cancelled",
                "timed_out",
                "action_required",
                "skipped",
              ])
              .nullable(),
            detailsUrl: z.string().optional(),
          }),
        )
        .optional()
        .describe("Check runs / CI jobs list from GitHub MCP"),
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
        .describe("Issue comments on PR from GitHub MCP"),
    },
    wrapHandler(async (args) => {
      const { trackPrStatus } = await import("@opencontrib/core");

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
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: "success", evaluation }, null, 2),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_request_approval (发起人工审查挑战挑战书，Agent 不得自批)
  // -------------------------------------------------------------
  server.tool(
    "contrib_request_approval",
    "Request human approval challenge binding immutable SubmissionIntentSha256. Agent cannot mint approval directly.",
    {
      runId: z.string().describe("Contribution run ID"),
      upstreamOwner: z.string().describe("Target upstream repository owner"),
      upstreamRepo: z.string().describe("Target upstream repository name"),
      title: z.string().optional().describe("Proposed PR title"),
      body: z.string().optional().describe("Proposed PR body"),
      branchName: z.string().optional().describe("Proposed branch name"),
      commitMessage: z.string().optional().describe("Proposed commit message"),
      isDraft: z.boolean().optional().describe("Whether PR will be draft"),
    },
    wrapHandler(async (args) => {
      const { SubmissionIntentService } = await import("@opencontrib/core");
      const intentService = new SubmissionIntentService(runManager);

      const intent = intentService.createIntent({
        runId: args.runId,
        upstreamOwner: args.upstreamOwner,
        upstreamRepo: args.upstreamRepo,
        title: args.title,
        body: args.body,
        branchName: args.branchName,
        commitMessage: args.commitMessage,
        isDraft: args.isDraft,
      });
      const { ApprovalService } = await import("@opencontrib/core");
      const challenge = new ApprovalService(runManager).requestApproval(
        args.runId,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "CHALLENGE_ISSUED",
                message:
                  "SubmissionIntent created. Awaiting explicit human or trusted authority approval.",
                intentSha256: intent.intentSha256,
                runId: args.runId,
                targetRepo: `${intent.upstreamOwner}/${intent.upstreamRepo}`,
                branch: intent.branchName,
                filesCount: intent.files.length,
                challenge,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_submit_pr (受信任的 PR 授权与真实提交)
  // -------------------------------------------------------------
  server.tool(
    "contrib_submit_pr",
    "Authorize and submit PR via GitHubSubmissionService, verifying provider head SHA and advancing to PR_SUBMITTED",
    {
      runId: z.string().describe("Contribution run ID"),
      expectedIntentSha256: z
        .string()
        .optional()
        .describe(
          "Optional expected intent SHA256 to guard against concurrent mutations",
        ),
    },
    wrapHandler(async (args) => {
      // MCP is agent-facing: it has no GitHub credential and cannot invoke a
      // provider write. The separately deployed trusted broker owns approval,
      // credentials, and canonical submission state.
      const { RemoteSubmissionBrokerClient } = await import("@opencontrib/core");

      // Guard against concurrent mutations if expectedIntentSha256 is supplied
      if (args.expectedIntentSha256) {
        const run = runManager.getRun(args.runId);
        const intentSha = (run?.artifacts?.submissionIntent as any)
          ?.intentSha256;
        if (intentSha && intentSha !== args.expectedIntentSha256) {
          throw new Error(
            `SubmissionIntentMismatchError: expected intent SHA "${args.expectedIntentSha256}" does not match recorded intent SHA "${intentSha}".`,
          );
        }
      }

      // Submit only through the separately deployed trusted broker.
      const submissionArtifact = await new RemoteSubmissionBrokerClient().submit(
        args.runId,
        args.expectedIntentSha256,
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: "success",
                submissionArtifact,
              },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool: contrib_lint_markdown (5层工业级 Markdown 静态完整性校验)
  // -------------------------------------------------------------
  server.tool(
    "contrib_lint_markdown",
    "Run 5-layer industrial static validation on Markdown text to prevent mojibake, unclosed tags, corrupted links, or broken codeblocks before creating issues/PRs",
    {
      markdownContent: z.string().describe("Markdown text content to validate"),
    },
    wrapHandler(async (args) => {
      const { validateMarkdownIntegrity } = await import("@opencontrib/core");
      const report = validateMarkdownIntegrity(args.markdownContent);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { status: report.isValid ? "passed" : "failed", report },
              null,
              2,
            ),
          },
        ],
      };
    }),
  );
}
