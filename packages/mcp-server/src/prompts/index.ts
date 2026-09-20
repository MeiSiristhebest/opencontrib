import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { renderWorkflowGuide } from "@opencontrib/core";

export function registerPrompts(server: McpServer): void {
  server.prompt(
    "opencontrib_workflow_guide",
    "Standard Phase-Gated execution protocol for autonomous open-source contribution",
    {
      repoFullName: z
        .string()
        .optional()
        .describe('Target repository, e.g. "owner/repo"'),
      issueNumber: z
        .string()
        .optional()
        .describe("Target issue number if known"),
    },
    async (args) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: renderWorkflowGuide({
              targetRepo: args.repoFullName,
              issueNumber: args.issueNumber,
            }),
          },
        },
      ],
    }),
  );
}
