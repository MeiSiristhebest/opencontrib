/**
 * judge-prompt.ts
 *
 * Pure functions for building and parsing LLM Judge prompts.
 * Zero LLM calls inside this module — these are data-transformation utilities.
 * The actual LLM reasoning is done by the Agent environment (Antigravity/Codex/etc.)
 * via invoke_subagent or its own reasoning loop, NOT by this library.
 */

import { z } from 'zod';
import type { TrajectoryEvent, TrajectoryMetrics, JudgeDimensionScore, JudgeEvaluationReport } from './types.js';

// ─── G-Eval Rubric System Prompt ─────────────────────────────────────────────
export const JUDGE_SYSTEM_PROMPT = `You are a strict, neutral, and independent evaluator of AI coding agent execution trajectories for open-source contribution tasks. Your role follows the G-Eval Chain-of-Thought evaluation methodology.

You will receive a compressed execution trajectory of an AI agent. You must evaluate it BLINDLY and OBJECTIVELY on 5 dimensions. You have NO prior knowledge of what score this agent should receive. Derive your scores purely from reading the trajectory text.

## Evaluation Dimensions

### 1. Problem Formulation & Defect Convergence (0–100)
Does the agent converge on a targeted defect hypothesis quickly without aimless wandering?
- EXEMPLARY (85–100): ≤15 commands to root cause using opencontrib probe or smart pointer navigation.
- PROFICIENT (65–84): Some unnecessary exploration but generally targeted.
- NEEDS_IMPROVEMENT (40–64): Significant command sprawl, lack of clear hypothesis.
- UNSATISFACTORY (0–39): Hundreds of exploratory commands with no discernible strategy.

### 2. Context Economy & Anti-Drift (0–100)
Does the agent manage its context window responsibly?
- Penalize CRITICALLY for: commands matching patterns like "rg -n '.*'" or "rg '^'" (whole-file regex dumps to bypass context limits).
- Penalize HEAVILY for: >4 consecutive view_file calls without an intervening targeted search.
- EXEMPLARY (85–100): Uses grep_search / smart pointer slices; no whole-file dumps.
- UNSATISFACTORY (0–20): Repeated whole-file dumps (anti-circumvention).

### 3. Empirical Rigor & Dual-Stage Reproduction (0–100)
Does the agent produce real evidence of pre-fix failure (RED) then post-fix pass (GREEN)?
- EXEMPLARY (85–100): Explicit RED→GREEN cycle; uses opencontrib evidence or equivalent.
- NEEDS_IMPROVEMENT (40–64): Fix applied without first confirming a failing test.
- UNSATISFACTORY (0–39): No reproduction whatsoever.

### 4. Concurrency & Chaos Stress Testing (0–100)
Does the agent apply multi-worker concurrent pressure to validate thread-safety?
- EXEMPLARY (85–100): Stress loop with --concurrency N ≥ 8.
- PROFICIENT (65–84): Some repeated or parallel validation.
- NEEDS_IMPROVEMENT (40–64): Single-run only.
- UNSATISFACTORY (0–39): No stress testing at all.

### 5. Community Craftsmanship & Zero-Mojibake Protocol (0–100)
Does the agent produce clean, professional open-source artifacts?
- Penalize CRITICALLY for: "node -e" / "Buffer.from(...).toString()" used to write files (causes UTF-8 mojibake).
- Penalize CRITICALLY for: PR submitted without a prior Issue and Claim statement (Issue-First protocol).
- EXEMPLARY (85–100): Issue-First, Fixes #<id> in PR, all markdown via write_to_file.
- UNSATISFACTORY (0–20): Shell-hack writes and blind PRs.

## Output Format
Respond ONLY with a valid JSON object. No markdown fences, no preamble.
{
  "chainOfThought": "<step-by-step reasoning before scoring>",
  "dimensions": {
    "problemFormulation": { "score": <0–100>, "reasoning": "<evidence from trajectory>", "evidenceQuotes": ["<exact step text>"] },
    "contextEconomy":     { "score": <0–100>, "reasoning": "<evidence from trajectory>", "evidenceQuotes": ["<exact step text>"] },
    "empiricalRigor":     { "score": <0–100>, "reasoning": "<evidence from trajectory>", "evidenceQuotes": ["<exact step text>"] },
    "concurrencyStress":  { "score": <0–100>, "reasoning": "<evidence from trajectory>", "evidenceQuotes": ["<exact step text>"] },
    "communityCraftsmanship": { "score": <0–100>, "reasoning": "<evidence from trajectory>", "evidenceQuotes": ["<exact step text>"] }
  },
  "overallVerdict": "EXEMPLARY" | "PROFICIENT" | "NEEDS_IMPROVEMENT" | "UNSATISFACTORY",
  "strengths": ["<specific strength with evidence>"],
  "criticalCritiques": ["<specific critique with evidence>"],
  "actionableDirectives": ["<concrete actionable improvement directive>"]
}`;

// ─── Zod schema for parsing the sub-agent's raw JSON response ─────────────────
const JudgeDimOutputSchema = z.object({
  score: z.number().min(0).max(100),
  reasoning: z.string(),
  evidenceQuotes: z.array(z.string()).optional().default([]),
});

export const JudgeOutputSchema = z.object({
  chainOfThought: z.string(),
  dimensions: z.object({
    problemFormulation: JudgeDimOutputSchema,
    contextEconomy: JudgeDimOutputSchema,
    empiricalRigor: JudgeDimOutputSchema,
    concurrencyStress: JudgeDimOutputSchema,
    communityCraftsmanship: JudgeDimOutputSchema,
  }),
  overallVerdict: z.enum(['EXEMPLARY', 'PROFICIENT', 'NEEDS_IMPROVEMENT', 'UNSATISFACTORY']),
  strengths: z.array(z.string()),
  criticalCritiques: z.array(z.string()),
  actionableDirectives: z.array(z.string()),
});

export type JudgeRawOutput = z.infer<typeof JudgeOutputSchema>;

// ─── Trajectory compression ───────────────────────────────────────────────────
/**
 * Compress raw trajectory events into a Judge-readable text.
 * Purely factual — tool names, command text, step index. No opinions.
 * The LLM Judge decides what this means.
 */
export function compressTrajectory(
  events: TrajectoryEvent[],
  metrics: TrajectoryMetrics,
): string {
  const lines: string[] = [
    `=== AGENT EXECUTION TRAJECTORY ===`,
    `Steps: ${metrics.totalSteps} | Commands: ${metrics.totalCommandsRun} | view_file: ${metrics.viewFileCalls} | Max consecutive view_file: ${metrics.maxConsecutiveFileViews}`,
    ``,
    `=== TOOL CALL SEQUENCE (chronological) ===`,
  ];

  for (const event of events) {
    if (!event.toolCalls?.length) continue;
    for (const tc of event.toolCalls) {
      if (tc.name === 'run_command') {
        const cmd = String(tc.args?.CommandLine ?? tc.args?.command ?? '').slice(0, 220);
        lines.push(`[Step ${event.stepIndex}] run_command: ${cmd}`);
      } else if (tc.name === 'view_file') {
        const p = String(tc.args?.AbsolutePath ?? '').split(/[\\/]/).pop() ?? '?';
        lines.push(`[Step ${event.stepIndex}] view_file: ${p}`);
      } else if (tc.name === 'grep_search') {
        lines.push(`[Step ${event.stepIndex}] grep_search: "${String(tc.args?.Query ?? '').slice(0, 80)}"`);
      } else if (tc.name === 'write_to_file') {
        const p = String(tc.args?.TargetFile ?? '').split(/[\\/]/).pop() ?? '?';
        lines.push(`[Step ${event.stepIndex}] write_to_file: ${p}`);
      } else if (tc.name === 'replace_file_content') {
        lines.push(`[Step ${event.stepIndex}] replace_file_content`);
      } else if (tc.name === 'invoke_subagent') {
        lines.push(`[Step ${event.stepIndex}] invoke_subagent`);
      }
    }
  }

  const text = lines.join('\n');
  // Cap at ~6 000 chars to remain within typical context budgets
  return text.length > 6000
    ? text.slice(0, 6000) + '\n...[truncated — trajectory too large for single context window]'
    : text;
}

// ─── buildJudgePrompt ─────────────────────────────────────────────────────────
/**
 * Build the system + user prompt pair that an Agent should hand to a neutral
 * sub-agent for blind G-Eval evaluation.
 *
 * The Agent MUST NOT evaluate this itself (it has context bias).
 * Use invoke_subagent or equivalent to spawn a fresh, neutral LLM conversation.
 */
export function buildJudgePrompt(
  events: TrajectoryEvent[],
  metrics: TrajectoryMetrics,
): { systemPrompt: string; userPrompt: string; trajectoryText: string } {
  const trajectoryText = compressTrajectory(events, metrics);

  const userPrompt = [
    'Please evaluate the following AI agent execution trajectory using the G-Eval rubric provided in your system prompt.',
    '',
    trajectoryText,
    '',
    'Respond ONLY with the JSON object described in the system prompt. No markdown, no explanation outside the JSON.',
  ].join('\n');

  return {
    systemPrompt: JUDGE_SYSTEM_PROMPT,
    userPrompt,
    trajectoryText,
  };
}

// ─── parseJudgeResponse ───────────────────────────────────────────────────────
/**
 * Parse and validate the raw text output from the neutral judge sub-agent.
 * Applies weighted scoring and weakest-dimension gate.
 * This is pure deterministic math — no LLM calls.
 */
export function parseJudgeResponse(
  rawText: string,
  metrics?: TrajectoryMetrics,
): JudgeEvaluationReport {
  // Strip markdown fences if present
  let jsonStr = rawText.trim();
  const fence = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fence) jsonStr = fence[1];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error(
      `Judge sub-agent returned invalid JSON. Ensure it outputs raw JSON without markdown fences.\n\nReceived:\n${rawText.slice(0, 500)}`,
    );
  }

  const judgeOutput = JudgeOutputSchema.parse(parsed);

  const weights: Record<string, number> = {
    problemFormulation: 0.20,
    contextEconomy: 0.20,
    empiricalRigor: 0.25,
    concurrencyStress: 0.15,
    communityCraftsmanship: 0.20,
  };

  const titles: Record<string, string> = {
    problemFormulation: 'Problem Formulation & Defect Convergence',
    contextEconomy: 'Context Economy & Anti-Drift',
    empiricalRigor: 'Empirical Rigor & Dual-Stage Reproduction',
    concurrencyStress: 'Concurrency & Chaos Stress Testing',
    communityCraftsmanship: 'Community Craftsmanship & Zero-Mojibake Protocol',
  };

  const dimKeys = Object.keys(weights) as Array<keyof typeof judgeOutput.dimensions>;

  const dimensions: JudgeDimensionScore[] = dimKeys.map((k) => ({
    dimension: k as JudgeDimensionScore['dimension'],
    title: titles[k],
    weight: weights[k],
    score: judgeOutput.dimensions[k].score,
    reasoning: judgeOutput.dimensions[k].reasoning,
    evidenceQuotes: judgeOutput.dimensions[k].evidenceQuotes,
  }));

  const rawOverall = dimensions.reduce((acc, d) => acc + d.score * d.weight, 0);

  // Weakest-dimension gate: any score < 25 → cap overall at 50
  const minScore = Math.min(...dimensions.map((d) => d.score));
  const overallScore = Math.round(minScore < 25 ? Math.min(rawOverall, 50) : rawOverall);

  const defaultMetrics: TrajectoryMetrics = {
    totalSteps: 0,
    totalCommandsRun: 0,
    failedCommandsCount: 0,
    viewFileCalls: 0,
    maxConsecutiveFileViews: 0,
    wholeFileRgDumpsDetected: 0,
    shellScriptWriteHacksDetected: 0,
  };

  return {
    overallScore,
    verdict: judgeOutput.overallVerdict,
    summary: `LLM Judge (neutral sub-agent): ${overallScore}/100 (${judgeOutput.overallVerdict}).`,
    dimensions,
    strengths: judgeOutput.strengths,
    criticalCritiques: judgeOutput.criticalCritiques,
    actionableDirectives: judgeOutput.actionableDirectives,
    metrics: metrics ?? defaultMetrics,
    chainOfThought: judgeOutput.chainOfThought,
  };
}
