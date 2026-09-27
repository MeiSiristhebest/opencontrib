import { describe, expect, it } from 'bun:test';
import { parseTrajectoryFromJSONL } from '../src/eval/trajectory-parser.js';

describe('trajectory parser CLI run identity', () => {
  it('extracts explicit --run-id values from OpenContrib CLI actions', () => {
    const transcript = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine:
              "opencontrib evidence capture-red --run-id run_123 --test-cmd 'bun test'",
          },
        },
        {
          name: 'run_command',
          args: {
            CommandLine:
              'opencontrib evidence verify-green --run-id="run_123" --test-cmd "bun test"',
          },
        },
      ],
    });

    const { actions } = parseTrajectoryFromJSONL(transcript);
    expect(actions.map((action) => action.inputRunId)).toEqual([
      'run_123',
      'run_123',
    ]);
    expect(actions.map((action) => action.runId)).toEqual([
      'run_123',
      'run_123',
    ]);
  });

  it('does not treat unresolved shell variables as run identity', () => {
    const transcript = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine:
              'opencontrib evidence verify-green --run-id "$RUN_ID" --test-cmd "bun test"',
          },
        },
      ],
    });

    const { actions } = parseTrajectoryFromJSONL(transcript);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.inputRunId).toBeUndefined();
  });

  it('does not extract --run-id from a nested test command', () => {
    const transcript = JSON.stringify({
      step_index: 0,
      type: 'PLANNER_RESPONSE',
      tool_calls: [
        {
          name: 'run_command',
          args: {
            CommandLine:
              'opencontrib evidence capture-red --test-cmd "echo --run-id nested_run"',
          },
        },
      ],
    });

    const { actions } = parseTrajectoryFromJSONL(transcript);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.inputRunId).toBeUndefined();
  });
});
