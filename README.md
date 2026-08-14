<div align="center">

# 🚀 OpenContrib

**The Agent-Native Open Source Contribution Engine, MCP Server & Visual Studio**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-v1.2%2B-FBF0DF?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP Native](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-8B5CF6)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

<p align="center">
  <b>A production-grade, 3-tier autonomous contribution system combining Agent Orchestration, Schema-First Intelligence, Deterministic Governance, Clean-room Sandboxes, and Claude-inspired Web Studio.</b>
</p>

</div>

---

## 🌟 Overview

**OpenContrib** is an intelligent, protocol-native infrastructure engine designed to help autonomous agents (and human developers) make high-quality, high-trust contributions to open-source software.

Unlike unconstrained coding agents that spam repositories with hallucinated or low-quality changes, OpenContrib enforces rigorous **governance gates, clean-room sandboxes, and empirical failure assertion verification** before any code is proposed.

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                   Layer 1: Agent Runtime & Orchestration                    │
│      ContributionStateMachine (状态机) + ExecutionPolicyEngine (策略引擎)    │
│      (Supports: interactive, dry_run, draft_only, local_artifacts, autonomous) │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────────┐
│                 Layer 2: Contribution Intelligence Layer                    │
│  - ContextAssembler: Integrates Problem + Repo Skeleton + Cognitive Memory │
│  - HybridIssueRanker: Profile Keywords + OS Feasibility + Timeline PR Match │
│  - Schema-First LLM: Typed Zod Contracts + Automated Repair Loop            │
│  - Subagent Review: 7-Dimension Mathematical Confidence Score >= 90%        │
└────────────────────────────────────┬────────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────────┐
│                 Layer 3: Deterministic Tooling & Safe Sandbox               │
│  - WorktreeManager: Parameterized spawnSync git worktree clean-room sandbox │
│  - EvidenceCollector: Empirical failure assertion capture + 20x stress loop │
│  - Multi-Ecosystem Probes: Go / Rust / Python / Java / CMake / Security     │
│  - PR Pipeline: Native template merger + GitHub Git Data API submissions    │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 📦 Monorepo Architecture

```
opencontrib/
├── packages/
│   ├── core/           # 🧠 Domain logic, State Machine, Context Assembler, Sandboxes
│   ├── mcp-server/     # 🔌 12 MCP Tools for Claude Code, Cursor, Antigravity
│   └── studio/         # 🎨 Obsidian/Claude-themed Native Web Control Studio
├── skills/             # 📜 Master Open-Source Contributor Skill
└── package.json        # 🛠️ Root Monorepo configuration
```

---

## ⚡ Quick Start

### 1. Installation & Test Suite

```bash
# Clone the repository
git clone https://github.com/opencontrib/opencontrib.git
cd opencontrib

# Install dependencies via Bun
bun install

# Run all 12 test suites (31 unit & integration tests)
bun test
```

### 2. Launching OpenContrib Studio Web UI

OpenContrib Studio provides an interactive, beautiful visual cockpit:

```bash
bun run studio
# 🚀 OpenContrib Studio is running at: http://localhost:4173
```

Features included in Studio:
- **Opportunities Radar**: Scan repositories for qualified, unclaimed bugs.
- **7-Stage Lifecycle Tracker**: Real-time progress bar from Phase 0 to Phase 7.
- **Visual Code Diff Review**: Inspect proposed patch before approving submission.
- **Flywheel Dashboard**: View total contributions, merged PRs, and SVG badges.
- **One-Click Sandbox Cleanup**: Purge ephemeral worktrees and test logs.

---

## 🔌 Model Context Protocol (MCP) Setup

OpenContrib exposes **12 zero-token domain tools** compatible with any MCP client (Claude Desktop, Cursor, Claude Code, Antigravity).

Add the following to your MCP client config (`claude_desktop_config.json` / `antigravity.json`):

```json
{
  "mcpServers": {
    "opencontrib": {
      "command": "bun",
      "args": ["run", "/path/to/opencontrib/packages/mcp-server/src/index.ts"],
      "env": {
        "GITHUB_TOKEN": "your_github_personal_access_token_here"
      }
    }
  }
}
```

### Available MCP Tools:
1. `contrib_scout`: Scout high-match, unclaimed GitHub issues with real stargazer counts.
2. `contrib_probe`: Deep multi-ecosystem repository hygiene diagnostic scanner.
3. `contrib_assemble_context`: Assemble problem, repo skeleton, memory pitfalls & host environment.
4. `contrib_prepare_workspace`: Allocate an isolated, zero-pollution Git Worktree sandbox.
5. `contrib_collect_evidence`: Run flaky test baseline isolation and 20x stress loops.
6. `contrib_audit_governance`: 100-line RFC gate, anti-robotic linter, and 7D confidence math.
7. `contrib_render_pr_template`: Intelligently merge into target repository native templates.
8. `contrib_sync_flywheel`: Synchronize local memory ledger and render profile SVG badge.
9. `contrib_purge_sandbox`: Garbage collection for temporary worktrees and test scripts.
10. `contrib_doctor`: Audit host environment health (Git, Node/Bun, Docker, WSL).
11. `contrib_track_pr_status`: Phase 7 CI tracking and maintainer review reply generator.

---

## 🛡️ Core Governance Principles

1. **Repo Convention Override**: Always inspect and prioritize target repo `.github/PULL_REQUEST_TEMPLATE.md` and `CONTRIBUTING.md`.
2. **100-Line RFC Gate**: Surgical minimal fixes; any patch exceeding 100 lines must be gated for RFC approval.
3. **Empirical Evidence Required**: Must include verifiable Red-to-Green assertion proof.
4. **Anti-Bandwagoning**: Respect 7-day author intention rights and avoid claiming issues already being worked on.
5. **Human-in-the-Loop Approval**: In interactive mode, PR creation is physically blocked until explicit user consent.

---

## 📄 License

Distributed under the [MIT License](LICENSE). Copyright (c) 2026 OpenContrib Contributors.
