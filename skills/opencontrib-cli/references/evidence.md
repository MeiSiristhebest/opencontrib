# Evidence Command & Adaptive Verification

Dual-stage empirical verification: pre-fix failure baseline assertion, regression test execution, and optional concurrency stampede chaos testing for race conditions.

---

## `evidence`

```bash
# Standard empirical verification (targeted 1x clean run)
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "bun test src/specific.test.ts" \
  --run-id "$RUN_ID"

# For concurrency / race condition / flaky bug fixes (optional stress loop & parallel workers)
opencontrib evidence \
  --cwd /path/to/workspace \
  --test-cmd "go test -v ./pkg/redis/..." \
  --concurrency 5 \
  --stress-loop 5 \
  --run-id "$RUN_ID"
```

| Flag | Type | Required | Default | Description |
| :--- | :--- | :---: | :---: | :--- |
| `--cwd` | string | ✓ | — | Workspace directory to run tests in |
| `--test-cmd` | string | ✓ | — | Targeted test command (e.g. `go test ./pkg/...`, `bun test ...`) |
| `--concurrency` | number | — | `1` | Concurrent worker threads (use $>1$ only for race/concurrency tests) |
| `--stress-loop` | number | — | `1` | Stress loop iterations (use $>1$ only for concurrency/flaky tests) |
| `--pre-fix-cmd` | string | — | same as `--test-cmd` | Separate command to trigger pre-fix failure |
| `--assertion` | string | — | — | Regex for expected failure before fix |
| `--workspace-root` | string | — | — | Root workspace for security boundary |
| `--baseline-sha` | string | — | — | Baseline commit SHA before changes |
| `--run-id` | string | — | — | Auto-resolve workspace from run session |
| `--pretty` | flag | — | false | Pretty-print output |

---

## ⚡ Adaptive Verification Principles

- **Deterministic Bug (Logic/Types/Bounds/Null)**: A single targeted regression test run (`--stress-loop 1`) is standard and sufficient. Do NOT run unnecessary 20x loops for simple bug fixes.
- **Concurrency & Race Conditions**: For mutex, goroutine leak, or cache stampede fixes, pass `--concurrency 5` and `--stress-loop 5` to prove stability under contention.
- **Dual-Stage Anchoring**: Use `--assertion` to mathematically prove pre-fix failure (RED) $\rightarrow$ post-fix pass (GREEN).
