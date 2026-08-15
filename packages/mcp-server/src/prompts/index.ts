import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerPrompts(server: McpServer): void {
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
}
