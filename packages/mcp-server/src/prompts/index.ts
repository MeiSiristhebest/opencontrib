import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  getProtocolGuidance,
  PROTOCOL_CONTRACT_PHASES,
  type ContributionRunPhase,
} from "@opencontrib/core";

const GUIDE_EXCLUDED_PHASES = new Set<ContributionRunPhase>([
  "INITIALIZED",
  "COMPLETED",
  "FAILED",
]);

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
    async (args) => {
      const targetRepo = args.repoFullName || "<target_owner/target_repo>";
      const parsedIssueNumber = Number(args.issueNumber);
      const issueNumber = Number.isInteger(parsedIssueNumber)
        ? `, issueNumber: ${parsedIssueNumber}`
        : "";
      const initialized = PROTOCOL_CONTRACT_PHASES.INITIALIZED;

      const steps = Object.values(PROTOCOL_CONTRACT_PHASES)
        .filter(({ phase }) => !GUIDE_EXCLUDED_PHASES.has(phase))
        .map((definition, index) => {
          const guidance = getProtocolGuidance(definition.phase);
          const forbidden = definition.forbiddenActions.length
            ? ` Forbidden: ${definition.forbiddenActions.join("; ")}`
            : "";
          const invariants = definition.invariants.length
            ? ` Invariants: ${definition.invariants.join(" ")}`
            : "";
          return `${index + 2}. **${definition.phase}: ${definition.name}** — call \`${definition.mcp.tool}\` to reach this phase; next canonical action is \`${guidance.mcpTool}\` (\`${guidance.suggestedNextAction}\`).${invariants}${forbidden}`;
        });

      const workflowText = [
        "# OpenContrib Phase-Gated Contribution Protocol",
        "",
        "This guide is generated from `PROTOCOL_CONTRACT_PHASES`; follow it as the canonical MCP protocol.",
        "The sequence is strictly ordered. Do not skip, reorder, or replace canonical services with direct provider calls.",
        "",
        "## Required execution order",
        "",
        `1. **${initialized.phase}: ${initialized.name} (MUST be first)** — call \`${initialized.mcp.tool}({ repoFullName: ${JSON.stringify(targetRepo)}${issueNumber} })\` to obtain \`runId\`. No discovery, probing, context assembly, workspace work, or source modification may begin before this run anchor exists.`,
        ...steps,
        "",
        "## Evidence and submission invariants",
        "",
        "- `contrib_capture_red` MUST run before any patch is drafted and records the immutable RED baseline.",
        "- Modify source only inside the canonical workspace after `contrib_prepare_workspace`.",
        "- `contrib_verify_green` MUST run after the patch draft; it binds GREEN to RED and advances the evidence gate.",
        "- `contrib_collect_evidence` is diagnostic-only and deprecated for the canonical path. It cannot satisfy governance or advance the run in place of `contrib_capture_red` and `contrib_verify_green`.",
        "- Approval is an artifact-level gate. Request approval through OpenContrib, then submit only through `contrib_submit_pr` and the trusted `SubmissionPort`.",
        "- DO NOT call GitHub MCP or GitHub API create/update-pull-request operations directly. They bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.",
        "- Call `contrib_sync_flywheel` only after a verified submission and completion artifact exist.",
      ].join("\n");

      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: workflowText,
            },
          },
        ],
      };
    },
  );
}
