# Governance Commands

Commands for patch quality auditing, impact analysis, CI diagnosis, and PR template rendering.

## `governance audit`

Audit a patch for anti-AI patterns, diff size limits, and quality confidence rubric.

```bash
opencontrib governance audit \
  --patch diff.txt \
  --pr-title "Fix null pointer in parser" \
  --pr-body "Root cause: missing null check on input validation..." \
  --evidence '{"stressLoopPassed":true,"passedTestsCount":42}' \
  --subagent-score 85 \
  --is-autonomous
```

| Flag | Type | Required | Description |
| ------ | ------ | ---------- | ------------- |
| `--patch` | string | ✓ | Git unified diff content |
| `--pr-title` | string | ✓ | Proposed PR title |
| `--pr-body` | string | ✓ | Proposed PR body text |
| `--evidence` | string | — | JSON evidence from `evidence` command |
| `--subagent-score` | number | — | External review score (0-100) |
| `--is-autonomous` | flag | — | Mark as autonomous PR submission |
| `--pretty` | flag | — | Pretty-print output |

**Output**: `{"status":"passed","audit":{"overallConfidence":{...},"rfcGatePassed":true,...}}` or `{"status":"failed",...}`

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

| Flag | Type | Required | Description |
| ------ | ------ | ---------- | ------------- |
| `--issue` | string | ✓ | Issue number |
| `--issue-title` | string | ✓ | Issue title |
| `--summary` | string | ✓ | Concise fix summary |
| `--validation-cmd` | string | ✓ | Test command used |
| `--validation-output` | string | ✓ | Test output excerpt |
| `--key-changes` | list | — | Comma-separated key changes |
| `--confidence` | number | — | Quality confidence score (0-100) |
| `--risk` | LOW/MEDIUM/HIGH | — | Risk tier |
| `--native-template` | string | — | Repo PR template markdown |
| `--is-docs-only` | flag | — | Documentation-only change |
| `--ai-disclosure` | flag | — | AI disclosure required |
| `--pretty` | flag | — | Pretty-print output |

**Output**: `{"status":"success","prBody":"### Problem Description\nFixes #42\n..."}`

---

## LLM Agent Tips

- `governance audit` reads the patch diff as a string — use `$(cat diff.txt)` or stdin for large diffs.
- `governance ci-diagnose` is designed for large raw logs — always pipe or use `--log-file` rather than `--input` with inline content.
- `governance pr-template` output is Markdown — pipe directly into a file for use with `gh pr create --body-file`:

```bash
opencontrib governance pr-template --issue 42 --summary "Fix" \
  --validation-cmd "npm test" --validation-output "passed" \
  | jq -r '.prBody' > pr-body.md
gh pr create --body-file pr-body.md
```
