# Proactive 0-Day Discovery & Contribution Workflow (Track A)

Use Track A when the user asks to "audit", "find deep-water bugs", "scan repository", or "proactively contribute to an open-source project".

---

## The 8-Step Autonomous Pipeline

```text
[Step 1: Multi-Probe Scan]
        │
        ▼
[Step 2: Smart Pointer Selection]
        │
        ▼
[Step 3: Clean-Room Worktree]
        │
        ▼
[Step 4: Fail-First Reproduction (RED)]
        │
        ▼
[Step 5: Surgical Fix & Evidence (GREEN)]
        │
        ▼
[Step 6: Governance Quality Audit]
        │
        ▼
[Step 7: Issue-First Registration]
        │
        ▼
[Step 8: Render PR Template & Submit PR]
```

---

## Step-by-Step Command Execution

### Step 1: Run Multi-Probe SAST & Hotspot Analysis
Execute `opencontrib probe run` to trigger all matching language analyzers (Semgrep, ast-grep, NilAway, GoLeak, Knip, Ruff, Cargo Deny, Git Churn Forensics).

```bash
opencontrib probe run ./<repo_dir> --pretty
```
- **Output**: Ranked list of Smart Pointers (`ptr://<hash>`), categorized by defect archetype (e.g. `lifecycle_leak`, `protocol_drift`, `concurrency_race`).

---

### Step 2: Dereference Smart Pointer & Select Target Defect
Inspect the top Smart Pointer finding using 3-level progressive dereferencing:

```bash
# Level 2: Inspect 150-token code slice directly (no manual file searching)
opencontrib pointer resolve ptr://findings/<pointer_id> --view slice

# Level 3: View full AST trace or PoC harness if needed
opencontrib pointer resolve ptr://findings/<pointer_id> --view evidence
```

---

### Step 3: Prepare Clean-Room Worktree Sandbox
Create an isolated git worktree for the contribution run:

```bash
opencontrib workspace prepare \
  --repo <owner>/<repo> \
  --issue 0 \
  --run-id "run_$(date +%s)"
```
- **Capture**: Save the returned `workspacePath` for all subsequent operations.

---

### Step 4: Construct Minimal Failing Test Case (RED Phase)
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

### Step 5: Implement Surgical Fix & Concurrency Stampede Evidence (GREEN Phase)
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

### Step 6: Sister-Module Variant Sweep & Governance Audit
Sweep adjacent structs in the same directory (In-Domain Deep Defense), then verify governance:

```bash
# Verify RFC-100 line limit, anti-AI linting, and 7D quality rubric
git -C "<workspacePath>" diff | opencontrib governance audit \
  --line-count 50 \
  --subagent-score 95
```

---

### Step 7: Mandatory Issue-First Registration (Create Issue BEFORE PR)
Before opening a PR, publicly register the bug in GitHub Issues with an idiomatic Claim statement:

```bash
# 1. Write issue description to a local markdown file
cat << 'EOF' > issue_body.md
### Description
<Clear technical description of the defect, impact, and reproduction steps>

### Reproduction
```
<Targeted test failure trace>
```

### Claim Statement
I have reproduced this issue with a targeted test case and have an idiomatic fix prepared. Please assign this to me, I will submit a PR shortly.
EOF

# 2. Create the GitHub Issue using --body-file
gh issue create \
  --repo <owner>/<repo> \
  --title "[Bug]: <Precise Defect Title>" \
  --body-file issue_body.md
```
- **Capture**: Note the newly created Issue number `#<new_issue_id>`.

---

### Step 8: Render Native PR Template & Submit Pull Request
Generate a maintainer-aligned PR body linking `Fixes #<new_issue_id>` and submit the PR:

```bash
opencontrib governance pr-template \
  --issue <new_issue_id> \
  --issue-title "<Precise Defect Title>" \
  --summary "<Concise explanation of the surgical fix>" \
  --validation-cmd "<targeted_test_command>" \
  --validation-output "20/20 stress loops passed" > pr_body.md

gh pr create \
  --repo <owner>/<repo> \
  --title "fix(<subsystem>): <concise fix description>" \
  --body-file pr_body.md \
  --draft
```

---

### Step 9: Sync Profile & Memory Flywheel
Record the in-flight contribution in local ledger memory:

```bash
opencontrib flywheel sync --repo <owner>/<repo> --pr <pr_number>
```


### Phase 9: Sync Flywheel

```bash
printf '{"runId":"%s","status":"merged","techStack":["typescript","react"],"qualityRubricScore":88,"prNumber":%d,"issueNumber":42}' \
  "$RUN_ID" "$PR_NUMBER" | opencontrib flywheel sync --repo facebook/react
```

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
opencontrib evidence --cwd "$WORKSPACE" --test-cmd "npm test" --run-id "$RUN_ID"
```

## LLM Agent Tips

- Always pass `--run-id` to every command that supports it — it creates a traceable, resumable session.
- The pipeline is **phase-gated**: you cannot skip ahead. E.g., `governance audit` expects a patch artifact to exist in the run session.
- Use `run get` between phases to verify state before proceeding.
