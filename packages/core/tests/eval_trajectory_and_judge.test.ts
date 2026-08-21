import { describe, expect, it } from 'bun:test';
import {
  parseTrajectoryFromJSONL,
  evaluateTrajectoryWithJudge,
  type TrajectoryEvent,
  type TrajectoryMetrics,
} from '../src/eval/index.js';

describe('LLM-as-a-Judge Trajectory Evaluator & G-Eval Engine', () => {
  it('parses JSONL transcripts and extracts comprehensive tool call and violation metrics', () => {
    const mockJsonl = `
{"step_index":0,"type":"USER_INPUT","content":"scan repo and fix bug"}
{"step_index":1,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"opencontrib probe run ./repo"}}]}
{"step_index":2,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file1.ts"}}]}
{"step_index":3,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file2.ts"}}]}
{"step_index":4,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file3.ts"}}]}
{"step_index":5,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"view_file","args":{"AbsolutePath":"/repo/file4.ts"}}]}
{"step_index":6,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"rg -n \\\".*\\\" /repo/file1.ts"}}]}
{"step_index":7,"type":"PLANNER_RESPONSE","tool_calls":[{"name":"run_command","args":{"CommandLine":"node -e \\\"const fs = require('fs'); fs.writeFileSync('out.md', '...' );\\\""}}]}
`;
    const { events, metrics } = parseTrajectoryFromJSONL(mockJsonl);

    expect(events.length).toBe(8);
    expect(metrics.totalSteps).toBe(8);
    expect(metrics.totalCommandsRun).toBe(3);
    expect(metrics.viewFileCalls).toBe(4);
    expect(metrics.maxConsecutiveFileViews).toBe(4);
    expect(metrics.wholeFileRgDumpsDetected).toBe(1);
    expect(metrics.shellScriptWriteHacksDetected).toBe(1);
  });

  it('runs G-Eval multi-dimensional judge scoring and penalizes anti-patterns', () => {
    const mockEvents: TrajectoryEvent[] = [
      { stepIndex: 0, type: 'USER_INPUT', content: 'fix bug' },
      {
        stepIndex: 1,
        type: 'PLANNER_RESPONSE',
        toolCalls: [
          { name: 'run_command', args: { CommandLine: 'rg -n ".*" /repo/foo.ts' } },
          { name: 'run_command', args: { CommandLine: 'node -e "const fs = require(\'fs\');"' } },
        ],
      },
    ];
    const mockMetrics: TrajectoryMetrics = {
      totalSteps: 50,
      totalCommandsRun: 45,
      failedCommandsCount: 5,
      viewFileCalls: 8,
      maxConsecutiveFileViews: 5,
      wholeFileRgDumpsDetected: 3,
      shellScriptWriteHacksDetected: 2,
    };

    const report = evaluateTrajectoryWithJudge(mockEvents, mockMetrics);

    expect(report.overallScore).toBeLessThan(75);
    expect(['UNSATISFACTORY', 'NEEDS_IMPROVEMENT']).toContain(report.verdict);
    expect(report.criticalCritiques.length).toBeGreaterThan(0);
    expect(report.actionableDirectives.some((d) => d.includes('rg -n ".*"'))).toBe(true);
    expect(report.actionableDirectives.some((d) => d.includes('write_to_file'))).toBe(true);
  });

  it('awards EXEMPLARY rating (>= 90) to clean, disciplined trajectories', () => {
    const cleanEvents: TrajectoryEvent[] = [
      { stepIndex: 0, type: 'USER_INPUT', content: 'fix bug' },
      {
        stepIndex: 1,
        type: 'PLANNER_RESPONSE',
        toolCalls: [
          { name: 'run_command', args: { CommandLine: 'opencontrib probe run ./repo' } },
          { name: 'run_command', args: { CommandLine: 'opencontrib pointer resolve ptr://findings/1 --view slice' } },
          { name: 'run_command', args: { CommandLine: 'opencontrib workspace prepare --repo owner/repo' } },
          { name: 'run_command', args: { CommandLine: 'opencontrib evidence --cwd /ws --test-cmd "bun test" --concurrency 10' } },
          { name: 'run_command', args: { CommandLine: 'gh issue create --body-file issue.md' } },
          { name: 'run_command', args: { CommandLine: 'gh pr create --body-file pr.md' } },
        ],
      },
    ];
    const cleanMetrics: TrajectoryMetrics = {
      totalSteps: 12,
      totalCommandsRun: 6,
      failedCommandsCount: 0,
      viewFileCalls: 1,
      maxConsecutiveFileViews: 1,
      wholeFileRgDumpsDetected: 0,
      shellScriptWriteHacksDetected: 0,
    };

    const report = evaluateTrajectoryWithJudge(cleanEvents, cleanMetrics);

    expect(report.overallScore).toBeGreaterThanOrEqual(90);
    expect(report.verdict).toBe('EXEMPLARY');
    expect(report.strengths.length).toBeGreaterThanOrEqual(4);
  });
});
