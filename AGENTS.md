# OpenContrib Agent Protocol (Codex / OpenAI Assistants)

This document provides system directives for OpenAI Codex, OpenAI Assistants, and generic autonomous coding agents utilizing the OpenContrib Engine.

## 🚀 Operational Directives

### 1. Workflow Orchestration

Execute open-source contribution tasks adhering to the 9-Phase OpenContrib Lifecycle. First create the tracked run anchor with `opencontrib run create --repo <owner/repo> --issue <id>`; no scouting, probing, or workspace work precedes it.

- **Scout / Probe:** `opencontrib scout <owner/repo>` or `opencontrib probe run [target]`
- **Context Assembly:** `opencontrib discovery context --input <json>`
- **Pointer Navigation:** `opencontrib pointer list` or `opencontrib pointer resolve <uri> --view slice`
- **Sandbox Workspace:** `opencontrib workspace prepare --repo <owner/repo> --issue <id>`
- **Evidence Verification (RED→GREEN):** capture the failing baseline with `opencontrib evidence capture-red --test-cmd "<test_cmd>" --assertion "<pattern>"`, apply the fix, then verify with `opencontrib evidence verify-green --test-cmd "<test_cmd>"`
- **Governance Audit:** `opencontrib governance audit --patch <file> --pr-title "<title>"`
- **PR Description:** `opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>"`
- **Flywheel Sync:** `opencontrib flywheel sync --repo <owner/repo>`

### 2. Constraints & Quality Invariants

- **No Hallucinated PRs:** Never write code or tests without running local verification inside the worktree sandbox.
- **RFC-100 Adherence:** Ensure all contributions pass anti-AI governance linting with a score >= 90 overall and >= 80 on all dimensions.
- **Issue-First Policy:** Always associate PRs with qualified issues (`Fixes #<id>`).

<!-- OPENCONTRIB:GENERATED protocol:start -->
## Canonical OpenContrib Protocol (generated)

- **Run anchor (first)**: `opencontrib run create --repo <owner/repo> [--issue <id>]` / `contrib_create_run`; no scouting, workspace preparation, or source edits before a runId exists.
- **Workspace and evidence**: `opencontrib workspace prepare --repo <owner/repo> --issue <id>` / `contrib_prepare_workspace`; PoC (contrib_verify_poc) is optional and never replaces authoritative RED via contrib_capture_red.
- **RED → PATCH → GREEN**: run contrib_capture_red first, then save the patch through contrib_save_artifact, and verify GREEN through contrib_verify_green; PATCH_DRAFTED is invalid without RED.
- **Governance and submission**: opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>" → opencontrib governance audit --run-id <run_id> --pr-title "<title>" → opencontrib governance request-approval --run-id <run_id> → opencontrib submission submit; MCP equivalents end at contrib_submit_pr / SubmissionPort.
- Do not write Pull Requests through raw GitHub CLI, GitHub MCP, or GitHub API operations; they bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.
<!-- OPENCONTRIB:GENERATED protocol:end -->
