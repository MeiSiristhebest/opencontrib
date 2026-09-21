# Proactive 0-Day Discovery & Contribution Workflow (Track A)

Use Track A when the user asks to "audit", "find deep-water bugs", "scan repository", or "proactively contribute to an open-source project".

---

## The 9-Phase Autonomous Pipeline

```text
[Phase 1: Initialize Run & Doctor Audit]
        │
        ▼
[Phase 2: Multi-Probe Scan & Fingerprinting]
        │
        ▼
[Phase 3: Smart Pointer Triage & Selection]
        │
        ▼
[Phase 4: Clean-Room Worktree Sandbox]
        │
        ▼
[Phase 5: Fail-First Reproduction (RED)]
        │
        ▼
[Phase 6: Surgical Fix & Evidence (GREEN)]
        │
        ▼
[Phase 7: Governance Quality & Markdown Audit]
        │
        ▼
[Phase 8: Issue-First Registration & PR Submission]
        │
        ▼
[Phase 9: Sync Profile & Memory Flywheel]
```

---

## Step-by-Step Command Execution

### Phase 1: Initialize Run Session

```bash
opencontrib doctor --pretty
opencontrib run create --repo <owner>/<repo> --issue <issue_number> --title "<title>" --pretty
```

> [!NOTE]
> `run create` initializes the **Active Session** at `~/.opencontrib/active_session.json`. All subsequent commands automatically inherit this `runId` and tracking context without requiring `--run-id` manually.

---

### Phase 2: Run Multi-Probe SAST & Fingerprint Analysis

Execute `opencontrib probe run` to trigger matching language analyzers:

```bash
opencontrib probe run ./<repo_dir> --limit 5 --pretty
```

- **Output**: Triaged Top-K Smart Pointers (`ptr://...`), categorized by defect archetype (e.g. `lifecycle_leak`, `protocol_drift`, `concurrency_race`).
- **Next Step**: Follow the `▶ NEXT RECOMMENDED COMMAND` output by the CLI.

> [!CAUTION]
> **Track A Isolation Rule**: During proactive 0-day auditing, you are strictly **code-driven**. Defects MUST be discovered through probe scan results and source code analysis only. **NEVER** execute:
>
> - `opencontrib scout` (Track B only — reactive issue scouting)
> - `gh issue list` / `gh issue view` (Track B only — browsing existing issues)
> - `opencontrib discovery qualify` / `opencontrib discovery rank` (Track B only)
>
> Running these commands during Track A wastes API calls and fundamentally changes the contribution from "proactive deep-water bug discovery" to "cherry-picking easy existing issues" — which is NOT what the user requested.

### Phase 3: Dereference Smart Pointer & Context Assembly

Inspect the top Smart Pointer finding using progressive dereferencing:

```bash
# Level 1: View stub metadata
opencontrib pointer list

# Level 2: Inspect code slice (~150 tokens)
opencontrib pointer resolve ptr://<namespace>/<defect_id>/<file>:<line> --view slice

# Level 3: View full proof evidence
opencontrib pointer resolve ptr://<namespace>/<defect_id>/<file>:<line> --view evidence
```

---

### Phase 4: Prepare Clean-Room Worktree Sandbox

Create an isolated git worktree for the contribution run (automatically bound to the active session):

```bash
opencontrib workspace prepare \
  --repo <owner>/<repo> \
  --issue <issue_number>
```

- **Capture**: The returned `workspacePath` is automatically registered to the active session.

---

### Phase 5: Construct Minimal Failing Test Case (RED Phase)

Write a targeted regression test inside the workspace. Execute **ONLY the targeted package or test file** to observe the pre-fix failure:

```bash
# For Go:
go test -v ./path/to/pkg/... -run TestSpecificDefect

# For TypeScript / JavaScript:
bun test packages/core/tests/specific.test.ts

# For Python:
pytest tests/test_specific.py -k test_defect
```

> [!IMPORTANT]
> **Subsystem Isolation**: Never run un-isolated full repo tests (`go test ./...` or `npm test` at repo root) to avoid upstream flaky test interference.

---

### Phase 6: Implement Surgical Fix & Empirical Evidence (GREEN Phase)

Apply the minimal, idiomatic code modification (strictly $\le 100$ lines). Then run targeted evidence verification:

```bash
# Preferred RED→GREEN flow (required to advance to EVIDENCE_COLLECTED):
opencontrib evidence capture-red --test-cmd "<targeted_test_command>" --assertion "<failure_regex>"
# ... apply the fix ...
opencontrib evidence verify-green --test-cmd "<targeted_test_command>"

# For concurrency / race / flaky defects, pass --concurrency and --stress-loop
# to the canonical verify-green command; do not use diagnostic evidence run for a canonical phase transition.
```

- **Auto-Sync**: `--cwd` and `--run-id` are automatically resolved from the active session.

---

### Phase 7: Governance Quality & Markdown Integrity Audit

Verify RFC-100 line limit, anti-AI linting, and 7D quality rubric:

```bash
opencontrib governance audit \
  --patch diff.patch \
  --pr-title "fix(<subsystem>): <concise fix description>" \
  --pr-body-file pr_body.md \
  --is-autonomous \
  --pretty
```

> [!CAUTION]
> **Hard Quality Gate (Exit Code 2)**:
> If the Governance Quality score is $<90\%$ or any dimension is $<80\%$, the CLI prints `🛑 GATED_BLOCKED` and **exits with Code 2**. You MUST fix the quality issues before proceeding to PR submission. Agents cannot waive a failed technical gate; exceptions require a trusted host authority artifact.

---

### Phase 8: Mandatory Issue-First Registration & PR Submission

Before opening a PR, publicly register the bug in GitHub Issues with an idiomatic Claim statement:

```bash
# 1. Generate Claim statement / Issue draft
opencontrib governance claim \
  --issue <issue_number> \
  --title "[Bug]: <Precise Defect Title>" \
  --finding "Root cause in <file>:<line>" \
  --pretty

# 2. Use native write_to_file tool to create issue_body.md, then create GitHub issue
gh issue create \
  --repo <owner>/<repo> \
  --title "[Bug]: <Precise Defect Title>" \
  --body-file issue_body.md

# 3. Render PR template and submit PR (auto-saves pr_draft to active run)
opencontrib governance pr-template \
  --issue <new_issue_id> \
  --issue-title "<Precise Defect Title>" \
  --summary "<Concise explanation of the surgical fix>" \
  --validation-cmd "<targeted_test_command>" \
  --validation-output "User-provided note only; canonical EvidenceReport is required for verified claims"

opencontrib governance request-approval --run-id "$RUN_ID"
opencontrib submission submit --run-id "$RUN_ID"
```

---

### Phase 9: Sync Profile & Memory Flywheel

Record the in-flight or completed contribution in local ledger memory:

```bash
cat <<JSON | opencontrib flywheel sync --repo <owner>/<repo>
{
  "status": "submitted",
  "techStack": ["typescript"],
  "prNumber": <pr_number>,
  "issueNumber": <issue_number>,
  "issueTitle": "<Precise Defect Title>"
}
JSON
```

- Advances the active session to `COMPLETED`.

---

## Resume a Paused Pipeline

If the process was interrupted, resume from where it left off (auto-resolves active session if ID is omitted):

```bash
opencontrib run resume
# → Output includes suggestedNextAction and availableArtifacts
```

## Error Recovery

```bash
# Inspect what artifacts exist in current session
opencontrib run get

# If workspace was purged, recreate it
opencontrib workspace prepare --repo facebook/react --issue 42

# If evidence was lost, re-run the RED→GREEN cycle from the patch phase
opencontrib evidence capture-red --test-cmd "bun test" --assertion "<failure_regex>" && opencontrib evidence verify-green --test-cmd "bun test"
```

<!-- OPENCONTRIB:GENERATED protocol:start -->
## Canonical OpenContrib Protocol (generated)

- **Run anchor (first)**: `opencontrib run create --repo <owner/repo> [--issue <id>]` / `contrib_create_run`; no scouting, workspace preparation, or source edits before a runId exists.
- **Workspace and evidence**: `opencontrib workspace prepare --repo <owner/repo> --issue <id>` / `contrib_prepare_workspace`; PoC (contrib_verify_poc) is optional and never replaces authoritative RED via contrib_capture_red.
- **RED → PATCH → GREEN**: run contrib_capture_red first, then save the patch through contrib_save_artifact, and verify GREEN through contrib_verify_green; PATCH_DRAFTED is invalid without RED.
- **Governance and submission**: opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>" → opencontrib governance audit --run-id <run_id> --pr-title "<title>" → opencontrib governance request-approval --run-id <run_id> → opencontrib submission submit; MCP equivalents end at contrib_submit_pr / SubmissionPort.
- Do not write Pull Requests through raw GitHub CLI, GitHub MCP, or GitHub API operations; they bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.
<!-- OPENCONTRIB:GENERATED protocol:end -->
