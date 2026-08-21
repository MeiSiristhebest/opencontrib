# Evidence Command & Concurrency Stampede Fuzzing

Dual-stage empirical verification: pre-fix failure baseline, concurrency stampede chaos testing, and post-fix stress loop.

---

## `evidence`

```bash
# Standard empirical verification with concurrency stampede
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "bun test src/specific.test.ts" \
  --concurrency 10 \
  --stress-loop 20

# With dual-stage pre-fix assertion capture
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "bun test src/specific.test.ts" \
  --assertion "expect.*toFail" \
  --concurrency 10 \
  --stress-loop 20 \
  --run-id "$RUN_ID"
```

| Flag | Type | Required | Default | Description |
| :--- | :--- | :---: | :---: | :--- |
| `--cwd` | string | ✓ | — | Workspace directory to run tests in |
| `--test-cmd` | string | ✓ | — | Targeted test command (e.g. `go test ./pkg/...`, `bun test ...`) |
| `--concurrency` | number | — | `1` | Number of parallel concurrent stampede worker threads (e.g. `10`) |
| `--stress-loop` | number | — | `20` | Stress loop iterations |
| `--pre-fix-cmd` | string | — | same as `--test-cmd` | Separate command to trigger pre-fix failure |
| `--assertion` | string | — | — | Regex for expected failure before fix |
| `--workspace-root` | string | — | — | Root workspace for security boundary |
| `--baseline-sha` | string | — | — | Baseline commit SHA before changes |
| `--run-id` | string | — | — | Auto-resolve workspace from run session |
| `--pretty` | flag | — | false | Pretty-print output |

---

## ⚡ Concurrency Stampede & True Chaos Evidence

Unlike blind single-threaded re-runs, OpenContrib captures dynamic operational metrics under high contention:
- **`concurrencyWorkers`**: Parallel execution threads competing for shared resources.
- **`raceCollisionsDetected`**: Count of race conditions, deadlocks, or collision errors.
- **`latencyJitterMs`**: Execution timing variance across concurrent runs.
- **`zeroAssertionWarning`**: Flags if a test suite has 0 real assertions (rejecting fake pass results).

---

## LLM Agent Tips

- **Targeted Scope Only**: Always target the specific modified test file or sub-package. Never pass full-repo commands like `npm test` or `go test ./...`.
- **Concurrency Fuzzing**: For async collision, caching, or mutex fixes, always pass `--concurrency 10` to stress-test concurrent race conditions.
- **Dual-Stage Anchoring**: Use `--assertion` to mathematically prove pre-fix failure $\rightarrow$ post-fix pass.

