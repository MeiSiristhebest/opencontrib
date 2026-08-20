# Workspace Commands

Commands for managing isolated Git worktree sandboxes.

## `workspace prepare`

Create an isolated Git worktree under `~/.opencontrib/workspaces/` for safe development without touching the main workspace.

```bash
opencontrib workspace prepare --repo microsoft/vscode --issue 12345

# With an existing local clone
opencontrib workspace prepare \
  --repo microsoft/vscode \
  --issue 12345 \
  --local-path /path/to/local/vscode

# Attach to a run session
opencontrib workspace prepare \
  --repo microsoft/vscode \
  --issue 12345 \
  --run-id run_20260819195606_a_b_issue_1_umpc
```

| Flag | Type | Required | Description |
| ------ | ------ | ---------- | ------------- |
| `--repo` | string | ✓ | Repository full name |
| `--issue` | string | ✓ | Issue number or task identifier |
| `--local-path` | string | — | Path to existing local repo clone |
| `--run-id` | string | — | Run ID for auto-saving workspace artifact |
| `--pretty` | flag | — | Pretty-print output |

**Output**: `{"status":"success","workspacePath":"...","branchName":"...","isWorktree":true,"baseCommitSha":"...",...}`

> **Important**: Always capture `workspacePath` from the output — it's the directory where you'll run tests and write patches.

---

## `workspace purge`

Remove all ephemeral worktrees, scratch scripts, and cached bare repos.

```bash
# Purge worktrees only
opencontrib workspace purge

# Also delete bare repo cache (~/.opencontrib/repos)
opencontrib workspace purge --clean-repos
```

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--clean-repos` | flag | false | Also delete bare repo cache |
| `--pretty` | flag | false | Pretty-print output |

---

## LLM Agent Tips

- `workspace prepare` without `--local-path` will clone the repo fresh — this is slower but guaranteed clean.
- Always pass `--run-id` if you're using run sessions, so the workspace path is saved as an artifact and can be auto-resolved by later commands like `evidence`.
- After `workspace purge`, any run that referenced the deleted workspace will have stale paths — use `run resume <runId>` to inspect before proceeding.
