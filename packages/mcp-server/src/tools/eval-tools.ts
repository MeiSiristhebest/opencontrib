/**
 * Eval Tools - MCP tool registration for LLM-as-a-Judge trajectory evaluation
 *
 * Design principle (Agent-Native):
 * - These tools do NOT call any external LLM API themselves.
 * - They compress the trajectory and assemble a structured G-Eval judge prompt.
 * - The calling Agent (Antigravity, Codex, Cursor, etc.) uses its own built-in
 *   model (or spawns a neutral sub-agent) to reason over the prompt and return scores.
 * - Zero external API keys. Zero hardcoded scoring rules.
 */

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { existsSync } from 'node:fs';
import * as path from 'path';
import * as os from 'os';
import {
  parseTrajectoryFromJSONL,
  buildJudgePrompt,
  parseJudgeResponse,
  type JudgeEvaluationReport,
} from '@opencontrib/core';

export function registerEvalTools(server: McpServer): void {
  // ─── Tool: contrib_eval_prepare_judge ──────────────────────────────────────
  // Phase 1: Compress the transcript and return a structured judge prompt.
  // The Agent feeds this prompt to a neutral sub-agent or its own reasoning loop.
  server.tool(
    'contrib_eval_prepare_judge',
    [
      'Compress a conversation transcript JSONL into a structured G-Eval judge prompt.',
      'Returns: (1) a compressed trajectory summary text, (2) a fully-formatted judge prompt',
      'that you must feed to a **neutral, independent sub-agent** (not yourself) for blind evaluation.',
      'The sub-agent should return a JSON evaluation report conforming to JudgeOutputSchema.',
      'This tool performs ZERO scoring itself — all judgment comes from the LLM that reads the prompt.',
    ].join('\n'),
    {
      transcriptPath: z
        .string()
        .describe('Absolute path to the transcript.jsonl file for the session to evaluate'),
      conversationId: z
        .string()
        .optional()
        .describe('Optional conversation ID (used to locate transcript automatically)'),
    },
    async ({ transcriptPath, conversationId }) => {
      // Resolve path
      let resolvedPath = path.resolve(transcriptPath);

      // Validate resolvedPath against home directory boundary
      const home = process.env.OPENCONTRIB_HOME || process.env.HOME || os.homedir();
      const allowedRoot = path.resolve(home);
      if (!resolvedPath.startsWith(allowedRoot + path.sep) && resolvedPath !== allowedRoot) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Transcript path "${resolvedPath}" is outside the allowed workspace boundary. Set OPENCONTRIB_HOME to allow it.` }],
        };
      }

      if (!existsSync(resolvedPath) && conversationId) {
        const appData = process.env.APPDATA || process.env.HOME || '';
        const candidates = [
          `${appData}/.gemini/antigravity/brain/${conversationId}/.system_generated/logs/transcript.jsonl`,
          `${appData}/antigravity/brain/${conversationId}/.system_generated/logs/transcript.jsonl`,
        ];
        resolvedPath = candidates.find((c: string) => {
          const r = path.resolve(c);
          return r.startsWith(allowedRoot + path.sep) || r === allowedRoot ? existsSync(r) : false;
        }) ?? resolvedPath;
      }

      if (!existsSync(resolvedPath)) {
        return {
          isError: true,
          content: [{ type: 'text', text: `Transcript not found: ${resolvedPath}` }],
        };
      }

      const { events, metrics } = parseTrajectoryFromJSONL(resolvedPath);
      const { systemPrompt, userPrompt, trajectoryText } = buildJudgePrompt(events, metrics);

      return {
        content: [
          {
            type: 'text',
            text: [
              '## Trajectory Compressed Successfully',
              '',
              `**Steps:** ${metrics.totalSteps} | **Commands:** ${metrics.totalCommandsRun} | **view_file calls:** ${metrics.viewFileCalls}`,
              `**Max consecutive view_file:** ${metrics.maxConsecutiveFileViews}`,
              '',
              '## Next Step: Spawn a Neutral Sub-Agent Judge',
              '',
              'You MUST hand the prompt below to a **separate, independent sub-agent**.',
              'Do NOT evaluate this yourself — you have context bias.',
              'The sub-agent must read the trajectory with fresh eyes and return JSON.',
              '',
              '### SYSTEM PROMPT FOR JUDGE SUB-AGENT',
              '```',
              systemPrompt,
              '```',
              '',
              '### USER PROMPT FOR JUDGE SUB-AGENT',
              '```',
              userPrompt,
              '```',
              '',
              '### COMPRESSED TRAJECTORY (for your reference)',
              '```',
              trajectoryText,
              '```',
            ].join('\n'),
          },
        ],
      };
    },
  );

  // ─── Tool: contrib_eval_parse_judgment ─────────────────────────────────────
  // Phase 2: Once the neutral sub-agent returns its raw JSON evaluation,
  // this tool validates and structures it into a canonical JudgeEvaluationReport.
  server.tool(
    'contrib_eval_parse_judgment',
    [
      'Parse and validate the raw JSON response from the neutral judge sub-agent.',
      'Input: the raw text output from the judge sub-agent.',
      'Output: a validated, structured JudgeEvaluationReport with weighted overall score,',
      'weakest-dimension gate applied, and reflexion directives ready for memory ledger ingestion.',
    ].join('\n'),
    {
      rawJudgeResponse: z
        .string()
        .describe('The raw JSON text returned by the neutral judge sub-agent'),
      transcriptPath: z
        .string()
        .optional()
        .describe('Original transcript path (included in report metadata)'),
    },
    async ({ rawJudgeResponse, transcriptPath }) => {
      let report: JudgeEvaluationReport;
      try {
        report = parseJudgeResponse(rawJudgeResponse);
      } catch (err: any) {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Failed to parse judge response: ${err.message}\n\nRaw response received:\n${rawJudgeResponse}`,
            },
          ],
        };
      }

      const verdictEmoji = {
        EXEMPLARY: '🏆',
        PROFICIENT: '✅',
        NEEDS_IMPROVEMENT: '⚠️',
        UNSATISFACTORY: '❌',
      }[report.verdict];

      const dimensionLines = report.dimensions
        .map((d) => `  ${d.title}: **${d.score}/100** — ${d.reasoning.slice(0, 120)}`)
        .join('\n');

      return {
        content: [
          {
            type: 'text',
            text: [
              `## ${verdictEmoji} Judge Evaluation Report`,
              '',
              `**Overall Score:** ${report.overallScore}/100 (${report.verdict})`,
              transcriptPath ? `**Transcript:** ${transcriptPath}` : '',
              '',
              '### Dimension Scores',
              dimensionLines,
              '',
              '### Strengths',
              report.strengths.map((s) => `- ${s}`).join('\n'),
              '',
              '### Critical Critiques',
              report.criticalCritiques.map((c) => `- ${c}`).join('\n'),
              '',
              '### Actionable Directives (Reflexion)',
              report.actionableDirectives.map((a) => `- ${a}`).join('\n'),
              '',
              '### Chain of Thought (Judge Reasoning)',
              report.chainOfThought ?? '(not available)',
              '',
              '### Raw Structured Report (JSON)',
              '```json',
              JSON.stringify(report, null, 2),
              '```',
            ]
              .filter((l) => l !== undefined)
              .join('\n'),
          },
        ],
      };
    },
  );
}
