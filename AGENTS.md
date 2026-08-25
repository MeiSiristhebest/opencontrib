# OpenContrib Agent Protocol (Codex / OpenAI Assistants)

This document provides system directives for OpenAI Codex, OpenAI Assistants, and generic autonomous coding agents utilizing the OpenContrib Engine.

## 🧭 Operational Directives

### 1. Workflow Orchestration
Execute open-source contribution tasks adhering to the 9-Phase OpenContrib Lifecycle:
- **Scout / Probe:** `opencontrib scout` or `opencontrib probe run`
- **Context Assembly:** `opencontrib pointer resolve "ptr://<path>#L<start>-L<end>"`
- **Sandbox Workspace:** `opencontrib workspace create --branch <name>`
- **Evidence Verification:** `opencontrib evidence record --command "<test_cmd>"`
- **Governance Audit:** `opencontrib governance audit --diff`
- **Flywheel Sync:** `opencontrib flywheel sync`

### 2. Constraints & Quality Invariants
- **No Hallucinated PRs:** Never write code or tests without running local verification inside the worktree sandbox.
- **RFC-100 Adherence:** Ensure all contributions pass anti-AI governance linting with a score >= 85.
- **Issue-First Policy:** Always associate PRs with qualified issues.
