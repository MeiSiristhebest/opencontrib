---
name: opencontrib-cli
description: Use the `opencontrib` CLI to execute the 9-phase open source contribution engine. Activate when the user asks to find, develop, verify, or submit contributions/PRs to open source repositories using the OpenContrib CLI. This skill enforces a strict phase-gated workflow with mandatory user approval at key checkpoints — use it any time the user says "contribute to", "find a bug in", "submit a PR to", or "use opencontrib" for any open source project.
---

# OpenContrib CLI

OpenContrib is a 9-phase contribution engine that takes you from "find something to fix" all the way to "PR merged". The workflow is deliberately interactive: you stop at three checkpoints to get the user's eyes on things before moving forward. This matters because open source contribution is a judgment-intensive process — the maintainer relationship, the scope of the fix, and the framing of the PR all require human decisions that automation alone cannot make well.

Read `references/workflow.md` for the full phase-by-phase CLI reference. This document covers the principles, the checkpoint protocol, and the defect targeting strategy.

---

## The Three Checkpoints

These are non-negotiable pauses. At each one, present findings clearly and wait for explicit approval before continuing. The goal is to keep the user informed and in control at every decision point that matters.

**Checkpoint 1 — After scouting:** Show the top candidate issues with their defect category, rationale, and score. Ask the user to pick one. Do not prepare a workspace or clone anything until they confirm.

**Checkpoint 2 — After reproducing the bug:** Show the actual failing test output that proves the bug exists. Then present a concise implementation plan (the proposed fix in ≤100 lines). Wait for approval before touching any source files.

**Checkpoint 3 — Before submitting:** Show the complete diff, the governance audit result, and the rendered PR description. Only push and create the PR after explicit confirmation.

---

## Defect Targeting

The contribution engine is designed for bugs that are genuinely hard to spot — the kind that have lurked in codebases for months because they only surface under specific conditions. Chasing these produces higher-quality PRs that maintainers actually want, versus surface-level changes that signal noise.

When evaluating candidates, score them against these eight defect archetypes. Issues that match one or more of these are worth pursuing:

1. **Protocol and serialization drift** — Encoding mismatches that are invisible until a client or downstream service interprets the data differently. Examples: `omitempty` dropping zero-value fields; HTTP/2 header casing; SSE connection state not tracked.

2. **Lifecycle and resource leaks** — Handles, goroutines, file descriptors, or event listeners that are opened but never closed. These compound over time and typically only appear in long-running production environments.

3. **Distributed cache consistency** — Race conditions where two concurrent writers produce inconsistent state, or where a cache miss cascade causes a thundering herd. Falsy-value bypasses (treating a cached `false` or `0` as a miss) are a classic example.

4. **Memory layout and ABI boundaries** — Non-contiguous tensor layouts passed across a language boundary (e.g., a `permute()`d tensor fed to a CUDA kernel expecting contiguous memory); FFI dangling pointers; struct alignment assumptions.

5. **Performance collapse and backpressure** — Unbounded queues that cause OOM under load; missing exponential backoff causing thundering herds on retry; catastrophic regex backtracking (ReDoS) that pins CPU at 100%.

6. **Time monotonicity** — Code that uses wall-clock time for elapsed duration, which goes negative during NTP sync or DST changes; cron schedulers that skip or double-fire around daylight saving transitions.

7. **Escape analysis and GC pressure** — Hot-path interface assertions or closures that cause values to escape to the heap, turning what should be stack allocations into GC pressure and stop-the-world pauses.

8. **Numerical and cross-platform bounds** — `NaN`/`+Inf` values in timeout or retry calculations; path separator assumptions (`\` vs `/`) that break on Windows; CRLF/LF mismatches in patch parsers.

Avoid issues that are primarily cosmetic: typos, whitespace, comment rewrites, or README additions. These rarely get merged and signal to maintainers that you're not reading the code carefully.

---

## PR Governance Rules

These constraints protect the PR's chances of being accepted.

**Size limit:** Keep diffs under 100 lines of production code (tests excluded). Larger changes require architectural discussion first — suggest the user open a Discussion or RFC issue instead.

**AI disclosure:** Do not include AI-generated badges, disclaimers, or any language that signals the patch was produced by a tool. Most maintainers react negatively to this. The only exception is if the repository's `CONTRIBUTING.md` or PR template explicitly asks for it.

**Respect conventions:** Match the repository's existing commit format, branch naming, PR section headers, and any required trailers (DCO sign-off, changelog entries, etc.). Check `CONTRIBUTING.md` first.

**Workspace location:** Clone and create worktrees directly inside the user's active workspace directory (e.g., alongside other projects they have open). Never write to system temp directories — files there are invisible in the IDE and hard to inspect.

---

## CLI Reference

For full flag documentation and piping examples for each command, read the appropriate reference file when you reach that phase:

- `references/discovery.md` — `scout`, `discovery rank/qualify/context/manifests/feasibility`
- `references/workspace.md` — `workspace prepare`, run creation
- `references/evidence.md` — `evidence`, fail-first and stress-loop modes
- `references/governance.md` — `governance audit/impact/ci-diagnose/pr-template`
- `references/flywheel.md` — `flywheel sync`, `flywheel pr-track`
- `references/workflow.md` — Full 9-phase walkthrough with example commands
