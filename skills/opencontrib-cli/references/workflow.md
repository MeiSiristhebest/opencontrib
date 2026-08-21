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
opencontrib run create --repo <owner>/<repo> --pretty
```

---

### Phase 2: Run Multi-Probe SAST & Fingerprint Analysis
Execute `opencontrib probe run` to trigger matching language analyzers:

```bash
opencontrib probe run ./<repo_dir> --limit 5 --pretty
```
- **Output**: Triaged Top-K Smart Pointers (`ptr://...`), categorized by defect archetype (e.g. `lifecycle_leak`, `protocol_drift`, `concurrency_race`).

---

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
Create an isolated git worktree for the contribution run:

```bash
opencontrib workspace prepare \
  --repo <owner>/<repo> \
  --issue 0 \
  --run-id "$RUN_ID"
```
- **Capture**: Save the returned `workspacePath` for all subsequent operations.

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

### Phase 6: Implement Surgical Fix & Concurrency Evidence (GREEN Phase)
Apply the minimal, idiomatic code modification (strictly $\le 100$ lines). Then run the bounded concurrency stampede harness:

```bash
opencontrib evidence \
  --cwd "<workspacePath>" \
  --test-cmd "<targeted_test_command>" \
  --concurrency 10 \
  --stress-loop 20 \
  --run-id "$RUN_ID"
```

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

---

### Phase 8: Mandatory Issue-First Registration & PR Submission
Before opening a PR, publicly register the bug in GitHub Issues with an idiomatic Claim statement:

```bash
# 1. Generate Claim statement / Issue draft
opencontrib governance claim \
  --issue 0 \
  --title "[Bug]: <Precise Defect Title>" \
  --finding "Root cause in <file>:<line>" \
  --pretty

# 2. Use native write_to_file tool to create issue_body.md, then create GitHub issue
gh issue create \
  --repo <owner>/<repo> \
  --title "[Bug]: <Precise Defect Title>" \
  --body-file issue_body.md

# 3. Render PR template and submit PR
opencontrib governance pr-template \
  --issue <new_issue_id> \
  --issue-title "<Precise Defect Title>" \
  --summary "<Concise explanation of the surgical fix>" \
  --validation-cmd "<targeted_test_command>" \
  --validation-output "20/20 stress loops passed"

gh pr create \
  --repo <owner>/<repo> \
  --title "fix(<subsystem>): <concise fix description>" \
  --body-file pr_body.md
```

---

### Phase 9: Sync Profile & Memory Flywheel
Record the in-flight or completed contribution in local ledger memory:

```bash
opencontrib flywheel sync \
  --repo <owner>/<repo> \
  --run-id "$RUN_ID" \
  --status "open" \
  --pr <pr_number> \
  --issue <issue_number>
```

---

## Resume a Paused Pipeline

If the process was interrupted, resume from where it left off:

```bash
opencontrib run resume "$RUN_ID"
# → Output includes suggestedNextAction and availableArtifacts
```

## Error Recovery

```bash
# Inspect what artifacts exist
opencontrib run get "$RUN_ID"

# If workspace was purged, recreate it
opencontrib workspace prepare --repo facebook/react --issue 42 --run-id "$RUN_ID"

# If evidence was lost, re-run from the patch phase
opencontrib evidence --cwd "$WORKSPACE" --test-cmd "bun test" --run-id "$RUN_ID"
```
