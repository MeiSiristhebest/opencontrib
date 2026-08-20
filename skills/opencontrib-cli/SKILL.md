---
name: opencontrib-cli
description: Use the `opencontrib` CLI to execute the 9-phase open source contribution engine. Activate when the user asks to find, develop, verify, or submit contributions/PRs to open source repositories, audit open source code, fix upstream issues, or interact with GitHub projects using OpenContrib. This skill enforces a strict phase-gated workflow with mandatory human approval at key checkpoints, long-term craftsmanship, and open source community etiquette.
---

# OpenContrib CLI

OpenContrib is a 9-phase contribution engine that guides you from opportunity discovery to merged pull request. The workflow balances autonomous code intelligence with human judgment. Open source contribution is fundamentally social and judgment-intensive: maintainer trust, patch scope, and communication etiquette determine whether a contribution is welcomed or rejected.

Read `references/workflow.md` for the complete phase-by-phase reference. This document outlines the core principles, checkpoint rules, and contribution etiquette.

---

## The Three Checkpoints

Pause execution at these three critical junctures. Present clean, structured findings and wait for the user's explicit approval before proceeding.

- **Checkpoint 1 (Post-Scout Opportunity Selection):** Present the top candidate issues with defect classification, technical rationale, and feasibility score. Do not clone repositories or prepare workspaces until the user selects a target.

- **Checkpoint 2 (Empirical Reproduction & Plan):** Present the concrete failing test output proving the bug exists before any fix is attempted. Share an idiomatic implementation plan. Wait for confirmation before modifying source files.

- **Checkpoint 3 (Governance Audit & PR Review):** Show the full patch diff, governance audit results, and rendered PR description. For proactive discoveries, verify that a tracking issue has been created first. Obtain approval before pushing to remotes or opening PRs.

---

## Long-Term Craftsmanship & Scope Boundaries

Maintainers appreciate contributors who show holistic responsibility for the subsystem they touch, while disliking PRs that mix unrelated concerns.

### 1. In-Domain Deep Defense vs. Cross-Domain Scope Creep
- **In-Domain Deep Defense (Encouraged):** When fixing a defect in a module (e.g., timeout handling), sweep for identical bug patterns across parallel structs and sister functions in that same module. Synchronize inline docstrings, comments, and relevant documentation (`docs/` or `README.md`). Add defensive test cases covering boundary values (`0`, `-1`, `nil`, `NaN`, timeout limits) and concurrency idempotency.
- **Cross-Domain Scope Creep (Strictly Avoided):** Never bundle unrelated fixes into a single PR (e.g., modifying filesystem mount logic while submitting a timeout patch). Unrelated changes muddy `git bisect`, complicate code review, and risk total PR rejection. Always isolate distinct concerns into separate PRs.

### 2. Issue-First Policy for Proactive Discoveries
- **Reactive Workflow (Existing Issue):** Directly link the existing issue (`Fixes #123`).
- **Proactive Workflow (0-Day / Scanner Finding):** When discovering an unfiled defect, create a clear GitHub Issue first (`gh issue create`). Immediately include an explicit **Claim Statement** in the issue description or initial comment:
  > *"I have reproduced this issue with a targeted test case and have an idiomatic fix prepared. Please assign this to me, I will submit a PR shortly."*
  This establishes public context, prevents duplicate work from other contributors, and anchors the subsequent PR (`Fixes #<new_id>`).

### 3. Review Etiquette: Automated Bots vs. Human Maintainers
- **Automated Bots (`[bot]` accounts like `coderabbitai[bot]`, `codecov[bot]`):** Do not post conversational comment replies to automated bots. Doing so generates notification noise for all repository watchers. Instead, address valid bot feedback directly in code, commit, and push; the bot will automatically update its status on the next CI cycle.
- **Human Maintainers:** Reply to human reviewers with courteous, concise technical explanations addressing their specific questions or concerns.

---

## Defect Targeting Archetypes

Focus on deep-water defects that provide genuine value to maintainers:

1. **Protocol & Serialization Drift:** Serialization omissions (`omitempty`), header casing, or protocol state desynchronization.
2. **Lifecycle & Resource Leaks:** Unclosed file descriptors, runaway goroutines/threads, or missing event listener teardowns.
3. **Distributed Cache Consistency:** Falsy-value cache bypasses (`false` or `0` treated as miss), concurrent writer stampedes, or stale invalidation.
4. **Memory Layout & ABI Boundaries:** Non-contiguous memory passed across FFI/native boundaries, alignment traps, or struct layout mismatches.
5. **Backpressure & Performance Collapse:** Unbounded queues causing OOM, missing retry backoff, or catastrophic regex backtracking (ReDoS).
6. **Time Monotonicity:** Using wall-clock time for durations, breaking during NTP synchronization or daylight saving adjustments.
7. **Escape Analysis & GC Pressure:** Hot-path interface boxing or closures forcing heap allocations.
8. **Numerical & Cross-Platform Bounds:** Floating-point `NaN`/`+Inf` in scheduler math, CRLF vs LF line ending traps, or Windows path separator assumptions.

Avoid trivial cosmetic edits (typo fixes, formatting, whitespace) unless explicitly requested in a repository issue.

---

## Operational Rules

- **Workspace Isolation:** Always create branches and worktrees inside the user's active workspace directory. Never write to system temporary directories.
- **Progress Tracking:** Maintain `CONTRIBUTION_RUN.md` in the workspace root to record phase transitions, checkpoint approvals, and artifact pointers.
- **Profile Privacy:** Only officially merged pull requests (`status: 'merged'`) may be synced to the public profile. In-flight PRs are tracked strictly in local ledger storage.
- **Anti-AI Policy:** Omit robotic disclaimers, AI badges, and tool watermarks unless explicitly required by the repository's `CONTRIBUTING.md`.

---

## CLI Reference Navigation

Consult these topic references for flag details and pipeline examples:

- `references/discovery.md` — Scouting and issue qualification commands
- `references/probe.md` — Microkernel probes, smart pointers (`ptr://`), and forensics
- `references/workspace.md` — Workspace and run session management
- `references/evidence.md` — Fail-first reproduction and bounded stress testing
- `references/governance.md` — Quality audits, impact analysis, and PR templates
- `references/flywheel.md` — PR lifecycle tracking and memory synchronization
- `references/workflow.md` — End-to-end 9-phase execution walkthrough
