# Evidence Command

Dual-stage empirical verification: pre-fix failure baseline + post-fix stress loop.

## `evidence`

```bash
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "npm test"

# With pre-fix assertion capture
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "npm test" \
  --assertion "expect.*toFail" \
  --pre-fix-cmd "npm test -- --runInBand" \
  --stress-loop 20

# Auto-resolve workspace from a run session
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "npm test" \
  --run-id run_20260819195606_a_b_issue_1_umpc
```

| Flag | Type | Required | Default | Description |
| ------ | ------ | ---------- | --------- | ------------- |
| `--cwd` | string | ✓ | — | Workspace directory to run tests in |
| `--test-cmd` | string | ✓ | — | Test command, e.g. `npm test` |
| `--pre-fix-cmd` | string | — | same as `--test-cmd` | Separate command to trigger pre-fix failure |
| `--assertion` | string | — | — | Regex for expected failure before fix |
| `--stress-loop` | number | — | `20` | Stress loop iterations |
| `--workspace-root` | string | — | — | Root workspace for security boundary |
| `--baseline-sha` | string | — | — | Baseline commit SHA before changes |
| `--run-id` | string | — | — | Auto-resolve workspace from run session |
| `--pretty` | flag | — | false | Pretty-print output |

**Output**: `{"status":"success","evidence":{"baselineTestedAt":"...","baselineFlakyTests":[...],"stressLoopRuns":20,"stressLoopPassed":true,...},...}`

### Dual-Stage Verification Flow

When `--assertion` is provided, the CLI runs two phases:

1. **Pre-fix**: Execute `--pre-fix-cmd` (or `--test-cmd`) and capture the failing assertion output as a baseline
2. **Post-fix**: Run `--test-cmd` in a stress loop (default 20 iterations) and verify clean execution

The dual-stage result appears in `evidence.dualStage` in the output.

### Without Dual-Stage

When no `--assertion` is provided, the CLI only runs comprehensive evidence metrics: flaky test baseline, handle leak checks, and stress loop pass/fail.

---

## LLM Agent Tips

- Always provide `--assertion` when you have a known failing condition — this produces the strongest evidence for PR justification.
- Use `--run-id` to let the CLI auto-resolve the workspace path and baseline SHA from the run session, reducing the chance of manual path errors.
- If tests are slow, reduce `--stress-loop` (minimum 5 for dual-stage, default 20 for single-stage).
