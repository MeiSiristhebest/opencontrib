# OpenContrib Agent Protocol (Codex / OpenAI Assistants)

This document provides system directives for OpenAI Codex, OpenAI Assistants, and generic autonomous coding agents utilizing the OpenContrib Engine.

## 🚀 Operational Directives

### 1. Workflow Orchestration

Execute open-source contribution tasks adhering to the 9-Phase OpenContrib Lifecycle:

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
