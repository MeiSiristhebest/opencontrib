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
# Standard targeted verification (1x clean run):
opencontrib evidence \
  --test-cmd "<targeted_test_command>"

# Optional: For concurrency / race condition / flaky defects:
opencontrib evidence \
  --test-cmd "<targeted_test_command>" \
  --concurrency 5 \
  --stress-loop 5
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
> If the Governance Quality score is $<90\%$ or any dimension is $<80\%$, the CLI prints `🛑 GATED_BLOCKED` and **exits with Code 2**. You MUST fix the quality issues before proceeding to PR submission, or obtain explicit human approval with `--allow-unverified`.

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
  --validation-output "Targeted regression test passed cleanly (0 regressions)"

gh pr create \
  --repo <owner>/<repo> \
  --title "fix(<subsystem>): <concise fix description>" \
  --body-file pr_body.md
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

# If evidence was lost, re-run from the patch phase
opencontrib evidence --test-cmd "bun test"
```
"bun test" --run-id "$RUN_ID"
```
