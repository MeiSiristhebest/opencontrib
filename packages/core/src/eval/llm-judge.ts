/**
 * llm-judge.ts
 *
 * Thin re-export shim for backward compatibility.
 *
 * The eval system is now Agent-Native:
 * - `buildJudgePrompt(events, metrics)` → constructs the G-Eval prompt for a neutral sub-agent
 * - `parseJudgeResponse(rawText, metrics)` → parses the sub-agent's JSON reply
 *
 * The actual LLM reasoning is performed by the Agent environment (Antigravity, Codex, Cursor, etc.)
 * via invoke_subagent. This library does NOT call any external LLM API.
 * Zero hardcoded scoring rules. Zero external API keys required.
 *
 * Usage workflow (in the Agent):
 *   1. const { systemPrompt, userPrompt } = buildJudgePrompt(events, metrics)
 *   2. Agent spawns a neutral sub-agent with systemPrompt + userPrompt
 *   3. Sub-agent returns raw JSON
 *   4. const report = parseJudgeResponse(rawJson, metrics)
 */

export {
  buildJudgePrompt,
  parseJudgeResponse,
  compressTrajectory,
  JUDGE_SYSTEM_PROMPT,
  JudgeOutputSchema,
  type JudgeRawOutput,
} from './judge-prompt.js';
