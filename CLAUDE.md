# OpenContrib Integration Guide for Claude Code

This project integrates with **OpenContrib**, the deterministic open-source contribution engine for AI agents.

## 🚀 Quick Execution Protocol

When conducting open-source scouting, vulnerability probing, bug fixing, or pull request creation:

1. **Verify Environment & Capabilities:**

   ```bash
   opencontrib doctor
   opencontrib capability list
   ```

2. **Scouting & Deep Probing:**

   ```bash
   # Scout open issues on a repository
   opencontrib scout <owner/repo> --focus bugfix,testing
   # Or run deep AST/SAST defect probes across negotiated plugins
   opencontrib probe plan [target]
   opencontrib probe run [target] --limit 5
   ```

3. **Smart Pointer Code Navigation (Prevent Context Bloat):**

   ```bash
   # List pointers or read targeted code slice via smart pointer URI
   opencontrib pointer list
   opencontrib pointer resolve "ptr://findings/<finding_id>" --view slice
   ```

4. **Isolated Worktree Sandbox:**

   ```bash
   opencontrib workspace prepare --repo <owner/repo> --issue <issue_id>
   ```

5. **Empirical Evidence Collection (Fail-First & Dual-Stage, RED→GREEN):**

   ```bash
   # Before the fix: capture the failing baseline and bind the source tree
   opencontrib evidence capture-red --test-cmd "<test_cmd>" --assertion "<expected_regex>"
   # Apply the fix, then verify GREEN against the captured RED baseline
   opencontrib evidence verify-green --test-cmd "<test_cmd>"
   ```

6. **RFC-100 Governance Pre-Flight Audit:**

   ```bash
   opencontrib governance audit --patch <patch_file> --pr-title "<title>"
   ```

7. **PR Description Generation & Submission:**

   ```bash
   opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>"
   gh pr create --title "<title>" --body-file pr-body.md
   ```

8. **Flywheel Sync:**

   ```bash
   opencontrib flywheel sync --repo <owner/repo>
   ```

## 🔌 MCP Integration

If OpenContrib MCP server is active (`npx -y @opencontrib/mcp`), invoke native MCP tools:

- `contrib_scout` / `contrib_qualify_issue`
- `contrib_probe_run` / `contrib_resolve_pointer`
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
