# Flywheel Commands

Commands for profile flywheel persistence, PR lifecycle tracking, and environment diagnostics.

## `doctor`

Audit the host environment health (Git, Node/Bun, Docker, WSL, storage).

```bash
opencontrib doctor
opencontrib doctor --pretty
```

**Output**: `{"status":"success","report":{"overallHealth":"DEGRADED","checks":[...],"environment":{...}}}`

---

## `flywheel sync`

Persist completed or in-flight contribution memory, update developer skill weights, and refine repository heuristics.

```bash
cat <<'JSON' | opencontrib flywheel sync --repo facebook/react
{
  "runId": "run_20260819195606_a_b_issue_1_umpc",
  "status": "merged",
  "techStack": ["typescript", "react"],
  "qualityRubricScore": 88,
  "prNumber": 42,
  "issueNumber": 42,
  "failureLessons": "Parser module needs defensive null checks on all external inputs"
}
JSON
```

**Input fields**: `status` and `techStack` (required); `runId` (optional, auto-resolved from active session); `prNumber`, `issueNumber`, `failureLessons`.

**Output**: `{"status":"success","flywheelResult":{...}}`

---

## `flywheel pr-track`

Track PR merge readiness, CI check runs, review feedback, and suggest the next action.

```bash
cat <<'JSON' | opencontrib flywheel pr-track
{
  "pr": {
    "number": 42,
    "state": "open",
    "merged": false,
    "mergeable": true,
    "draft": false,
    "headSha": "abc123..."
  },
  "reviews": [
    {"id": 1, "user": {"login": "reviewer1"}, "state": "APPROVED", "body": "Looks good"}
  ],
  "checkRuns": [
    {"id": 100, "name": "CI", "status": "completed", "conclusion": "success"}
  ],
  "comments": []
}
JSON
```

**Output**: `{"status":"success","evaluation":{...}}`

---

## LLM Agent Tips

- `doctor` is the fastest command — run it at the start of any session to verify the environment is healthy before doing expensive operations.
- `flywheel sync` should be called at the end of every completed contribution run to build up the developer profile over time.
- `flywheel pr-track` expects data from `gh pr view --json` output — adapt field names accordingly.
