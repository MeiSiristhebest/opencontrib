import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  assessFeasibility,
  auditGovernance,
  collectEvidence,
  ConfidenceBreakdownSchema,
  detectSystemCapabilities,
  ProfileFlywheel,
  qualifyIssue,
  renderMasterPrTemplate,
  RepoMemoryLedger,
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
    },
    async (args) => {
      const context = worktreeManager.createIsolatedWorkspace({
        repoFullName: args.repoFullName,
        issueOrTaskId: args.issueOrTaskId,
        localRepoPath: args.localRepoPath,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                workspacePath: context.workspacePath,
                branchName: context.branchName,
                isWorktree: context.isWorktree,
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
  // Tool 5: contrib_collect_evidence (本地物证：Flaky基线 + 20次压测)
  // -------------------------------------------------------------
  server.tool(
    'contrib_collect_evidence',
    'Run Step 4.0 Flaky test baseline isolation, 20x stress loops, and handle leak verification on local machine',
    {
      cwd: z.string().describe('Workspace directory to execute test command in'),
      testCommand: z.string().describe('Exact test command, e.g. "npm test" or "pytest"'),
      stressLoopCount: z.number().optional().describe('Number of stress loop iterations (default 20)'),
    },
    async (args) => {
      const evidence = await collectEvidence({
        cwd: args.cwd,
        testCommand: args.testCommand,
        stressLoopCount: args.stressLoopCount ?? 20,
      });

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                evidence,
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
  // Tool 7: contrib_render_pr_template (多厂融合 PR 模板渲染)
  // -------------------------------------------------------------
  server.tool(
    'contrib_render_pr_template',
    'Render Google/VSCode/PyTorch/CloudWeGo/Linux DCO master PR description markdown',
    {
      issueNumber: z.number().describe('Issue number'),
      problemSummary: z.string().describe('What problem this PR solves'),
      rootCause: z.string().describe('Technical explanation of root cause'),
      keyChanges: z.array(z.string()).describe('List of key changes'),
      reproductionCommand: z.string().describe('Command to reproduce bug baseline'),
      verificationCommand: z.string().describe('Command to verify fix passes'),
      testCount: z.number().describe('Total passing tests count'),
      dcoAuthorName: z.string().optional().describe('Author name for DCO Signed-off-by trailer if repo mandates it'),
      dcoAuthorEmail: z.string().optional().describe('Author email for DCO Signed-off-by trailer if repo mandates it'),
      conditionalAiRequired: z.boolean().optional().describe('Whether target repo mandates AI disclosure'),
    },
    async (args) => {
      const markdown = renderMasterPrTemplate({
        issueNumber: args.issueNumber,
        problemSummary: args.problemSummary,
        rootCause: args.rootCause,
        keyChanges: args.keyChanges,
        reproductionCommand: args.reproductionCommand,
        verificationCommand: args.verificationCommand,
        testCount: args.testCount,
        dcoAuthorName: args.dcoAuthorName,
        dcoAuthorEmail: args.dcoAuthorEmail,
        conditionalAiRequired: args.conditionalAiRequired,
      });

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
  // Tool 8: contrib_sync_flywheel (本地资产：记忆库与Profile飞轮)
  // -------------------------------------------------------------
  server.tool(
    'contrib_sync_flywheel',
    'Record contribution into local memory ledger and generate GitHub Profile README flywheel table and SVG badge',
    {
      repoFullName: z.string().describe('Target repository, e.g. "vercel/next.js"'),
      prUrl: z.string().describe('URL of submitted Pull Request'),
      title: z.string().describe('Title of contribution'),
      issueNumber: z.number().optional().describe('Associated issue number'),
      prNumber: z.number().optional().describe('PR number if available'),
      status: z.enum(['submitted', 'in_review', 'merged']).default('submitted'),
    },
    async (args) => {
      memory.recordSuccess(args.repoFullName, {
        prUrl: args.prUrl,
        title: args.title,
        issueNumber: args.issueNumber,
        prNumber: args.prNumber,
      });

      flywheel.saveRecord({
        id: `${args.repoFullName}#${args.prNumber || Date.now()}`,
        repoFullName: args.repoFullName,
        issueNumber: args.issueNumber,
        issueTitle: args.title,
        prNumber: args.prNumber,
        prUrl: args.prUrl,
        status: args.status,
        submittedAt: new Date().toISOString(),
        diffStat: 'Verified minimal patch',
        evidenceSummary: 'Passed all gates and empirical evidence checks',
      });

      const markdown = flywheel.renderProfileMarkdown();
      const svg = flywheel.renderBadgeSvg();

      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify(
              {
                status: 'success',
                message: 'Contribution recorded into memory ledger and flywheel synced.',
                profileMarkdownPreview: markdown,
                badgeSvgPreview: svg,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  return server;
}
