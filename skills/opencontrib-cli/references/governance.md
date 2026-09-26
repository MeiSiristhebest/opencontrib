# Governance Commands

Commands for patch quality auditing, impact analysis, CI diagnosis, and PR template rendering.

## `governance audit`

Audit a patch for anti-AI patterns, diff size limits, markdown encoding integrity (\uFFFD check), and quality confidence rubric.

```bash
opencontrib governance audit \
  --patch diff.txt \
  --pr-title "Fix null pointer in parser" \
  --pr-body-file pr_body.md \
  --evidence '{"stressLoopPassed":true,"passedTestsCount":42}' \
  --subagent-score 85 \
  --is-autonomous
```

| Flag                            | Type   | Required | Description                                                                                                    |
| ------------------------------- | ------ | -------- | -------------------------------------------------------------------------------------------------------------- |
| `--patch`                       | string | ✓        | Git unified diff content or path to diff file                                                                  |
| `--pr-title`                    | string | ✓        | Proposed PR title                                                                                              |
| `--pr-body`                     | string | —        | Proposed PR body text                                                                                          |
| `--pr-body-file`                | string | —        | Path to clean markdown file (prevents shell escaping corruption)                                               |
| `--evidence`                    | string | —        | JSON evidence from `evidence` command                                                                          |
| `--evidence-file`               | string | —        | Path to schema-validated evidence JSON (standalone diagnostic input; only tracked runs are canonical)          |
| `--subagent-score`              | number | —        | External review score (0-100)                                                                                  |
| `--require-coverage`            | flag   | —        | Fail closed unless measured changed-code coverage satisfies the repository policy                              |
| `--coverage-minimum`            | number | —        | Minimum changed-code coverage percentage (trusted repository default for tracked runs; 85 advisory standalone) |
| `--require-resource-leak-check` | flag   | —        | Fail closed unless trusted resource/handle leak evidence passes                                                |
| `--run-id`                      | string | —        | Run ID (auto-resolved from active session if omitted)                                                          |
| `--is-autonomous`               | flag   | —        | Mark as autonomous PR submission                                                                               |
| `--pretty`                      | flag   | —        | Pretty-print output                                                                                            |

> [!CAUTION]
> **Exit Code 2 (GATED_BLOCKED)**: If the quality score $<90\%$ or any dimension $<80\%$, `governance audit` terminates with **Exit Code 2** and blocks PR creation. Agents cannot waive a failed technical gate; any exception must be issued by a trusted host authority.

Coverage and resource-leak checks are repository-sensitive. Enable them with `--require-coverage` and/or `--require-resource-leak-check`; `UNAVAILABLE` never satisfies an enabled policy.

**Output**: `{"status":"passed","audit":{"overallConfidence":{...},"markdownIntegrityPassed":true,"rfcGatePassed":true,...}}` or `{"status":"failed",...}`

---

## `governance impact`

Analyze a patch for cross-platform anti-patterns and identify overlooked sibling files.

```bash
opencontrib governance impact \
  --patch diff.txt \
  --modified-files src/Parser.ts,src/Serializer.ts \
  --repo-context src/Parser.ts,src/Serializer.ts,src/Buffer.ts
```

**Output**: `{"status":"compliant","analysis":{...}}` or `{"status":"warnings_found",...}`

---

## `governance ci-diagnose`

Parse raw CI logs to extract exact failing test names, line numbers, and root causes.

```bash
# From stdin (pipe)
cat build.log | opencontrib governance ci-diagnose

# From file
opencontrib governance ci-diagnose --log-file build.log
```

**Output**: `{"status":"failure_detected","report":{"hasFailure":true,...}}` or `{"status":"healthy",...}`

---

## `governance pr-template`

Render a clean PR description following target repo template or the Master 6-Tier standard.

```bash
opencontrib governance pr-template \
  --issue 42 \
  --issue-title "Fix null pointer in parser" \
  --summary "Added null check on input validation in Parser module" \
  --validation-cmd "npm test" \
  --validation-output "5 tests passed, 0 failed" \
  --key-changes "fixed null check,added regression test" \
  --confidence 92 \
  --risk LOW \
  --is-docs-only
```

| Flag                  | Type            | Required | Description                                                                                     |
| --------------------- | --------------- | -------- | ----------------------------------------------------------------------------------------------- |
| `--issue`             | string          | ✓        | Issue number                                                                                    |
| `--issue-title`       | string          | ✓        | Issue title                                                                                     |
| `--summary`           | string          | ✓        | Concise fix summary                                                                             |
| `--validation-cmd`    | string          | —        | Optional user-provided validation note; never a verified claim without a tracked EvidenceReport |
| `--validation-output` | string          | —        | Optional user-provided output note; never treated as test evidence                              |
| `--key-changes`       | list            | —        | Comma-separated key changes                                                                     |
| `--confidence`        | number          | —        | Quality confidence score (0-100)                                                                |
| `--risk`              | LOW/MEDIUM/HIGH | —        | Risk tier (default: `MEDIUM`)                                                                   |
| `--native-template`   | string          | —        | Repo PR template markdown                                                                       |
| `--is-docs-only`      | flag            | —        | Documentation-only change                                                                       |
| `--ai-disclosure`     | flag            | —        | AI disclosure required                                                                          |
| `--run-id`            | string          | —        | Run ID (defaults to the active session; canonical evidence is loaded when present)              |
| `--pretty`            | flag            | —        | Pretty-print output                                                                             |

**Output**: `{"status":"success","prBody":"### Problem Description\nFixes #<canonical IssueBinding ID>\n..."}` for the public route, or a private security-disclosure reference without a public Issue for the private route.

---

## Review & Community Protocols

### 1. Bot Review Handling

- Automated bots (`[bot]` in author username, e.g. `coderabbitai[bot]`, `codecov[bot]`):
  - Do **not** post conversational reply comments.
  - Implement requested improvements in code, then `git push`. The bot will update checkmarks automatically on the next CI trigger.
- Human reviewers:
  - Respond concisely and politely in the review thread addressing specific design choices or technical points.

### 2. Proactive Claim Template

When creating an issue for an unfiled bug, post a claim statement:

```markdown
I have investigated this issue and have a reproducible test case and fix ready.
Please assign this issue to me, I will submit a PR shortly.
```

---

## LLM Agent Tips

- `governance audit` reads the patch diff as a file or inline string (`--patch diff.patch` or `--patch "$(cat diff.patch)"`).
- `governance ci-diagnose` is designed for large raw logs — always pipe or use `--log-file` rather than inline content.
- `governance pr-template` output is Markdown — save it as the canonical `pr_draft`, then request trusted approval and submit through OpenContrib:

```bash
opencontrib governance pr-template \
  --issue 42 \
  --issue-title "Fix null pointer in parser" \
  --summary "Add defensive boundary check to prevent parser panic" \
  | jq -r '.prBody' > pr-body.md
opencontrib governance request-approval --run-id "$RUN_ID"
opencontrib submission submit --run-id "$RUN_ID"
```

<!-- OPENCONTRIB:GENERATED protocol:start -->
## Canonical OpenContrib Protocol (generated)

- **Run anchor (first)**: `opencontrib run create --repo <owner/repo> [--issue <id>]` / `contrib_create_run`; no scouting, workspace preparation, or source edits before a runId exists.
- **Workspace and evidence**: `opencontrib workspace prepare --repo <owner/repo> --issue <issue-or-task-id>` / `contrib_prepare_workspace`; PoC (contrib_verify_poc) is optional and never replaces authoritative RED via contrib_capture_red.
- **RED → PATCH → GREEN**: run contrib_capture_red first, then save the patch through contrib_save_artifact, and verify GREEN through contrib_verify_green; PATCH_DRAFTED is invalid without RED.
- **Routing and governance**: public vulnerabilities require a provider-verified IssueBindingArtifact; private vulnerability policy requires a provider-verified SecurityDisclosureArtifact and public-fix authorization, with no public Issue route. Use a non-public task identifier when preparing a private-work workspace.
- **PR draft**: while still in EVIDENCE_COLLECTED, create and persist immutable pr_draft with opencontrib governance pr-template --run-id <run_id> --issue-title "<title>" --summary "<summary>" / contrib_render_pr_template; private security drafts must omit public Issue references. Then run opencontrib governance audit --run-id <run_id> --pr-title "<title>" → opencontrib governance request-approval --run-id <run_id> → opencontrib submission submit; MCP order is contrib_render_pr_template → contrib_audit_governance → contrib_request_approval → contrib_submit_pr / SubmissionPort.
- Do not write Pull Requests through raw GitHub CLI, GitHub MCP, or GitHub API operations; they bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.
<!-- OPENCONTRIB:GENERATED protocol:end -->
