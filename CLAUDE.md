# OpenContrib Integration Guide for Claude Code

This project integrates with **OpenContrib**, the deterministic open-source contribution engine for AI agents.

## 🚀 Quick Execution Protocol

When conducting open-source scouting, vulnerability probing, bug fixing, or pull request creation:

1. **Verify Environment & Capabilities:**
   ```bash
   opencontrib capability list
   opencontrib doctor
   ```

2. **Scouting & Qualification:**
   ```bash
   # Scout open issues on a repository
   opencontrib scout issues <owner/repo> --label "good first issue"
   # Or run deep AST/SAST defect probes (6-dimension weapon arsenal)
   opencontrib probe run --dir . --pack all
   ```

3. **Smart Pointer Code Navigation (Prevent Context Bloat):**
   ```bash
   # Read targeted code slice via smart pointer URI
   opencontrib pointer resolve "ptr://<file>#L<start>-L<end>"
   ```

4. **Isolated Worktree Sandbox:**
   ```bash
   opencontrib workspace create --branch fix/issue-name
   ```

5. **Empirical Evidence Collection (Fail-First):**
   ```bash
   opencontrib evidence record --command "bun test <test_file>"
   ```

6. **RFC-100 Governance Pre-Flight Audit:**
   ```bash
   opencontrib governance audit --diff
   ```

## 🔌 MCP Integration

If OpenContrib MCP server is active, invoke native MCP tools:
- `contrib_scout` / `contrib_qualify_issue`
- `contrib_assemble_context`
- `contrib_prepare_workspace`
- `contrib_collect_evidence`
- `contrib_audit_governance`
- `contrib_render_pr_template`
- `contrib_sync_flywheel`

## 🛡️ Hard Invariants
- **Issue-First on 0-Days**: Always file an Issue before opening a PR.
- **Fail-First Verification**: Prove bug reproduction with failing test before fixing.
- **Anti-AI Governance**: Never introduce generic boilerplate or non-reproducible changes.
