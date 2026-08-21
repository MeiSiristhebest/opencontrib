---
name: opencontrib-cli
description: Use the `opencontrib` CLI to execute the 9-phase open source contribution engine. Activate when the user asks to find, develop, verify, or submit contributions/PRs to open source repositories, audit open source code, fix upstream issues, or interact with GitHub projects using OpenContrib. This skill enforces a strict phase-gated workflow with mandatory human approval at key checkpoints, long-term craftsmanship, and open source community etiquette.
---

# OpenContrib Autonomous Contribution Engine

OpenContrib is a deterministic, 9-phase contribution engine for open-source software. It orchestrates autonomous discovery, empirical reproduction, surgical remediation, and RFC-100 governance to produce high-impact, maintainer-welcomed contributions.

---

## 🧭 Dual-Track Execution Routing

When an open-source task begins, identify the track and load the corresponding reference guide:

| Track | Scenario & Trigger Context | Primary Reference |
| :--- | :--- | :--- |
| **Track A: Proactive 0-Day Scanner** | User requests code audit, bug hunting, 0-day discovery, or proactive contribution | Load [`references/workflow.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/workflow.md) |
| **Track B: Reactive Issue Scouting** | User wants to scout open issues, pick a good first issue, or fix an existing bug | Load [`references/discovery.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/discovery.md) |

---

## ⚡ High-Level 9-Phase Lifecycle

```mermaid
graph LR
    P1["1. Initialize"] --> P2["2. Scout / Probe"]
    P2 --> P3["3. Assemble Context"]
    P3 --> P4["4. Prepare Workspace"]
    P4 --> P5["5. Fail-First PoC & Fix"]
    P5 --> P6["6. Collect Evidence"]
    P6 --> P7["7. Governance Audit"]
    P7 --> P8["8. Issue-First & PR"]
    P8 --> P9["9. Flywheel Sync"]
```

---

## 📚 Progressive Disclosure Index

Load these modular references into context **only when entering that specific phase**:

- **Phase 2 & 3 (Scouting & Context):** Read [`references/discovery.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/discovery.md) for qualification filters, scoring heuristics, and context bundling.
- **Phase 2 (Deep SAST & AST Probes):** Read [`references/probe.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/probe.md) for Smart Pointer (`ptr://...`) slicing, Semgrep packs, and Tree-sitter AST queries.
- **Phase 4 (Workspace Sandbox):** Read [`references/workspace.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/workspace.md) for git worktree isolation and environment sanitization.
- **Phase 5 & 6 (Empirical Verification):** Read [`references/evidence.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/evidence.md) for fail-first baseline assertions and 20x stress loops.
- **Phase 7 & 8 (Governance & Pull Requests):** Read [`references/governance.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/governance.md) for anti-AI linting, RFC-100 diff constraints, and native PR template merging.
- **Phase 9 (Memory & Profile):** Read [`references/flywheel.md`](file:///C:/Users/Mei/.gemini/config/skills/opencontrib-cli/references/flywheel.md) for ledger synchronization.

---

## 🚫 The 5 Absolute Hard Invariants (Zero Tolerance)

1. **Anti-Drift Circuit Breaker (Max 3 `view_file` calls)**:
   - **NEVER** perform blind sequential file reads (> 3 views).
   - Pinpoint symbols strictly via Smart Pointer slices (`ptr://...`) or `grep_search`. If you find yourself viewing files more than 3 times without progress, **execute `opencontrib probe run` immediately**.

2. **Mandatory Issue-First on 0-Days (No Blind PRs)**:
   - For proactive 0-day fixes, **ALWAYS create a GitHub Issue first** (`gh issue create --body-file ...`) with an authoritative Claim statement.
   - The subsequent PR description **MUST anchor `Fixes #<issue_number>`**. Unlinked PRs are strictly rejected.

3. **Targeted Subsystem Test Isolation (No Global Flaky Runs)**:
   - **NEVER** run broad root tests (`go test ./...` or `npm test` at repo root) without isolation.
   - Always scope test commands strictly to the modified sub-package (e.g. `go test -v ./graph/checkpoint/redis/...`).

4. **Anti-Deadlock Search Mandate**:
   - Every `rg` or `fd` command **MUST explicitly specify a target directory** (e.g. `rg "pattern" .`). Never omit the target path to avoid 30-minute stdin hangs.

5. **Local Markdown Files for GitHub CLI**:
   - Always write Issue and PR bodies to temporary `.md` files and pass `--body-file <file>`. Never pass multiline strings via `--body` to prevent PowerShell escaping bugs.

---

## 🎯 The Three Human Checkpoints

Pause and obtain user confirmation at these three gates:
- **Checkpoint 1 (Post-Scout / Finding Selection):** Present the top candidate finding with classification and feasibility score before preparing workspaces.
- **Checkpoint 2 (Empirical Reproduction):** Present the concrete failing test output proving the bug exists before modifying source code.
- **Checkpoint 3 (Governance & Pre-Flight Review):** Show the patch diff, governance audit score (0-100), and draft PR body before pushing to remotes.

