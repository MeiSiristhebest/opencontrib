<div align="center">

# 🚀 OpenContrib

**The Agent-Native Open Source Contribution Engine & MCP Server**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)
[![Bun Version](https://img.shields.io/badge/Bun-v1.2%2B-FBF0DF?logo=bun&logoColor=black)](https://bun.sh)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7%2B-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![MCP Native](https://img.shields.io/badge/Model%20Context%20Protocol-Compatible-8B5CF6)](https://modelcontextprotocol.io)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](#)

<p align="center">
  <b>A composable, protocol-native contribution infrastructure providing autonomous Agents with discrete domain capabilities: Opportunity Signals, Worktree Isolation, Dual-Stage Evidence Verification, Anti-AI Governance, Run Persistence, and Profile Flywheel.</b>
</p>

</div>

---

## 🌟 Philosophy: Contribution Engine, Not Giant Agent

OpenContrib does **not** attempt to replace the external reasoning AI (Claude Code, Cursor, Codex, Devin, Antigravity). Instead, it follows a strict separation of concerns:

```text
                       External AI Agent (Brain)
        ┌───────────────────────────────────────────────────────┐
        │ Claude Code / Cursor / Codex / Devin / Antigravity    │
        └──────────────────────────┬────────────────────────────┘
                                   │
                   Autonomous Reasoning & Decisions
                                   │
                  ┌────────────────┴────────────────┐
                  │                                 │
            GitHub MCP                       OpenContrib MCP
                  │                                 │
       Native GitHub API State              Contribution Engine
  (Issues, PRs, Comments, Repo State)  (Sandbox, Evidence, Governance, Runs)
```

- **External Agent**: Makes high-level decisions, reasons about code, and writes patches.
- **GitHub MCP**: Reads and mutates GitHub repository state.
- **OpenContrib MCP**: Supplies objective feasibility signals, isolated Git Worktree sandboxes, pre-fix to post-fix dual-stage empirical evidence verification, anti-AI governance linter, and structured run persistence.
- *(Internal Core retains a lightweight GitHub adapter strictly for standalone local workflow execution)*.

---

## 📦 Monorepo Architecture

```
opencontrib/
├── packages/
│   ├── core/           # 🧠 Domain logic: Runs, Artifacts, Sandbox, Evidence, Governance, Storage
│   ├── mcp-server/     # 🔌 18 Tools + 3 Resources + 1 Prompt for MCP Clients
│   └── studio/         # 🎨 Obsidian/Claude-themed Native Web Control Studio
├── skills/             # 📜 Master Open-Source Contributor Skill
└── package.json        # 🛠️ Root Monorepo configuration
```

---

## ⚡ Quick Start

```bash
# Clone the repository
git clone https://github.com/MeiSiristhebest/opencontrib.git
cd opencontrib

# Install dependencies via Bun
bun install

# Run full test suite (15 test suites, 64 tests)
bun test
```

---

## 🔌 Model Context Protocol (MCP) Setup

Add OpenContrib to your MCP client configuration (`claude_desktop_config.json` / `antigravity.json`):

```json
{
  "mcpServers": {
    "opencontrib": {
      "command": "bun",
      "args": ["run", "/path/to/opencontrib/packages/mcp-server/src/index.ts"],
      "env": {
        "GITHUB_TOKEN": "your_github_token_here"
      }
    }
  }
}
```

### Protocol Capabilities: 18 Tools, 3 Resources, 1 Prompt

| Category | Primitives | Description |
| :--- | :--- | :--- |
| **Run & Session** | `contrib_create_run`<br>`contrib_save_artifact`<br>`contrib_get_run`<br>`contrib_resume_run` | Structured session tracking under `~/.opencontrib/runs/<runId>/` with full crash resume. |
| **Discovery & Feasibility** | `contrib_scout`<br>`contrib_rank_opportunity`<br>`contrib_qualify_issue`<br>`contrib_assess_feasibility`<br>`contrib_diagnose_manifests` | Objective multi-dimensional probability signals (skill, OS feasibility, actionability) without prescribing decisions. |
| **Context & Workspace** | `contrib_assemble_context`<br>`contrib_prepare_workspace`<br>`contrib_purge_sandbox` | Problem skeleton + reading order + target tests + isolated Git worktree sandbox. |
| **Evidence & Governance** | `contrib_collect_evidence`<br>`contrib_audit_governance`<br>`contrib_render_pr_template` | Pre-fix failure assertion + post-fix 20x stress loop; 100-line gate + anti-AI audit. |
| **Flywheel & Lifecycle** | `contrib_sync_flywheel`<br>`contrib_track_pr_status`<br>`contrib_doctor` | Memory ledger, PR lifecycle tracking, and host environment diagnostic. |
| **Resources** | `opencontrib://doctor`<br>`opencontrib://memory`<br>`opencontrib://runs` | Zero-token instant context injection for host health, repo pitfalls, and run history. |
| **Prompts** | `opencontrib_workflow_guide` | Standard 9-step Phase-Gated execution protocol for autonomous Agents. |

---

## 🛡️ Core Verification & Governance Principles

1. **Credential-Isolated Local Execution Environment**: Test and benchmark execution runs with stripped credentials (`~/.ssh`, `~/.aws`, `~/.npmrc`, `GH_TOKEN` purged), redirected `HOME`/`TMPDIR`, and restricted working-directory boundaries.
2. **Dual-Stage Empirical Verification**: Contributions require capturing pre-fix failure baseline assertions and verifying clean 20x stress loop execution post-fix.
3. **100-Line RFC Gate**: Surgical minimal bugfixes; patches exceeding 100 lines require explicit human/RFC approval.
4. **Anti-Bandwagoning & Author Rights**: Enforces 7-day original author priority rights and blocks claiming already assigned issues.
5. **Human-in-the-Loop Gate**: All submissions remain draft-safe until explicit user confirmation.

---

## 📄 License

Distributed under the [MIT License](LICENSE). Copyright (c) 2026 OpenContrib Contributors.
