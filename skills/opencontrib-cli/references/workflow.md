# 9-Phase Contribution Pipeline

OpenContrib's standard 9-phase Phase-Gated execution protocol, expressed as CLI commands. Each phase produces an artifact saved to the run session.

## Pipeline Overview

```text
Phase 1:  INITIALIZED          → run create
Phase 2:  OPPORTUNITY_SCOUTED  → scout + discovery rank
Phase 3:  CONTEXT_ASSEMBLED    → discovery context
Phase 4:  WORKSPACE_PREPARED   → workspace prepare
Phase 5:  PATCH_DRAFTED        → (external: agent writes patch)
Phase 6:  EVIDENCE_COLLECTED   → evidence
Phase 7:  GOVERNANCE_AUDITED   → governance audit
Phase 8:  PR_SUBMITTED         → governance pr-template + gh pr create
Phase 9:  COMPLETED            → flywheel sync
```

## Phase-by-Phase CLI Walkthrough

### Phase 1: Initialize Run

```bash
opencontrib run create \
  --repo facebook/react \
  --issue 42 \
  --title "Fix null pointer in parser" \
  --tags "bugfix,parser"
# → Capture the runId from output
```

### Phase 2: Scout & Qualify

```bash
opencontrib scout facebook/react --limit 5
# → Pick the top opportunity
# Then verify it's qualified:
cat issue-data.json | opencontrib discovery qualify
opencontrib discovery rank --input '...'
```

### Phase 3: Assemble Context

```bash
cat context-input.json | opencontrib discovery context
```

### Phase 4: Prepare Workspace

```bash
opencontrib workspace prepare \
  --repo facebook/react \
  --issue 42 \
  --run-id "$RUN_ID"
# → Capture workspacePath from output
```

### Phase 5: Write Patch (External)

The agent writes the patch in the workspace directory. This phase has no CLI command — it's the human/agent doing the actual coding work.

### Phase 6: Collect Evidence

```bash
opencontrib evidence \
  --cwd "$WORKSPACE_PATH" \
  --test-cmd "npm test" \
  --assertion "expect.*toFail" \
  --stress-loop 20 \
  --run-id "$RUN_ID"
```

### Phase 7: Governance Audit

```bash
DIFF=$(git -C "$WORKSPACE_PATH" diff)
printf '%s' "$DIFF" | opencontrib governance audit \
  --patch /dev/stdin \
  --pr-title "$PR_TITLE" \
  --pr-body "$PR_BODY"
```

### Phase 8: Submit PR

```bash
opencontrib governance pr-template \
  --issue 42 \
  --issue-title "Fix null pointer in parser" \
  --summary "Added null check on input validation" \
  --validation-cmd "npm test" \
  --validation-output "5 tests passed" \
  --key-changes "fixed null check,added regression test" \
  | jq -r '.prBody' > pr-body.md

gh pr create \
  --repo facebook/react \
  --title "$PR_TITLE" \
  --body-file pr-body.md \
  --draft
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
