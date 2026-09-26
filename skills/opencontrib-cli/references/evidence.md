# Evidence Command & Adaptive Verification

Dual-stage empirical verification: a mandatory RED baseline (failing test + failure assertion) captured **before** the fix, then a GREEN run **after** the fix that must prove the source tree actually changed. A passing test alone (GREEN without a verified RED) does NOT advance the run to `EVIDENCE_COLLECTED`.

The `evidence` command exposes three subcommands:

| Subcommand              | Purpose                                                                                                  |
| :---------------------- | :------------------------------------------------------------------------------------------------------- |
| `evidence run`          | **Diagnostic-only compatibility mode**; it does not persist canonical Evidence V2 or advance a run       |
| `evidence capture-red`  | Capture an immutable RED baseline (failing test + source-tree hash) **before** applying the fix          |
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

## Diagnostic compatibility: `evidence run`

`evidence run` is retained for inspection and stress diagnostics only. It cannot
create the canonical Evidence V2 artifact or advance a contribution run. For a
canonical run, always use `capture-red` before the fix and `verify-green` after
the fix.

| Flag               | Type   | Required |       Default        | Description                                                                                  |
| :----------------- | :----- | :------: | :------------------: | :------------------------------------------------------------------------------------------- |
| `--cwd`            | string |    —     |    Active Session    | Workspace directory to run tests in (auto-resolved from active session)                      |
| `--test-cmd`       | string |    ✓     |          —           | Targeted test command (e.g. `go test ./pkg/...`, `bun test ...`)                             |
| `--concurrency`    | number |    —     |         `1`          | Workers started concurrently in each stress round (use $>1$ only for race/concurrency tests) |
| `--stress-loop`    | number |    —     |         `1`          | Number of stress rounds (use $>1$ only for concurrency/flaky tests)                          |
| `--pre-fix-cmd`    | string |    —     | same as `--test-cmd` | Separate command to trigger pre-fix failure                                                  |
| `--assertion`      | string |    —     |          —           | Regex for expected failure before fix                                                        |
| `--workspace-root` | string |    —     |          —           | Root workspace for security boundary                                                         |
| `--baseline-sha`   | string |    —     |          —           | Baseline commit SHA before changes                                                           |
| `--run-id`         | string |    —     |    Active Session    | Auto-resolved from active session if omitted                                                 |
| `--pretty`         | flag   |    —     |        false         | Pretty-print output                                                                          |

For `capture-red`, add `--assertion` to match the expected failure. For `verify-green`, the RED baseline is read from the same `--run-id`. The compatibility `evidence run` command is diagnostic-only and is not a substitute for this sequence.

### Stress execution semantics

Each round starts exactly `--concurrency` workers together. The requested execution count is:

```text
executionsExpected = stressLoopCount × concurrencyWorkers
```

For example, `--stress-loop 3 --concurrency 5` requests 15 executions in three rounds, with a maximum expected concurrency of five. A failed round completes its workers and stops later rounds; the evidence reports both requested and actual counts.

---

## ⚡ Adaptive Verification Principles

- **Deterministic Bug (Logic/Types/Bounds/Null)**: A single targeted regression test run (`--stress-loop 1`) is standard and sufficient. Do NOT run unnecessary 20x loops for simple bug fixes.
- **Concurrency & Race Conditions**: For mutex, goroutine leak, or cache stampede fixes, pass `--concurrency 5` and `--stress-loop 5` to prove stability under contention.
- **Dual-Stage Anchoring**: Use `--assertion` to mathematically prove pre-fix failure (RED) $\rightarrow$ post-fix pass (GREEN).

<!-- OPENCONTRIB:GENERATED protocol:start -->
## Canonical OpenContrib Protocol (generated)

- **Run anchor (first)**: `opencontrib run create --repo <owner/repo> [--issue <id>]` / `contrib_create_run`; no scouting, workspace preparation, or source edits before a runId exists.
- **Workspace and evidence**: `opencontrib workspace prepare --repo <owner/repo> --issue <issue-or-task-id>` / `contrib_prepare_workspace`; PoC (contrib_verify_poc) is optional and never replaces authoritative RED via contrib_capture_red.
- **RED → PATCH → GREEN**: run contrib_capture_red first, then save the patch through contrib_save_artifact, and verify GREEN through contrib_verify_green; PATCH_DRAFTED is invalid without RED.
- **Routing and governance**: public vulnerabilities require a provider-verified IssueBindingArtifact; private vulnerability policy requires a provider-verified SecurityDisclosureArtifact and public-fix authorization, with no public Issue route. Use a non-public task identifier when preparing a private-work workspace.
- **PR draft**: while still in EVIDENCE_COLLECTED, create and persist immutable pr_draft with opencontrib governance pr-template --run-id <run_id> --issue-title "<title>" --summary "<summary>" / contrib_render_pr_template; private security drafts must omit public Issue references. Then run opencontrib governance audit --run-id <run_id> --pr-title "<title>" → opencontrib governance request-approval --run-id <run_id> → opencontrib submission submit; MCP order is contrib_render_pr_template → contrib_audit_governance → contrib_request_approval → contrib_submit_pr / SubmissionPort.
- Do not write Pull Requests through raw GitHub CLI, GitHub MCP, or GitHub API operations; they bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.
<!-- OPENCONTRIB:GENERATED protocol:end -->
