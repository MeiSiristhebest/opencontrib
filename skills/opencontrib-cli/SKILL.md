---
name: opencontrib-cli
description: Use the `opencontrib-cli` CLI to execute the OpenContrib contribution engine — opportunity scouting, worktree sandbox management, evidence collection, governance auditing, and flywheel synchronization. Activate when the user mentions "opencontrib" or "contrib_", wants to scout GitHub issues, create worktree sandboxes, run dual-stage evidence verification, audit patches, or follow the 9-phase contribution pipeline via shell commands. Also triggers for LLM agents wanting zero-token-overhead access to the OpenContrib engine.
---

# OpenContrib CLI

The OpenContrib CLI (`opencontrib`) is the primary interface to the OpenContrib contribution engine. It provides 20 subcommands across 8 domains, all consuming and producing compact JSON. The CLI is the recommended interface for shell pipelines, LLM agents, and human operators alike.

## Installation

```bash
# One-shot (recommended for LLM agents — no install needed)
npx -y opencontrib-cli --help

# Global install
npm install -g opencontrib-cli
opencontrib --help

# Dev mode from repo
cd opencontrib
bun run cli --help
```

## Quick Reference

```
opencontrib doctor                                    # Environment health check
opencontrib scout <target> [options]                  # Discover contribution opportunities
opencontrib run create/get/resume/save                # Manage contribution sessions
opencontrib discovery {rank|qualify|feasibility|context|manifests}  # Opportunity scoring
opencontrib workspace {prepare|purge}                 # Git worktree sandbox management
opencontrib evidence [options]                        # Dual-stage empirical verification
opencontrib governance {audit|impact|ci-diagnose|pr-template}  # Patch quality
opencontrib flywheel {sync|pr-track}                  # Profile flywheel & PR tracking
```

## Core I/O Patterns

### Compact JSON by default

All commands output JSON to stdout. The default is single-line (best for pipelines):

```bash
opencontrib scout facebook/react --limit 3
# {"status":"success","target":"facebook/react","foundCount":3,"opportunities":[...]}
```

Add `--pretty` for indented output (best for debugging):

```bash
opencontrib doctor --pretty
```

### Complex inputs via `--input` or stdin

Commands that need structured JSON input accept it two ways:

```bash
# --input flag (simple, copy-paste friendly)
opencontrib discovery rank --input '{"issue":{"number":1,"title":"NPE"},...}'

# stdin pipe (best for LLM pipelines and scripts)
cat payload.json | opencontrib discovery rank
```

### Piping output

Compact JSON output is designed for shell pipelines:

```bash
# Extract top opportunity
opencontrib scout facebook/react --limit 5 | jq '.opportunities[0]'

# Run feasibility on first result
opencontrib scout bytedance --limit 1 | jq -r '.opportunities[0]' | \
  opencontrib discovery feasibility --input -
```

## LLM Agent Integration

### Why shell calls are efficient

The CLI requires **200-400 tokens** per invocation (single subcommand help text), compared to loading an entire tool schema registry upfront. For any agent that can execute shell commands, direct CLI calls are the efficient path — each call is self-contained, pipable, and requires no prior schema loading.

### Recommended invocation pattern

```
npx -y opencontrib-cli <command> <args>
```

Always use `npx -y` (not `npx`) to skip the interactive install prompt. No global install needed.

### Always use compact output

Never add `--pretty` in agent pipelines — the single-line JSON is smaller and parses identically. Use `jq` on the shell side for extraction.

### Stdin is your friend

When constructing large JSON inputs, pipe from a file or `printf` rather than using `--input` with inline JSON (shell quoting edge cases):

```bash
printf '{"issue":{"number":42,"title":"bug"}}' | opencontrib discovery qualify
```

## Command Categories

See `references/` for full documentation on each command domain:

| Domain | File | Covers |
| -------- | ------ | -------- |
| Discovery | [references/discovery.md](references/discovery.md) | `scout`, `discovery rank`, `qualify`, `feasibility`, `context`, `manifests` |
| Workspace | [references/workspace.md](references/workspace.md) | `workspace prepare`, `workspace purge` |
| Evidence | [references/evidence.md](references/evidence.md) | `evidence` |
| Governance | [references/governance.md](references/governance.md) | `governance audit`, `impact`, `ci-diagnose`, `pr-template` |
| Flywheel | [references/flywheel.md](references/flywheel.md) | `flywheel sync`, `pr-track`, `doctor` |
| Workflow | [references/workflow.md](references/workflow.md) | 9-phase CLI pipeline orchestration |

## Authentication

GitHub access is needed for `scout` and discovery commands that query GitHub API:

```bash
export GITHUB_TOKEN=your_token_here
# Or pass per-command:
opencontrib scout facebook/react --token $GITHUB_TOKEN
```

For PR-related commands (track, submit), the CLI uses the `gh` CLI auth automatically. Run `gh auth status` to verify.

## Common Patterns

### Pattern 1: Find and assess a single issue

```bash
opencontrib scout facebook/react --limit 5 --pretty
# → Pick an issue, then:
opencontrib discovery feasibility --title "$ISSUE_TITLE" --labels "$LABELS"
```

### Pattern 2: Full contribution pipeline

```bash
opencontrib run create --repo facebook/react --issue 42
opencontrib workspace prepare --repo facebook/react --issue 42 --run-id "$RUN_ID"
opencontrib evidence --cwd "$WORKSPACE" --test-cmd "npm test"
opencontrib governance audit --patch "$DIFF" --pr-title "$TITLE"
```

### Pattern 3: CI log diagnosis

```bash
cat build.log | opencontrib governance ci-diagnose
# Or with file:
opencontrib governance ci-diagnose --log-file build.log
```
