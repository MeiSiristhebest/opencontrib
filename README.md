<div align="center">

# 🚀 OpenContrib

**The Agent-Native Open Source Contribution Engine**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-v1.2%2B-FBF0DF?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CLI](https://img.shields.io/badge/CLI-20%20Commands-FF6B35)](https://github.com/MeiSiristhebest/opencontrib#quick-start)
[![npm](https://img.shields.io/npm/v/opencontrib-cli.svg)](https://www.npmjs.com/package/opencontrib-cli)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

<p align="center">
  <b>A contribution infrastructure that provides autonomous agents with discrete, composable domain capabilities: opportunity signals, isolated worktree sandboxes, dual-stage evidence verification, anti-AI governance, structured run persistence, and a profile flywheel — all exposed through a lightweight CLI.</b>
</p>

</div>

---

## What is OpenContrib?

OpenContrib is a **Contribution Engine**, not a Giant Agent. It does not attempt to replace Claude Code, Cursor, Codex, Devin, or any external reasoning AI. Instead, it provides that AI with the structured primitives it needs to make high-quality open-source contributions.

```text
    ┌──────────────────────────────────────────────────────────────────┐
    │              External AI Agent (Brain)                            │
    │    Claude Code · Cursor · Codex · Devin · Antigravity            │
    │                                                                  │
    │  Autonomous Reasoning · Decision Making · Code Writing            │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ Shell / CLI calls
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │                  OpenContrib CLI (Tool Layer)                     │
    │                                                                  │
    │  scout · rank · qualify · feasibility · context · manifests       │
    │  prepare · purge · evidence · audit · impact · pr-template       │
    │  run create/get/resume · flywheel sync/pr-track · doctor          │
    └───────────────────────────┬──────────────────────────────────────┘
                                │ Pure TypeScript imports
                                ▼
    ┌──────────────────────────────────────────────────────────────────┐
    │                @opencontrib/core (Domain Logic)                   │
    │                                                                  │
    │  13 modules · 0 MCP dependencies · 0 CLI framework dependencies  │
    │  Discovery · Sandbox · Evidence · Governance · Flywheel · Run     │
    │  Storage · GitHub · Probe · Risk · Orchestration · LLM · Memory   │
    └──────────────────────────────────────────────────────────────────┘
```

**Key property**: `packages/core/` has zero dependencies on any interface layer. The CLI (`opencontrib-cli`) is the primary interface. An MCP server wrapper exists for compatibility with MCP-native agents, but the core is pure TypeScript and can power any future interface (REST, gRPC, TUI).

---

## Quick Start

### Install

```bash
# One-shot (no install needed)
npx -y opencontrib-cli doctor

# Global install
npm install -g opencontrib-cli
```

### Run from source (development)

```bash
git clone https://github.com/MeiSiristhebest/opencontrib.git
cd opencontrib
bun install
bun run cli --help
```

### Test

```bash
bun test   # 16 test suites, 78 tests
```

---

## Command Map

All 20 subcommands across 8 domains:

| Domain | Commands | Purpose |
| -------- | ---------- | --------- |
| **Run** | `run create` `run get` `run resume` `run save` | Session tracking under `~/.opencontrib/runs/` |
| **Discovery** | `scout` `discovery rank` `discovery qualify` `discovery feasibility` `discovery context` `discovery manifests` | Opportunity signals, scoring, and context assembly |
| **Workspace** | `workspace prepare` `workspace purge` | Isolated Git worktree sandbox management |
| **Evidence** | `evidence` | Dual-stage empirical verification |
| **Governance** | `governance audit` `governance impact` `governance ci-diagnose` `governance pr-template` | Patch quality, CI diagnosis, PR template rendering |
| **Flywheel** | `flywheel sync` `flywheel pr-track` `doctor` | Profile persistence, PR lifecycle, environment diagnostics |

### I/O Patterns

```bash
# Compact JSON output by default (best for pipelines)
opencontrib scout facebook/react --limit 3

# Pretty-print for debugging
opencontrib doctor --pretty

# Complex inputs via --input flag
opencontrib discovery rank --input '{"issue":{"number":1,"title":"..."},...}'

# Complex inputs via stdin (best for LLM agents)
cat payload.json | opencontrib discovery qualify

# Shell pipelines
opencontrib scout facebook/react | jq '.opportunities[0].title'
opencontrib governance pr-template ... | jq -r '.prBody' > pr-body.md
```

---

## Contribution Pipeline (9 Phases)

```text
Phase 1:  INITIALIZED          → run create
Phase 2:  OPPORTUNITY_SCOUTED  → scout + discovery rank
Phase 3:  CONTEXT_ASSEMBLED    → discovery context
Phase 4:  WORKSPACE_PREPARED   → workspace prepare
Phase 5:  PATCH_DRAFTED        → (external: agent writes patch)
Phase 6:  EVIDENCE_COLLECTED   → evidence
Phase 7:  GOVERNANCE_AUDITED   → governance audit
Phase 8:  PR_SUBMITTED         → governance pr-template + gh pr create
Phase 9:  COMPLETED            → flywheel sync
```

```bash
# Full pipeline example
opencontrib run create --repo facebook/react --issue 42 --title "fix NPE"
# → captures runId

opencontrib workspace prepare --repo facebook/react --issue 42 --run-id "$RUN_ID"
# → captures workspacePath

# [agent writes patch]

opencontrib evidence --cwd "$WORKSPACE_PATH" --test-cmd "npm test" --run-id "$RUN_ID"
opencontrib governance audit --patch "$DIFF" --pr-title "Fix NPE" --pr-body "..."
opencontrib governance pr-template --issue 42 --summary "Fixed null check" \
  --validation-cmd "npm test" --validation-output "5 tests passed" \
  --key-changes "fixed null check,added regression test" | jq -r '.prBody' > pr-body.md

gh pr create --repo facebook/react --title "Fix NPE" --body-file pr-body.md --draft
opencontrib flywheel sync --repo facebook/react
```

### Resume from interruption

```bash
opencontrib run resume "$RUN_ID"
# → shows suggestedNextAction and availableArtifacts
```

---

## Core Principles

1. **Credential-Isolated Execution**: Tests run with `~/.ssh`, `~/.aws`, `~/.npmrc`, and `GH_TOKEN` purged; `HOME`/`TMPDIR` redirected; working-directory boundaries restricted.
2. **Dual-Stage Empirical Verification**: Contributions require a pre-fix failure baseline + a clean 20× post-fix stress loop.
3. **100-Line RFC Gate**: Surgical minimal bugfixes. Patches exceeding 100 lines require explicit human/RFC approval.
4. **Anti-Bandwagoning & Author Rights**: Enforces 7-day original-author priority and blocks claiming already-assigned issues.
5. **Human-in-the-Loop Gate**: All submissions remain draft-safe until explicit user confirmation.

---

## Profile Flywheel

OpenContrib enforces a **High-Signal-to-Noise Ratio** standard to eliminate PR farming and maximize long-term maintainer trust:

```text
Deep-Water Defect Discovery → Issue & Reproduction → Surgical Fix & 20x Stress Loop
     → Merged PR → Profile Flywheel & Reputation → back to Deep-Water Discovery
```

### 8 Deep-Water Engineering Archetypes

1. **Protocol & Serialization Drift** — `omitempty` zero-value, HTTP/2 header case, SSE truncation
2. **Lifecycle & Resource Leaks** — duplicate watcher registration, orphan goroutines, unclosed FDs
3. **Distributed Cache & Invalidation** — falsy value penetration, out-of-order stampede
4. **Memory Layout & Tensor Contiguity** — non-contiguous strided tensors, FFI dangling pointers
5. **ReDoS & Backpressure Collapse** — catastrophic regex backtracking, thundering herd retries
6. **Time Monotonicity & Chrono Hazards** — wall clock vs monotonic NTP rollback, DST boundary jumps
7. **Compiler / JIT Escape Invariants** — dynamic interface dispatch breaking escape analysis
8. **Numerical Bounds & Cross-Platform Invariants** — NaN/Inf, negative timeout hangs, CRLF traversal

### Scoring Engine

```text
FinalScore = clamp(0, 100,
  0.50 * S_profile
  + 0.30 * (S_domain + B_repo + B_deep - P_low_snr)
  + 0.20 * S_feasibility
  + M_freshness
  + M_actionability
)
```

| Component | Range | Role |
| ----------- | ------- | ------ |
| `S_profile` (50%) | 15→100 | Tech-stack + domain keyword alignment |
| `S_domain` (30%) | 25→60 | Issue labels and taxonomy |
| `B_deep` | +15→+25 | Deep-water archetype match bonus |
| `P_low_snr` | -35 | Anti-farming penalty for trivial changes |
| `B_repo` | 0→+6 | Repository popularity tier |
| `S_feasibility` (20%) | 0→100 | Environment/toolchain match |
| `M_freshness` | -20→+6 | Activity recency modifier |
| `M_actionability` | -6→+6 | Stack trace + repro steps presence |

---

## Architecture

```
opencontrib/
├── packages/
│   ├── core/           # 🧠 Pure domain logic (13 modules)
│   ├── cli/            # 🖥️ 20 subcommands (npm: opencontrib-cli)
│   ├── mcp-server/     # 🔌 MCP compatibility wrapper
│   └── studio/         # 🎨 Web control studio
├── skills/
│   └── opencontrib-cli/# 📜 Agent skill for CLI usage
└── package.json
```

---

## Monorepo Packages

| Package | npm | Description |
| --------- | ----- | ------------- |
| `@opencontrib/core` | — | Pure domain logic — 13 modules, no interface dependencies |
| `opencontrib-cli` | `npm install opencontrib-cli` | CLI interface — 20 subcommands via Commander.js |
| `opencontrib-mcp` | `npm install opencontrib-mcp` | MCP compatibility wrapper — 18 tools, 3 resources, 1 prompt |

---

## License

Distributed under the [MIT License](LICENSE). Copyright (c) 2026 OpenContrib Contributors.
