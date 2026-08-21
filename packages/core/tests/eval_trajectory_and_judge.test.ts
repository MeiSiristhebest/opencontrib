import { describe, expect, it } from 'bun:test';
import { parseTrajectoryFromJSONL } from '../src/eval/trajectory-parser.js';
import { buildJudgePrompt, parseJudgeResponse, compressTrajectory } from '../src/eval/judge-prompt.js';
import type { TrajectoryEvent, TrajectoryMetrics } from '../src/eval/types.js';

// ────────────────────────────────────────────────────────────────────────────
// These tests verify the DATA-TRANSFORMATION layer only:
//   - trajectory-parser.ts  : JSONL → structured events + factual metrics
//   - judge-prompt.ts       : events+metrics → judge prompt text (buildJudgePrompt)
//   - judge-prompt.ts       : raw JSON string → JudgeEvaluationReport (parseJudgeResponse)
//
// NO actual LLM is called here. The neutral LLM sub-agent lives in the Agent
// environment (Antigravity / Codex / Cursor) — not inside this library.
// ────────────────────────────────────────────────────────────────────────────

const SAMPLE_JSONL = [
  '{"step_index":0,"type":"USER_INPUT","content":"scan repo and fix the concurrency bug"}',
  '{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"opencontrib probe run ./repo"}}]}',
  '{"step_index":2,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file1.ts"}}]}',
  '{"step_index":3,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file2.ts"}}]}',
  '{"step_index":4,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file3.ts"}}]}',
  '{"step_index":5,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file4.ts"}}]}',
  '{"step_index":6,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file5.ts"}}]}',
  '{"step_index":7,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"opencontrib evidence --concurrency 10"}}]}',
  '{"step_index":8,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"write_to_file","args":{"TargetFile":"/repo/pr.md"}}]}',
].join('\n');

describe('Trajectory Parser — factual metrics extraction', () => {
  it('counts all tool calls and tracks consecutive view_file sequences', () => {
    const { events, metrics } = parseTrajectoryFromJSONL(SAMPLE_JSONL);

    // Parser includes both USER_INPUT and PLANNER_RESPONSE non-empty lines
    expect(events.length).toBe(9); // 1 USER_INPUT + 8 PLANNER_RESPONSE
    expect(metrics.totalSteps).toBe(9);
    // 5 view_file calls (steps 2-6)
    expect(metrics.viewFileCalls).toBe(5);
    expect(metrics.maxConsecutiveFileViews).toBe(5);
    // run_command calls: steps 1, 7 = 2
    expect(metrics.totalCommandsRun).toBe(2);
  });

  it('metrics are purely factual — no scoring or opinionated rules', () => {
    const { metrics } = parseTrajectoryFromJSONL(SAMPLE_JSONL);
    // Metrics only count; they do NOT contain any score or verdict
    expect(typeof metrics.totalCommandsRun).toBe('number');
    expect(typeof metrics.viewFileCalls).toBe('number');
    expect((metrics as any).score).toBeUndefined();
    expect((metrics as any).verdict).toBeUndefined();
  });
});

describe('buildJudgePrompt — prompt construction (pure function, zero LLM calls)', () => {
  it('returns systemPrompt, userPrompt, and trajectoryText', () => {
    const { events, metrics } = parseTrajectoryFromJSONL(SAMPLE_JSONL);
    const { systemPrompt, userPrompt, trajectoryText } = buildJudgePrompt(events, metrics);

    expect(systemPrompt.length).toBeGreaterThan(200);
    expect(userPrompt).toContain(trajectoryText);
    expect(userPrompt).toContain('G-Eval rubric');
    expect(trajectoryText).toContain('run_command');
  });

  it('systemPrompt contains the 5 evaluation dimension headings', () => {
    const { events, metrics } = parseTrajectoryFromJSONL(SAMPLE_JSONL);
    const { systemPrompt } = buildJudgePrompt(events, metrics);

    expect(systemPrompt).toContain('Problem Formulation');
    expect(systemPrompt).toContain('Context Economy');
    expect(systemPrompt).toContain('Empirical Rigor');
    expect(systemPrompt).toContain('Concurrency');
    expect(systemPrompt).toContain('Craftsmanship');
  });

  it('compressTrajectory caps output at 6000 chars for context budget', () => {
    // Create a large fake event list
    const bigEvents: TrajectoryEvent[] = Array.from({ length: 500 }, (_, i) => ({
      stepIndex: i,
      type: 'PLANNER_RESPONSE',
      toolCalls: [{ name: 'run_command', args: { CommandLine: `rg "pattern${i}" /repo/src/` } }],
    }));
    const metrics: TrajectoryMetrics = {
      totalSteps: 500, totalCommandsRun: 500, failedCommandsCount: 0,
      viewFileCalls: 0, maxConsecutiveFileViews: 0,
      wholeFileRgDumpsDetected: 0, shellScriptWriteHacksDetected: 0,
    };
    const text = compressTrajectory(bigEvents, metrics);
    expect(text.length).toBeLessThanOrEqual(6100); // allows for truncation marker
    expect(text).toContain('truncated');
  });
});

describe('parseJudgeResponse — validates neutral sub-agent JSON, applies scoring math', () => {
  const buildMockJudgeJson = (overrides: Record<string, number> = {}) => JSON.stringify({
    chainOfThought: 'Step-by-step reasoning: The agent used targeted searches and converged quickly.',
    dimensions: {
      problemFormulation:   { score: overrides.pf  ?? 80, reasoning: 'Targeted probe run.', evidenceQuotes: [] },
      contextEconomy:       { score: overrides.ce  ?? 85, reasoning: 'No whole-file dumps.', evidenceQuotes: [] },
      empiricalRigor:       { score: overrides.er  ?? 90, reasoning: 'Evidence collected.', evidenceQuotes: [] },
      concurrencyStress:    { score: overrides.cs  ?? 88, reasoning: 'Concurrency flag used.', evidenceQuotes: [] },
      communityCraftsmanship: { score: overrides.cc ?? 82, reasoning: 'write_to_file used.', evidenceQuotes: [] },
    },
    overallVerdict: overrides.pf === 0 ? 'UNSATISFACTORY' : 'PROFICIENT',
    strengths: ['Used write_to_file', 'Applied concurrency testing'],
    criticalCritiques: [],
    actionableDirectives: ['Continue using Smart Pointer slices'],
  });

  it('returns a valid JudgeEvaluationReport with all 5 dimensions', () => {
    const report = parseJudgeResponse(buildMockJudgeJson());

    expect(report.overallScore).toBeGreaterThan(0);
    expect(report.overallScore).toBeLessThanOrEqual(100);
    expect(['EXEMPLARY', 'PROFICIENT', 'NEEDS_IMPROVEMENT', 'UNSATISFACTORY']).toContain(report.verdict);
    expect(report.dimensions).toHaveLength(5);
    expect(report.chainOfThought).toBeDefined();
    expect(report.strengths.length).toBeGreaterThan(0);
    expect(report.actionableDirectives.length).toBeGreaterThan(0);

    for (const d of report.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(100);
      expect(d.reasoning.length).toBeGreaterThan(0);
      expect(d.weight).toBeGreaterThan(0);
    }
  });

  it('applies weakest-dimension gate: any score < 25 caps overall at ≤ 50', () => {
    const report = parseJudgeResponse(buildMockJudgeJson({ pf: 0 }));
    expect(report.overallScore).toBeLessThanOrEqual(50);
  });

  it('throws a clear error when sub-agent returns invalid JSON', () => {
    expect(() => parseJudgeResponse('not valid json at all')).toThrow(
      /invalid JSON/i,
    );
  });

  it('strips markdown fences before parsing JSON', () => {
    const fenced = '```json\n' + buildMockJudgeJson() + '\n```';
    const report = parseJudgeResponse(fenced);
    expect(report.overallScore).toBeGreaterThan(0);
  });
});
