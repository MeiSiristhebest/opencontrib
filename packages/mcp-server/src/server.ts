import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  assessFeasibility,
  auditGovernance,
  capturePreFixAssertion,
  collectEvidence,
  ConfidenceBreakdownSchema,
  ContributionRunManager,
  detectSystemCapabilities,
  ProfileFlywheel,
  qualifyIssue,
  rankOpportunitySignals,
  renderMasterPrTemplate,
  RepoMemoryLedger,
  runDoctorAudit,
  scoutOpportunities,
  verifyDualStageReproduction,
  WorktreeManager,
} from '@opencontrib/core';



export function createOpenContribMcpServer(): McpServer {
  const server = new McpServer({
    name: 'opencontrib-engine',
    version: '1.0.0',
  });

  const memory = new RepoMemoryLedger();
  const flywheel = new ProfileFlywheel();
  const worktreeManager = new WorktreeManager();

  // -------------------------------------------------------------
  // Tool 1: contrib_assess_feasibility (纯算法：环境可行性矩阵)
  // -------------------------------------------------------------
  server.tool(
    'contrib_assess_feasibility',
    'Assess OS and toolchain execution feasibility for an issue against local machine (Windows/WSL/Docker/Mac)',
    {
      issueTitle: z.string().describe('Title of the issue'),
      issueBody: z.string().describe('Body of the issue'),
      labels: z.array(z.string()).describe('List of issue label names'),
    },
    async (args) => {
      const capabilities = detectSystemCapabilities();
      const assessment = assessFeasibility(args.issueTitle, args.issueBody, args.labels, capabilities);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                assessment,
                localCapabilities: {
                  os: capabilities.os,
                  hasWsl: capabilities.hasWsl,
                  hasDocker: capabilities.hasDocker,
                },
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
  // Tool 2: contrib_qualify_issue (纯门禁：作者优先权与反跟风检查)
  // -------------------------------------------------------------
  server.tool(
    'contrib_qualify_issue',
    'Check 7-day author-first-right, anti-bandwagoning, and blocking labels using issue & comments data from GitHub MCP',
    {
      issueNumber: z.number().describe('GitHub issue number'),
      issueTitle: z.string().describe('Title of the issue'),
      issueBody: z.string().describe('Body text of the issue'),
      labels: z.array(z.string()).describe('Labels of the issue'),
      isOpen: z.boolean().describe('Whether state is open'),
      assignees: z.array(z.string()).describe('List of assigned usernames'),
      createdAt: z.string().describe('ISO timestamp of issue creation date'),
      comments: z
        .array(
          z.object({
            id: z.number(),
            body: z.string().optional(),
            user: z.object({ login: z.string().optional() }).nullish(),
            created_at: z.string(),
          }),
        )
        .describe('List of issue comments fetched via GitHub MCP get_issue_comments'),
    },
    async (args) => {
      const qualification = qualifyIssue({
        issueNumber: args.issueNumber,
        issueTitle: args.issueTitle,
        issueBody: args.issueBody,
        labels: args.labels,
        isOpen: args.isOpen,
        assignees: args.assignees,
        createdAt: args.createdAt,
        comments: args.comments,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: qualification.isQualified ? 'qualified' : 'disqualified',
                qualification,
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
  // Tool 3: contrib_diagnose_manifests (纯诊断：<=100行主动探针建议)
  // -------------------------------------------------------------
  server.tool(
    'contrib_diagnose_manifests',
    'Diagnose repo workflows, package.json, pyproject.toml, and Cargo.toml for <=100 line PR improvement suggestions',
    {
      workflows: z.array(z.object({ path: z.string(), content: z.string() })).describe('List of workflow files and contents from GitHub MCP'),
      readmeContent: z.string().optional().describe('Content of README.md from GitHub MCP'),
      packageJsonContent: z.string().optional().describe('Content of package.json from GitHub MCP'),
      pyprojectContent: z.string().optional().describe('Content of pyproject.toml from GitHub MCP'),
      cargoContent: z.string().optional().describe('Content of Cargo.toml from GitHub MCP'),
      gitignoreContent: z.string().optional().describe('Content of .gitignore from GitHub MCP'),
      dependabotContent: z.string().optional().describe('Content of .github/dependabot.yml from GitHub MCP'),
    },
    async (args) => {
      const suggestions: any[] = [];

      // Scan Workflows
      for (const wf of args.workflows) {
        if (wf.content.includes('actions/checkout@v2') || wf.content.includes('actions/checkout@v3')) {
          suggestions.push({
            id: `ci-upgrade-checkout-${wf.path.replace(/[^a-zA-Z0-9]/g, '_')}`,
            title: `Upgrade deprecated actions/checkout to v4 in ${wf.path}`,
            category: 'ci_workflow',
            summary: 'Repository uses deprecated actions/checkout version in CI workflows.',
            rationale: 'Upgrading to v4 ensures compatibility with modern GitHub Actions runners and improves security.',
            targetFiles: [{ path: wf.path, reason: 'Target CI workflow file' }],
            proposedChanges: ['Replace actions/checkout@v2 or @v3 with actions/checkout@v4'],
            estimatedDiffLines: 6,
            prPotentialScore: 92,
          });
        }
      }

      // Scan Python
      if (args.pyprojectContent && !args.pyprojectContent.includes('[tool.ruff]')) {
        suggestions.push({
          id: 'python-add-modern-linter',
          title: 'Configure Ruff linter in pyproject.toml',
          category: 'code_hygiene',
          summary: 'Python project is missing modern unified linter/formatter configurations.',
          rationale: 'Ruff provides 10-100x faster linting for open source contributors.',
          targetFiles: [{ path: 'pyproject.toml', reason: 'Python project manifest' }],
          proposedChanges: ['Add standard [tool.ruff] configuration with target-version and line-length'],
          estimatedDiffLines: 12,
          prPotentialScore: 85,
        });
      }

      // Scan Dependabot
      if (!args.dependabotContent) {
        suggestions.push({
          id: 'security-enable-dependabot',
          title: 'Add automated Dependabot config for GitHub Actions & packages',
          category: 'security',
          summary: 'Repository is missing automated weekly dependency security maintenance.',
          rationale: 'Dependabot ensures GitHub Actions and project dependencies stay up-to-date.',
          targetFiles: [{ path: '.github/dependabot.yml', reason: 'Security maintenance workflow' }],
          proposedChanges: ['Add standard .github/dependabot.yml with weekly interval'],
          estimatedDiffLines: 14,
          prPotentialScore: 91,
        });
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                suggestionsCount: suggestions.length,
                suggestions: suggestions.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
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
  // Tool 4: contrib_prepare_workspace (本地沙箱：Git Worktree)
  // -------------------------------------------------------------
  server.tool(
    'contrib_prepare_workspace',
    'Create an isolated Git worktree under ~/.opencontrib/workspaces to develop a fix without touching main workspace',
    {
      repoFullName: z.string().describe('Target repository, e.g. "microsoft/vscode"'),
      issueOrTaskId: z.union([z.string(), z.number()]).describe('Issue number or task identifier'),
      localRepoPath: z.string().optional().describe('Optional local path of existing repo to create worktree from'),
      runId: z.string().optional().describe('Optional runId to automatically save workspace.json artifact and advance phase'),
    },
    async (args) => {
      const context = worktreeManager.createIsolatedWorkspace({
        repoFullName: args.repoFullName,
        issueOrTaskId: args.issueOrTaskId,
        localRepoPath: args.localRepoPath,
        runId: args.runId,
      });

      let persistence: { saved: boolean; error?: string } = { saved: false };
      if (args.runId) {
        try {
          runManager.saveArtifact(
            args.runId,
            'workspace',
            {
              workspacePath: context.workspacePath,
              branchName: context.branchName,
              isWorktree: context.isWorktree,
              repoFullName: args.repoFullName,
            },
            'WORKSPACE_PREPARED',
          );
          persistence = { saved: true };
        } catch (err: any) {
          persistence = { saved: false, error: err.message };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: persistence.error ? 'PARTIAL_SUCCESS' : 'success',
                workspacePath: context.workspacePath,
                branchName: context.branchName,
                isWorktree: context.isWorktree,
                persistence: args.runId ? persistence : undefined,
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
  // Tool 5: contrib_collect_evidence (双阶段物证：Pre-Fix 失败断言 + Post-Fix 压测)
  // -------------------------------------------------------------
  server.tool(
    'contrib_collect_evidence',
    'Execute dual-stage empirical verification (capturing pre-fix failing baseline assertion and post-fix stress loop pass)',
    {
      cwd: z.string().describe('Workspace directory to execute test command in'),
      workspaceRoot: z.string().optional().describe('Optional root workspace directory to enforce security boundary (auto-resolved from runId if omitted)'),
      testCommand: z.string().describe('Exact test command, e.g. "npm test" or "pytest"'),
      preFixAssertionProbe: z
        .string()
        .optional()
        .describe('Expected failure assertion regex or snippet observed before fix (for dual-stage verification)'),
      preFixTestCommand: z
        .string()
        .optional()
        .describe('Optional separate reproduction script/command to trigger pre-fix failure baseline'),
      stressLoopCount: z.number().optional().describe('Number of stress loop iterations (default 20)'),
      runId: z.string().optional().describe('Optional runId to automatically resolve workspaceRoot and save evidence.json artifact'),
    },
    async (args) => {
      let resolvedWorkspaceRoot = args.workspaceRoot;

      // Auto-resolve workspaceRoot from runId if not explicitly provided
      if (!resolvedWorkspaceRoot && args.runId) {
        try {
          const run = runManager.getRun(args.runId);
          if (run?.artifacts?.workspace?.workspacePath) {
            resolvedWorkspaceRoot = String(run.artifacts.workspace.workspacePath);
          }
        } catch {}
      }

      let dualStageResult: any = undefined;

      // 1. Dual-stage verification if preFixAssertionProbe is provided
      if (args.preFixAssertionProbe) {
        const preFixCheck = capturePreFixAssertion(
          args.cwd,
          args.preFixTestCommand || args.testCommand,
          resolvedWorkspaceRoot,
        );
        dualStageResult = await verifyDualStageReproduction({
          cwd: args.cwd,
          workspaceRoot: resolvedWorkspaceRoot,
          testCommand: args.testCommand,
          preFixBaselineCaptured: preFixCheck.assertionCaptured,
          preFixFailureOutput: preFixCheck.baselineOutput,
          stressLoopCount: args.stressLoopCount ?? 5,
        });
      }

      // 2. Comprehensive evidence metrics collection (flaky test baseline + handle leak check)
      const evidence = await collectEvidence({
        cwd: args.cwd,
        workspaceRoot: resolvedWorkspaceRoot,
        testCommand: args.testCommand,
        stressLoopCount: args.stressLoopCount ?? 20,
      });

      const fullEvidenceReport = {
        ...evidence,
        dualStage: dualStageResult,
      };

      let persistence: { saved: boolean; error?: string } = { saved: false };
      if (args.runId) {
        try {
          runManager.saveArtifact(
            args.runId,
            'evidence',
            fullEvidenceReport,
            'EVIDENCE_COLLECTED',
          );
          persistence = { saved: true };
        } catch (err: any) {
          persistence = { saved: false, error: err.message };
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: persistence.error ? 'PARTIAL_SUCCESS' : 'success',
                evidence: fullEvidenceReport,
                persistence: args.runId ? persistence : undefined,
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
  // Tool 6: contrib_audit_governance (治理门禁：去AI化/100行/7D置信度)
  // -------------------------------------------------------------
  server.tool(
    'contrib_audit_governance',
    'Perform Anti-AI phrase linting, RFC 100-line diff gate checking, and 7-dimension confidence math calculation',
    {
      diffText: z.string().describe('Full unified git diff of proposed changes'),
      prBodyText: z.string().describe('Proposed PR body text'),
      diffLineCount: z.number().describe('Total number of modified/added lines in diff'),
      confidence: ConfidenceBreakdownSchema,
      humanApproved: z.boolean().optional().describe('Whether the human user has previewed and explicitly approved the PR draft'),
    },
    async (args) => {
      const audit = auditGovernance({
        diffText: args.diffText,
        prBodyText: args.prBodyText,
        confidenceBreakdown: args.confidence,
        lineCount: args.diffLineCount,
        humanApproved: args.humanApproved ?? false,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: audit.isGatedPassed ? 'approved' : 'rejected',
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
  // Tool 7: contrib_render_pr_template (支持目标仓库原生模板融合或 Master 模板保底)
  // -------------------------------------------------------------
  server.tool(
    'contrib_render_pr_template',
    'Render PR description markdown (merging into target repo native template if provided, or using master template)',
    {
      issueNumber: z.number().describe('Issue number'),
      problemSummary: z.string().describe('What problem this PR solves'),
      rootCause: z.string().describe('Technical explanation of root cause'),
      keyChanges: z.array(z.string()).describe('List of key changes'),
      reproductionCommand: z.string().describe('Command to reproduce bug baseline'),
      verificationCommand: z.string().describe('Command to verify fix passes'),
      testCount: z.number().describe('Total passing tests count'),
      stressLoopCount: z.number().optional().describe('Stress loop iteration count'),
      dcoAuthorName: z.string().optional().describe('Author name for DCO Signed-off-by trailer if repo mandates it'),
      dcoAuthorEmail: z.string().optional().describe('Author email for DCO Signed-off-by trailer if repo mandates it'),
      conditionalAiRequired: z.boolean().optional().describe('Whether target repo mandates AI disclosure'),
      nativeTemplateContent: z.string().optional().describe('Optional raw content of target repo .github/PULL_REQUEST_TEMPLATE.md'),
    },
    async (args) => {
      const { buildPrDescription } = await import('@opencontrib/core');
      const markdown = buildPrDescription(
        {
          issueNumber: args.issueNumber,
          problemSummary: args.problemSummary,
          rootCause: args.rootCause,
          keyChanges: args.keyChanges,
          reproductionCommand: args.reproductionCommand,
          verificationCommand: args.verificationCommand,
          testCount: args.testCount,
          stressLoopCount: args.stressLoopCount,
          dcoAuthorName: args.dcoAuthorName,
          dcoAuthorEmail: args.dcoAuthorEmail,
          conditionalAiRequired: args.conditionalAiRequired,
        },
        args.nativeTemplateContent,
      );

      return {
        content: [
          {
            type: 'text',
            text: markdown,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------
  // Tool 8: contrib_sync_flywheel (飞轮同步与主页资产生成)
  // -------------------------------------------------------------
  server.tool(
    'contrib_sync_flywheel',
    'Record completed contribution to local memory ledger and render profile markdown & SVG badges',
    {
      repoFullName: z.string().describe('Repository full name (e.g. bytedance/flowgram.ai)'),
      issueTitle: z.string().describe('Title of the issue or feature'),
      prUrl: z.string().describe('URL of the opened pull request'),
      issueNumber: z.number().optional().describe('Issue number if available'),
      prNumber: z.number().optional().describe('PR number if available'),
      diffStat: z.string().optional().describe('Diff stats (e.g. +14 -2)'),
      evidenceSummary: z.string().optional().describe('Summary of verification evidence'),
    },
    async (args) => {
      const flywheel = new ProfileFlywheel();
      const memory = new RepoMemoryLedger();

      memory.recordSubmission(args.repoFullName, {
        title: args.issueTitle,
        prUrl: args.prUrl,
        issueNumber: args.issueNumber,
        prNumber: args.prNumber,
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
  // Tool 9: contrib_purge_sandbox (沙箱与临时测试工作区一键清理)
  // -------------------------------------------------------------
  server.tool(
    'contrib_purge_sandbox',
    'Purge all ephemeral git worktrees, temporary scratch test scripts, and cached bare repos',
    {
      cleanRepos: z.boolean().optional().describe('Whether to also delete bare repo cache (~/.opencontrib/repos)'),
      cleanScratchDir: z.string().optional().describe('Optional path to local scratch directory to clean'),
    },
    async (args) => {
      const { WorktreeManager } = await import('@opencontrib/core');
      const manager = new WorktreeManager();
      const report = manager.purgeAllWorkspaces({
        cleanRepos: args.cleanRepos ?? false,
        cleanScratchDir: args.cleanScratchDir,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                message: 'Sandbox cleanup completed',
                report,
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
  // Tool 10: contrib_doctor (宿主机环境健康与依赖诊断)
  // -------------------------------------------------------------
  server.tool(
    'contrib_doctor',
    'Audit host environment health (Git, Bun/Node, Docker, WSL, and OpenContrib storage)',
    {},
    async () => {
      const { runDoctorAudit } = await import('@opencontrib/core');
      const report = runDoctorAudit();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                report,
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
  // Tool 11: contrib_track_pr_status (Phase 7: PR 生命周期与维护者互动)
  // -------------------------------------------------------------
  server.tool(
    'contrib_track_pr_status',
    'Analyze submitted PR CI checks, review status, and generate maintainer response templates',
    {
      prNumber: z.number().describe('Pull Request number'),
      isOpen: z.boolean().describe('Whether PR is currently open'),
      isMerged: z.boolean().describe('Whether PR has been merged'),
      checkRuns: z
        .array(
          z.object({
            name: z.string(),
            status: z.string(),
            conclusion: z.string().nullable(),
          }),
        )
        .optional()
        .describe('GitHub check runs status array'),
      reviews: z
        .array(
          z.object({
            state: z.string(),
            author: z.string(),
            body: z.string().optional(),
          }),
        )
        .optional()
        .describe('GitHub PR reviews array'),
      commentsCount: z.number().optional().describe('Total review comments count'),
    },
    async (args) => {
      const { analyzePrLifecycle } = await import('@opencontrib/core');
      const status = analyzePrLifecycle(args);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                lifecycle: status,
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
  // Tool 12: contrib_assemble_context (上下文装配器: Issue + Repo + Memory + Environment)
  // -------------------------------------------------------------
  server.tool(
    'contrib_assemble_context',
    'Assemble complete multi-dimensional context (problem context, repository skeletons, cognitive memory pitfalls, and host environment)',
    {
      repoFullName: z.string().describe('Target repository full name (e.g. bytedance/flowgram.ai)'),
      issueTitle: z.string().describe('Title of the issue'),
      issueBody: z.string().describe('Body description of the issue'),
      issueNumber: z.number().optional().describe('Issue number if available'),
      packageManifest: z.string().optional().describe('Optional package.json / Cargo.toml / go.mod content snippet'),
      ciWorkflow: z.string().optional().describe('Optional CI workflow yaml snippet'),
      primaryLanguage: z.string().optional().describe('Primary language of repository'),
    },
    async (args) => {
      const { ContextAssembler } = await import('@opencontrib/core');
      const assembler = new ContextAssembler();
      const assembled = assembler.assemble(args);
      const prompt = assembler.formatContextPrompt(assembled);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                assembled,
                formattedPrompt: prompt,
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
  // Tool 13: contrib_rank_opportunity (多维概率与客观信号提取)
  // -------------------------------------------------------------
  server.tool(

    'contrib_rank_opportunity',
    'Extract deterministic multi-dimensional objective signals (skill match, environment feasibility, actionability, maintenance risk) without prescribing decisions',
    {
      issue: z.object({
        number: z.number().optional(),
        title: z.string(),
        body: z.string().optional(),
        labels: z.array(z.string()).optional(),
        state: z.string().optional(),
        createdAt: z.string().optional(),
      }),
      repository: z.object({
        fullName: z.string(),
        stars: z.number().optional(),
        primaryLanguage: z.string().optional(),
      }),
      developerProfile: z
        .object({
          techStack: z.array(z.string()).optional(),
          focusAreas: z.array(z.string()).optional(),
          proficiency: z.enum(['beginner', 'intermediate', 'expert', 'advanced']).optional(),
        })
        .optional(),
      environment: z
        .object({
          os: z.enum(['windows', 'linux', 'macos', 'wsl2']).optional(),
          hasDocker: z.boolean().optional(),
          hasWsl: z.boolean().optional(),
        })
        .optional(),
    },
    async (args) => {
      try {
        const signals = rankOpportunitySignals({
          issue: args.issue,
          repository: args.repository,
          developerProfile: args.developerProfile,
          environment: args.environment,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  signals,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Ranking error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool 14: contrib_create_run (贡献 Run 实体创建与持久化会话初始化)
  // -------------------------------------------------------------
  const runManager = new ContributionRunManager();

  server.tool(
    'contrib_create_run',
    'Create an auditable contribution run session with discrete artifact storage under ~/.opencontrib/runs/<run_id>',
    {
      repoFullName: z.string().describe('Target repository, e.g. "bytedance/flowgram.ai"'),
      issueNumber: z.number().optional().describe('Target issue number'),
      issueTitle: z.string().optional().describe('Target issue title'),
      tags: z.array(z.string()).optional().describe('Optional categorization tags'),
      metadata: z.record(z.unknown()).optional().describe('Arbitrary run metadata'),
    },
    async (args) => {
      try {
        const manifest = runManager.createRun(args);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  manifest,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Security error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool 15: contrib_save_artifact (阶段性物证快照落盘)
  // -------------------------------------------------------------
  server.tool(
    'contrib_save_artifact',
    'Save discrete stage artifact (opportunity, context, workspace, patch, evidence, governance, pr_draft, result) to run bundle',
    {
      runId: z.string().describe('Unique contribution run ID'),
      artifactType: z.enum([
        'opportunity',
        'context',
        'workspace',
        'patch',
        'evidence',
        'governance',
        'pr_draft',
        'result',
      ]),
      content: z.union([z.string(), z.record(z.unknown())]).describe('Artifact payload or raw markdown/diff string'),
      autoAdvancePhase: z
        .enum([
          'INITIALIZED',
          'OPPORTUNITY_SCOUTED',
          'CONTEXT_ASSEMBLED',
          'WORKSPACE_PREPARED',
          'PATCH_DRAFTED',
          'EVIDENCE_COLLECTED',
          'GOVERNANCE_AUDITED',
          'PR_SUBMITTED',
          'COMPLETED',
          'FAILED',
        ])
        .optional()
        .describe('Optional phase to advance run manifest to'),
    },
    async (args) => {
      try {
        const saved = runManager.saveArtifact(
          args.runId,
          args.artifactType,
          args.content,
          args.autoAdvancePhase,
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  saved,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Security error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool 16: contrib_get_run (查询指定 Run 的完整状态与物证清单)
  // -------------------------------------------------------------
  server.tool(
    'contrib_get_run',
    'Retrieve full manifest and all saved artifacts of a contribution run',
    {
      runId: z.string().describe('Unique contribution run ID'),
    },
    async (args) => {
      try {
        const run = runManager.getRun(args.runId);
        if (!run) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Contribution run "${args.runId}" not found.` }],
          };
        }

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  run,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Security error: ${err.message}` }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool 17: contrib_resume_run (断点恢复贡献会话)
  // -------------------------------------------------------------
  server.tool(
    'contrib_resume_run',
    'Resume an interrupted contribution run by loading its latest phase, existing artifacts, and suggested next action',
    {
      runId: z.string().describe('Unique contribution run ID to resume'),
    },
    async (args) => {
      try {
        const resume = runManager.resumeRun(args.runId);

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  resume,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Resume error: ${err.message}` }],
        };
      }
    },

  );

  // -------------------------------------------------------------
  // Tool 18: contrib_scout (一站式机会雷达: 发现 + 资格预检 + 信号打分)
  // -------------------------------------------------------------
  server.tool(

    'contrib_scout',
    'Scout high-value, unclaimed contribution opportunities for an organization or repository, filtered by feasibility and developer profile',
    {
      target: z.string().describe('GitHub repository full name (e.g. "bytedance/flowgram.ai") or organization name (e.g. "bytedance")'),
      techStack: z.array(z.string()).optional().describe('Developer tech stack keywords (e.g. ["typescript", "react"])'),
      focusAreas: z.array(z.string()).optional().describe('Developer focus areas (e.g. ["bugfix", "testing", "docs"])'),
      limit: z.number().optional().describe('Maximum number of ranked candidates to return (default 5)'),
      minStars: z.number().optional().describe('Minimum repository stars filter (default 50)'),
      githubToken: z.string().optional().describe('Optional GitHub token if not set in GITHUB_TOKEN environment variable'),
    },
    async (args) => {
      const profile = {
        techStack: args.techStack ?? ['typescript', 'javascript'],
        focusAreas: args.focusAreas ?? ['bugfix', 'testing', 'docs'],
        proficiency: 'intermediate' as const,
        minMatchScore: 60,
      };

      const isOrg = !args.target.includes('/');
      const scoutOpts = {
        repo: isOrg ? undefined : args.target,
        limit: args.limit ?? 5,
        minStars: args.minStars ?? (isOrg ? 100 : 0),
        githubToken: args.githubToken || process.env.GITHUB_TOKEN,
      };

      const opportunities = await scoutOpportunities(profile, scoutOpts);

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                target: args.target,
                foundCount: opportunities.length,
                opportunities,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // =============================================================
  // MCP Resources (只读状态与环境上下文挂载)
  // =============================================================

  // Resource 1: opencontrib://doctor
  server.resource(
    'opencontrib-doctor-report',
    'opencontrib://doctor',
    async (uri) => {
      const report = runDoctorAudit();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(report, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // Resource 2: opencontrib://memory
  server.resource(
    'opencontrib-memory-ledger',
    'opencontrib://memory',
    async (uri) => {
      const report = memory.getMemoryReport();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(report, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // Resource 3: opencontrib://runs
  server.resource(
    'opencontrib-runs-list',
    'opencontrib://runs',
    async (uri) => {
      const runs = runManager.listRuns();
      return {
        contents: [
          {
            uri: uri.href,
            text: JSON.stringify(runs, null, 2),
            mimeType: 'application/json',
          },
        ],
      };
    },
  );

  // =============================================================
  // MCP Prompts (标准 Agent 执行协议提示词)
  // =============================================================
  server.prompt(
    'opencontrib_workflow_guide',
    'Standard Phase-Gated execution protocol for autonomous open-source contribution',
    {
      repoFullName: z.string().optional().describe('Target repository, e.g. "bytedance/flowgram.ai"'),
      issueNumber: z.string().optional().describe('Target issue number if known'),
    },
    async (args) => {
      const targetRepo = args.repoFullName || '<target_owner/target_repo>';
      const issueNum = args.issueNumber ? `#${args.issueNumber}` : '<issue_number>';

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `# OpenContrib Phase-Gated Contribution Protocol

You are an expert open-source contributor AI Agent. Follow this mandatory sequence using OpenContrib MCP tools and GitHub MCP tools:

1. **Discovery & Ranking**: Call \`contrib_scout\` or evaluate an issue with \`contrib_rank_opportunity\`. Verify \`isQualified: true\` and \`maintenanceRisk < 0.3\`.
2. **Context Assembly**: Call \`contrib_assemble_context\` to extract repository skeleton, suggested reading order, target test files, and historical memory pitfalls.
3. **Session Initialization**: Call \`contrib_create_run\` to obtain a \`runId\` for auditable artifact tracking.
4. **Isolated Workspace Allocation**: Call \`contrib_prepare_workspace({ repoFullName: "${targetRepo}", issueOrTaskId: "${issueNum}", runId })\` to work inside an ephemeral Git worktree sandbox.
5. **Code Implementation**: Make surgical edits within the workspace root. Do NOT modify files outside the implementation context.
6. **Dual-Stage Verification**: Call \`contrib_collect_evidence\` with \`preFixAssertionProbe\` to verify the baseline failed pre-fix and passed 100% post-fix under 20x stress loops.
7. **Governance & Anti-AI Lint**: Call \`contrib_audit_governance\` to verify 100-line RFC limit, zero AI chatter comments, and mathematical confidence >= 90%.
8. **PR Template Rendering**: Call \`contrib_render_pr_template\` to merge evidence into the repository's native PR template.
9. **Submission & Flywheel Sync**: Once approved by human user, create the PR via GitHub MCP and call \`contrib_sync_flywheel\` to record your contribution into local profile memory.

Begin execution starting from Step 1!`,
            },
          },
        ],
      };
    },
  );

  return server;
}


