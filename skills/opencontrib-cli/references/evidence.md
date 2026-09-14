# Evidence Command & Adaptive Verification

Dual-stage empirical verification: a mandatory RED baseline (failing test + failure assertion) captured **before** the fix, then a GREEN run **after** the fix that must prove the source tree actually changed. A passing test alone (GREEN without a verified RED) does NOT advance the run to `EVIDENCE_COLLECTED`.

The `evidence` command exposes three subcommands:

| Subcommand | Purpose |
| :--- | :--- |
| `evidence run` | One-shot dual-stage verification (baseline + post-fix stress loop) in a single invocation |
| `evidence capture-red` | Capture an immutable RED baseline (failing test + source-tree hash) **before** applying the fix |
| `evidence verify-green` | Run the GREEN check, bind it to the captured RED, and advance to `EVIDENCE_COLLECTED` only when verified |

---

## Recommended flow: `capture-red` → fix → `verify-green`

```bash
# 1. Before the fix: capture the failing baseline and bind the source tree hash
opencontrib evidence capture-red \
  --cwd /path/to/workspace \
  --test-cmd "bun test src/specific.test.ts" \
  --assertion "<expected failure regex>" \
  --run-id "$RUN_ID"

# 2. Apply the fix

# 3. After the fix: verify GREEN against the captured RED (advances to EVIDENCE_COLLECTED when verified)
opencontrib evidence verify-green \
  --cwd /path/to/workspace \
  --test-cmd "bun test src/specific.test.ts" \
  --run-id "$RUN_ID"
```

`verify-green` only reports a verified reproduction when the RED assertion matched, the source tree changed, and the GREEN run passes.

---

## One-shot: `evidence run`

```bash
# Standard empirical verification (targeted 1x clean run)
opencontrib evidence run \
  --cwd /path/to/workspace \
  --test-cmd "bun test src/specific.test.ts" \
  --run-id "$RUN_ID"

# For concurrency / race condition / flaky bug fixes (optional stress loop & parallel workers)
opencontrib evidence run \
  --cwd /path/to/workspace \
  --test-cmd "go test -v ./pkg/redis/..." \
  --concurrency 5 \
  --stress-loop 5 \
  --run-id "$RUN_ID"
```

| Flag | Type | Required | Default | Description |
| :--- | :--- | :---: | :---: | :--- |
| `--cwd` | string | — | Active Session | Workspace directory to run tests in (auto-resolved from active session) |
| `--test-cmd` | string | ✓ | — | Targeted test command (e.g. `go test ./pkg/...`, `bun test ...`) |
| `--concurrency` | number | — | `1` | Concurrent worker threads (use $>1$ only for race/concurrency tests) |
| `--stress-loop` | number | — | `1` | Stress loop iterations (use $>1$ only for concurrency/flaky tests) |
| `--pre-fix-cmd` | string | — | same as `--test-cmd` | Separate command to trigger pre-fix failure |
| `--assertion` | string | — | — | Regex for expected failure before fix |
| `--workspace-root` | string | — | — | Root workspace for security boundary |
| `--baseline-sha` | string | — | — | Baseline commit SHA before changes |
| `--run-id` | string | — | Active Session | Auto-resolved from active session if omitted |
| `--pretty` | flag | — | false | Pretty-print output |

For `capture-red`, add `--assertion` to match the expected failure. For `verify-green`, the RED baseline is read from the same `--run-id`.

---

## ⚡ Adaptive Verification Principles

- **Deterministic Bug (Logic/Types/Bounds/Null)**: A single targeted regression test run (`--stress-loop 1`) is standard and sufficient. Do NOT run unnecessary 20x loops for simple bug fixes.
- **Concurrency & Race Conditions**: For mutex, goroutine leak, or cache stampede fixes, pass `--concurrency 5` and `--stress-loop 5` to prove stability under contention.
- **Dual-Stage Anchoring**: Use `--assertion` to mathematically prove pre-fix failure (RED) $\rightarrow$ post-fix pass (GREEN).
