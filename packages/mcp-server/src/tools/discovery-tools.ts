import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  assessFeasibility,
  detectSystemCapabilities,
  diagnoseManifests,
  qualifyIssue,
  rankOpportunitySignals,
  runDoctorAudit,
  scoutOpportunities,
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

export function registerDiscoveryTools(server: McpServer): void {
  // -------------------------------------------------------------
  // Tool 1: contrib_assess_feasibility (纯算法：环境可行性矩阵)
  // -------------------------------------------------------------
  server.tool(
    'contrib_assess_feasibility',
    'Assess OS and toolchain execution feasibility for an issue against local machine (Windows/WSL/Docker/Mac)',
    {
      issueTitle: z.string().describe('Title of the issue'),
      issueBody: z.string().optional().describe('Body of the issue'),
      labels: z.array(z.string()).optional().describe('Labels attached to the issue'),
    },
    wrapHandler(async (args) => {
      const capabilities = detectSystemCapabilities();
      const assessment = assessFeasibility(
        args.issueTitle,
        args.issueBody || '',
        args.labels || [],
        capabilities,
      );

      return {
        content: [{
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
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool 2: contrib_qualify_issue (纯算法：议题前置资格筛查)
  // -------------------------------------------------------------
  server.tool(
    'contrib_qualify_issue',
    'Verify if an issue is safe and qualified for external contribution (checks author-first-right, anti-bandwagoning, and blocking labels)',
    {
      issueNumber: z.number().describe('GitHub issue number'),
      issueTitle: z.string().describe('GitHub issue title'),
      issueBody: z.string().optional().describe('GitHub issue body'),
      author: z.string().optional().describe('Issue author username'),
      assignees: z.array(z.string()).optional().describe('Current assignees'),
      commentsCount: z.number().optional().describe('Number of comments'),
      hasPrLinked: z.boolean().optional().describe('Whether a PR is already linked to this issue'),
      labels: z.array(z.string()).optional().describe('Array of issue label names'),
      createdAt: z.string().optional().describe('ISO timestamp of issue creation'),
      comments: z
        .array(
          z.object({
            author: z.string(),
            body: z.string(),
            createdAt: z.string(),
          }),
        )
        .optional()
        .describe('Recent issue comments for bandwagoning check'),
    },
    wrapHandler(async (args) => {
      const qualification = qualifyIssue(args as any);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            { status: qualification.isQualified ? 'qualified' : 'disqualified', qualification },
            null,
            2,
          ),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool 3: contrib_diagnose_manifests (纯诊断：<=100行主动探针建议)
  // -------------------------------------------------------------
  server.tool(
    'contrib_diagnose_manifests',
    'Diagnose repo workflows, package.json, pyproject.toml, and Cargo.toml for <=100 line PR improvement suggestions',
    {
      workflows: z.array(z.object({ path: z.string(), content: z.string() })).optional().default([]).describe('Optional list of workflow files and contents from GitHub MCP'),
      readmeContent: z.string().optional().describe('Content of README.md from GitHub MCP'),
      packageJsonContent: z.string().optional().describe('Content of package.json from GitHub MCP'),
      pyprojectContent: z.string().optional().describe('Content of pyproject.toml from GitHub MCP'),
      cargoContent: z.string().optional().describe('Content of Cargo.toml from GitHub MCP'),
      gitignoreContent: z.string().optional().describe('Content of .gitignore from GitHub MCP'),
      dependabotContent: z.string().optional().describe('Content of .github/dependabot.yml from GitHub MCP'),
    },
    wrapHandler(async (args) => {
      const result = diagnoseManifests(args);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool 4: contrib_doctor (宿主机环境健康与依赖诊断)
  // -------------------------------------------------------------
  server.tool(
    'contrib_doctor',
    'Audit host environment health (Git, Bun/Node, Docker, WSL, and OpenContrib storage)',
    {},
    wrapHandler(async () => {
      const report = runDoctorAudit();

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', report }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool 5: contrib_rank_opportunity (离散概率特征信号)
  // -------------------------------------------------------------
  server.tool(
    'contrib_rank_opportunity',
    'Extract objective multi-dimensional probability signals (skill match, feasibility, issue clarity, actionability, repo health) without prescribing binary decisions',
    {
      issue: z.object({
        number: z.union([z.number(), z.string()]).transform((v) => (typeof v === 'string' ? parseInt(v, 10) : v)).describe('GitHub issue number'),
        title: z.string().describe('Title of the issue'),
        body: z.string().describe('Body text of the issue'),
        labels: z.array(z.string()).describe('Labels attached to the issue'),
        createdAt: z.string().describe('ISO timestamp of creation date'),
        commentsCount: z.number().describe('Total number of comments'),
        isOpen: z.boolean().describe('Whether issue is currently open'),
        assigneesCount: z.number().describe('Number of assigned developers'),
        authorAssociation: z.string().optional().describe('Author relationship (e.g. OWNER, MEMBER, CONTRIBUTOR, NONE)'),
      }),
      repository: z
        .object({
          fullName: z.string().describe('Full name of repository, e.g. "owner/repo"'),
          stars: z.number().optional().describe('Repository star count'),
          forksCount: z.number().optional().describe('Repository fork count'),
          openIssuesCount: z.number().optional().describe('Total open issues'),
          primaryLanguage: z.string().optional().describe('Primary language of repository'),
          hasContributingGuide: z.boolean().optional().describe('Whether repo has CONTRIBUTING.md'),
          hasGoodFirstIssueLabel: z.boolean().optional().describe('Whether good first issue label is present'),
          pushedAt: z.string().optional().describe('ISO timestamp of last push'),
        })
        .optional()
        .describe('Repository metadata'),
      developerProfile: z
        .object({
          techStack: z.array(z.string()).describe('Developer tech stack keywords, e.g. ["typescript", "react"]'),
          focusAreas: z.array(z.string()).describe('Focus areas, e.g. ["bugfix", "testing"]'),
          proficiency: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
        })
        .optional()
        .describe('Optional developer profile to evaluate skill affinity and probability signals'),
    },
    wrapHandler(async (args) => {
      const repoObj = args.repository;
      const normalizedRepo = {
        fullName: repoObj?.fullName || 'unknown/unknown',
        stars: repoObj?.stars ?? 0,
        primaryLanguage: repoObj?.primaryLanguage,
        openIssuesCount: repoObj?.openIssuesCount,
      };

      const signals = rankOpportunitySignals({
        issue: args.issue,
        repository: normalizedRepo,
        developerProfile: args.developerProfile,
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', signals }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool 6: contrib_assemble_context (多维探索指引与目标测试提取)
  // -------------------------------------------------------------
  server.tool(
    'contrib_assemble_context',
    'Assemble multi-dimensional context combining issue problem, repo skeleton, target test files, exploration reading order, memory pitfalls, and host environment',
    {
      issue: z.object({
        number: z.number(),
        title: z.string(),
        body: z.string(),
        labels: z.array(z.string()),
      }),
      repoDetails: z.object({
        owner: z.string(),
        repo: z.string(),
        defaultBranch: z.string(),
        description: z.string().optional(),
        stars: z.number().optional(),
      }),
      repoTree: z
        .array(
          z.object({
            path: z.string(),
            type: z.string(),
          }),
        )
        .describe('List of file paths from GitHub MCP get_file_contents or git tree'),
    },
    wrapHandler(async (args) => {
      const { ContextAssembler } = await import('@opencontrib/core');
      const assembler = new ContextAssembler();

      const context = await assembler.assembleContext({
        issue: {
          number: args.issue.number,
          title: args.issue.title,
          body: args.issue.body,
          labels: args.issue.labels,
          isOpen: true,
          assignees: [],
          createdAt: new Date().toISOString(),
          comments: [],
        },
        repoDetails: {
          owner: args.repoDetails.owner,
          repo: args.repoDetails.repo,
          fullName: `${args.repoDetails.owner}/${args.repoDetails.repo}`,
          defaultBranch: args.repoDetails.defaultBranch,
          description: args.repoDetails.description || '',
          stars: args.repoDetails.stars || 0,
        },
        repoTree: args.repoTree.map((item: any) => ({
          path: item.path,
          mode: '100644',
          type: item.type as any,
          sha: 'placeholder',
        })),
      });

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ status: 'success', context }, null, 2),
        }],
      };
    }),
  );

  // -------------------------------------------------------------
  // Tool 7: contrib_scout (一站式机会雷达: 发现 + 资格预检 + 信号打分)
  // -------------------------------------------------------------
  server.tool(
    'contrib_scout',
    'Scout high-value, unclaimed contribution opportunities for an organization or repository, filtered by feasibility and developer profile',
    {
      target: z.string().describe('GitHub repository full name (e.g. "owner/repo") or organization name (e.g. "org-name")'),
      techStack: z.array(z.string()).optional().describe('Developer tech stack keywords (e.g. ["typescript", "react"])'),
      focusAreas: z.array(z.string()).optional().describe('Developer focus areas (e.g. ["bugfix", "testing", "docs"])'),
      limit: z.number().optional().describe('Maximum number of ranked candidates to return (default 5)'),
      minStars: z.number().optional().describe('Minimum repository stars filter (default 50)'),
    },
    wrapHandler(async (args) => {
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
      };

      const opportunities = await scoutOpportunities(profile, scoutOpts);

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(
            { status: 'success', target: args.target, foundCount: opportunities.length, opportunities },
            null,
            2,
          ),
        }],
      };
    }),
  );
}
