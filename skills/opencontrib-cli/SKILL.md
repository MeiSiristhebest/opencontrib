---
name: opencontrib-cli
description: |
  Use the `opencontrib` CLI to execute the industrial-grade, 9-phase OpenContrib contribution engine.
  Activate when the user asks to scout, assess, develop, verify, audit, or submit open source contributions/PRs using the OpenContrib CLI.
  Enforces a strict Phase-Gated State Machine with Interactive User Approvals: Environment Doctor → Opportunity Scouting & Qualification (8 Deep-Water Defect Types) [PAUSE FOR APPROVAL] → Context Assembly → Worktree Sandbox Isolation → Dual-Stage Empirical Evidence Verification (Fail-First & Stress Loop) [PAUSE FOR APPROVAL] → Governance Audit (<=100-line Gate & Anti-AI Fluff) → Subagent Code Review → PR Template Rendering [PAUSE BEFORE PUSH] → Flywheel Persistence.
---

# OpenContrib CLI — Phase-Gated Contribution Protocol

> **Core Philosophy**: Open source contribution is an interactive, step-by-step engineering journey — NOT a runaway autonomous black-box script.
>
> This skill enforces a **strict Phase-Gated State Machine with Mandatory Human Checkpoints**. You MUST pause and obtain user confirmation at critical milestones before proceeding to the next stage. Never rush through all phases in a single turn.

---

## 💎 Core Governance & Engineering Rules (核心工程准则)

### 🚨 Rule 1: Repository Convention Absolute Priority (仓库规范优先)
- ALWAYS prioritize the target repository's established style guides, commit conventions, PR templates, and workflow rules.
- If a repo requires specific ticket prefixes, custom PR section headers, DCO trailers, or mandatory issue linking formats, enforce them strictly over defaults.

### 🤫 Rule 2: Zero AI Disclosure by Default (默认隐藏 AI 痕迹)
- **Default Policy**: **DO NOT include any AI badges, LLM disclaimers, or assistant chatter** in PR descriptions or commit messages. Explicit AI mentions trigger maintainer bias and lead to immediate PR rejection.
- **Exception Policy**: Include AI disclosure **ONLY if the target repository's official documentation (`CONTRIBUTING.md`, `GOVERNANCE.md`, `SECURITY.md`, or PR template) explicitly mandates it**.

### 🛡️ Rule 3: 100-Line Size Gate & RFC Defense (100 行规模红线)
- Proposed code changes MUST NOT exceed **100 lines** (excluding tests).
- If an architectural change or public API modification is required, STOP and advise the user to submit an **RFC / Discussion Issue** first.

### 🚫 Rule 4: Anti-Farming & Low-SNR Ban (坚决杜绝低信噪比刷分)
- **Strictly Banned**: Typo fixes, whitespace tweaks, formatting rewrites, docstring rephrasing, or Awesome list submissions. These trigger anti-farming algorithm alarms and maintainer hostility.

### 🌊 Rule 5: Focus on the 8 Deep-Water Defect Archetypes (八大深水区高价值缺陷全景图谱)
Target issues matching these 8 high-signal categories:
1. **Protocol & Serialization Drift (协议与序列化契约漂移)**: Zero-Value in `omitempty` erased causing downstream default value penetration; HTTP/2 header casing; SSE keepalive and half-closed connections.
2. **Lifecycle, Watcher & Resource Leaks (生命周期与资源泄露)**: Registry watcher reconnect loop doubling listeners; Context Cancellation unpropagated causing orphan goroutines; unclosed fd / socket handle leaks (`lsof`).
3. **Distributed Cache & Consistency (分布式缓存与时序一致性)**: Falsy value cache bypass in short cache; out-of-order dual write cache stampede; retry mechanisms breaking idempotency.
4. **Memory Layout & Underlying ABI (内存布局与底层 ABI)**: Non-contiguous / strided tensor (`permute`/`transpose`) passed to C++/CUDA kernel causing Segfault; FFI cross-language dangling pointers.
5. **Performance Collapse & Backpressure Loss (性能坍塌与反压失效)**: Catastrophic regex backtracking (ReDoS) hanging CPU at 100%; missing Full Jitter exponential backoff causing thundering herds; unbounded queues causing OOM.
6. **Time Monotonicity & Chrono Hazards (时间单调性与时钟回拨)**: Wall Clock elapsed time calculation yielding negative values under NTP sync; DST / leap second skipping scheduled tasks.
7. **Compiler / JIT Escape Analysis Invariants (逃逸分析与 GC 停顿)**: Hot-path dynamic interface assertions breaking escape analysis causing heap allocation explosions and GC STW spikes.
8. **Numerical Bounds & Cross-Platform Invariants (数值边界与跨平台破坏)**: `NaN`/`+Inf` and negative timeout values causing scheduler lockup; Windows/Linux CRLF breaking patch parsers; `filepath.ToSlash` cross-platform path traversal vulnerabilities.

---

## 🚦 Mandatory Human-in-the-Loop Checkpoints (三大强制人机交互暂停点)

You MUST pause execution and interact with the user at these 3 checkpoints:

| Checkpoint | When to Pause | What to Present to the User | Action After Approval |
| :--- | :--- | :--- | :--- |
| **Checkpoint 1** | After Phase 2 (Scout & Rank) | Top opportunity candidates, defect category (from the 8 archetypes), score, and technical rationale. | Prepare worktree sandbox and assemble context. |
| **Checkpoint 2** | After Phase 5 (Fail-First Evidence) | The exact failing test output (red error trace) proving the bug exists, plus proposed minimal fix design in `implementation_plan.md`. | Implement code patch and run stress verification loop. |
| **Checkpoint 3** | Before Phase 8 (PR Submission) | Complete Git Diff (<=100 lines), Governance Audit results, Subagent review summary, and rendered PR description. | Push branch and create upstream GitHub PR. |

---

## 🔄 9-Phase Step-by-Step Execution Protocol

### 🔹 Stage I: Opportunity Discovery & Alignment

#### Phase 1: Environment Health & Run Session Init
```bash
# Verify host environment
opencontrib doctor

# Initialize run session
opencontrib run create \
  --repo <owner/repo> \
  --issue <issue_number> \
  --title "<issue_title>" \
  --tags "bugfix,deep-water"
```

#### Phase 2: Opportunity Scouting & 8-Defect Ranking
```bash
# 1. Scout candidate opportunities
opencontrib scout <owner/repo> --limit 10

# 2. Author-first-right & anti-bandwagoning check
printf '{"issue":{"number":<num>,"title":"<title>","comments_count":<c>,"labels":[]}}' | \
  opencontrib discovery qualify

# 3. 8-Dimension deep-water probability ranking
opencontrib discovery rank --input '{"issue":{"number":<num>,"title":"<title>","body":"..."}}'
```

🛑 **STOP & PAUSE (Checkpoint 1)**:
Present the top opportunity candidates to the user with defect taxonomy, root cause hypothesis, and feasibility score. **Wait for the user to confirm the target issue before touching code or creating workspaces.**

---

### 🔹 Stage II: Sandbox Isolation & Dual-Stage Evidence

#### Phase 3: Context Assembly & Manifest Diagnosis
```bash
# Assemble problem context and test targets
opencontrib discovery context --input '{"repo":"<owner/repo>","issueNumber":<num>,"issueTitle":"...","issueBody":"..."}'

# Diagnose repo manifests for <=100-line improvements
opencontrib discovery manifests --repo-path <path_to_repo>
```

#### Phase 4: Worktree Sandbox Isolation
**NEVER edit code in the main checkout.** Always isolate changes:
```bash
opencontrib workspace prepare \
  --repo <owner/repo> \
  --issue <issue_number> \
  --run-id "$RUN_ID"
# → Sets $WORKSPACE_PATH
```

#### Phase 5: Pre-Fix Fail-First Baseline Evidence
You MUST reproduce the bug and show a failing test BEFORE writing any fix:
```bash
# Execute pre-fix test assertion: MUST fail cleanly
opencontrib evidence \
  --cwd "$WORKSPACE_PATH" \
  --test-cmd "<test_command>" \
  --assertion "<expected_failure_trace>" \
  --run-id "$RUN_ID"
```

🛑 **STOP & PAUSE (Checkpoint 2)**:
Present the failing test output to the user. Create/update `implementation_plan.md` with minimal patch design (<=100 lines). **Wait for user approval before writing fix code.**

---

### 🔹 Stage III: Implementation, Verification & Audit

#### Phase 6: Code Implementation & Post-Fix Stress Loop
1. Implement minimal, surgical changes in `$WORKSPACE_PATH` (strictly <= 100 lines).
2. Verify deterministic 100% pass rate with a 20-cycle stress loop:
```bash
opencontrib evidence \
  --cwd "$WORKSPACE_PATH" \
  --test-cmd "<test_command>" \
  --stress-loop 20 \
  --run-id "$RUN_ID"
```

#### Phase 7: Governance Audit & Independent Review
```bash
# 1. Run strict governance & size audit
git -C "$WORKSPACE_PATH" diff | \
  opencontrib governance audit \
    --patch /dev/stdin \
    --pr-title "<proposed_pr_title>" \
    --pr-body "<proposed_pr_body>"

# 2. Analyze impact surface
opencontrib governance impact \
  --cwd "$WORKSPACE_PATH" \
  --modified-files "<comma_separated_files>"

# 3. Simulate CI diagnosis
opencontrib governance ci-diagnose --log-file <path_to_test_log>
```

🛑 **STOP & PAUSE (Checkpoint 3)**:
Present the full Git Diff, Governance Audit score, and rendered PR description to the user. **Ask for explicit confirmation before pushing or submitting.**

---

### 🔹 Stage IV: PR Submission & Flywheel

#### Phase 8: PR Template Rendering & Submission
```bash
# 1. Render maintainer-friendly PR description (no AI fluff)
opencontrib governance pr-template \
  --issue <issue_number> \
  --issue-title "<issue_title>" \
  --summary "<concise_technical_summary>" \
  --validation-cmd "<test_command>" \
  --validation-output "20/20 stress tests passed, 0 flakes" \
  --key-changes "<change_1>,<change_2>" \
  | jq -r '.prBody' > pr_body.md

# 2. Push branch and create PR
git -C "$WORKSPACE_PATH" checkout -b fix/<short_issue_topic>
git -C "$WORKSPACE_PATH" add <files>
git -C "$WORKSPACE_PATH" commit -m "fix(<scope>): <concise_description> (#<issue_number>)"
git -C "$WORKSPACE_PATH" push -u origin fix/<short_issue_topic>

gh pr create \
  --repo <owner/repo> \
  --title "fix(<scope>): <concise_description> (#<issue_number>)" \
  --body-file pr_body.md \
  --head fix/<short_issue_topic>
```

#### Phase 9: Profile Flywheel Persistence
```bash
# Record contribution to local ledger
opencontrib flywheel sync \
  --run-id "$RUN_ID" \
  --pr-url "<pr_html_url>"

# Track PR lifecycle status
opencontrib flywheel pr-track --repo <owner/repo> --pr-number <pr_number>
```
