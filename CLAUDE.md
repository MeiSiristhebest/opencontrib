# OpenContrib Integration Guide for Claude Code

This project integrates with **OpenContrib**, the deterministic open-source contribution engine for AI agents.

## 🚀 Quick Execution Protocol

When conducting open-source scouting, vulnerability probing, bug fixing, or pull request creation:

1. **Create the run anchor first:**

   ```bash
   opencontrib run create --repo <owner/repo> --issue <issue_id>
   ```

   Then verify environment and capabilities:

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
   opencontrib governance request-approval --run-id "$RUN_ID"
   opencontrib submission submit --run-id "$RUN_ID"
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
- `contrib_capture_red` / `contrib_verify_green`
- `contrib_request_approval` / `contrib_submit_pr`
- `contrib_audit_governance`
- `contrib_render_pr_template`
- `contrib_sync_flywheel`

## 🛡️ Hard Invariants

- **Canonical Submission Route**: Public work requires a provider-verified IssueBindingArtifact; private vulnerability work requires provider-verified SecurityDisclosureArtifact lifecycle authorization and no public Issue.
- **Fail-First Verification**: Prove bug reproduction with failing test before fixing.
- **Anti-AI Governance**: Never introduce generic boilerplate or non-reproducible changes.

<!-- OPENCONTRIB:GENERATED protocol:start -->
## Canonical OpenContrib Protocol (generated)

- **Run anchor (first)**: `opencontrib run create --repo <owner/repo> [--issue <id>]` / `contrib_create_run`; no scouting, workspace preparation, or source edits before a runId exists.
- **Workspace and evidence**: `opencontrib workspace prepare --repo <owner/repo> --issue <issue-or-task-id>` / `contrib_prepare_workspace`; PoC (contrib_verify_poc) is optional and never replaces authoritative RED via contrib_capture_red.
- **RED → PATCH → GREEN**: run contrib_capture_red first, then save the patch through contrib_save_artifact, and verify GREEN through contrib_verify_green; PATCH_DRAFTED is invalid without RED.
- **Routing and governance**: public vulnerabilities require a provider-verified IssueBindingArtifact; private vulnerability policy requires a provider-verified SecurityDisclosureArtifact and public-fix authorization, with no public Issue route. Use a non-public task identifier when preparing a private-work workspace.
- **PR draft**: while still in EVIDENCE_COLLECTED, create and persist immutable pr_draft with opencontrib governance pr-template --run-id <run_id> --issue-title "<title>" --summary "<summary>" / contrib_render_pr_template; private security drafts must omit public Issue references. Then run opencontrib governance audit --run-id <run_id> --pr-title "<title>" → opencontrib governance request-approval --run-id <run_id> → opencontrib submission submit; MCP order is contrib_render_pr_template → contrib_audit_governance → contrib_request_approval → contrib_submit_pr / SubmissionPort.
- Do not write Pull Requests through raw GitHub CLI, GitHub MCP, or GitHub API operations; they bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.
<!-- OPENCONTRIB:GENERATED protocol:end -->
