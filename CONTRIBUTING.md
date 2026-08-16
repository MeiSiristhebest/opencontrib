# Contributing to OpenContrib

Thank you for your interest in contributing to **OpenContrib**! We are committed to building a high-trust, resilient, agent-native open-source contribution infrastructure.

---

## 🧭 Development Workflow

### 1. Prerequisites
- **Runtime**: [Bun](https://bun.sh) (v1.2+) and [Node.js](https://nodejs.org) (v22+)
- **Git**: 2.38+ (supports `git worktree`)

### 2. Setup Local Environment
```bash
# Clone the repository
git clone https://github.com/MeiSiristhebest/opencontrib.git
cd opencontrib

# Install all monorepo dependencies
bun install

# Run the complete test matrix (16 suites, 78+ tests)
bun test

# Run TypeScript type check
bunx tsc --noEmit
```

### 3. Local Services
* **Start Web Studio**: `bun run studio` (defaults to `http://localhost:3000`)
* **Start MCP Server**: `bun run mcp` (exposes stdio MCP protocol)

---

## 📜 Pull Request & Commit Guidelines

We follow **Trunk-Based Development** and strict quality verification:

1. **Branch Naming**:
   - `feat/<topic>`: New primitives, tools, or capabilities.
   - `fix/<topic>`: Bug fixes or compatibility patches.
   - `docs/<topic>`: Documentation and specifications.
   - `chore/<topic>`: Build, CI, or dependency upgrades.

2. **Commit Convention**:
   - Use [Conventional Commits](https://www.conventionalcommits.org/):
     - `feat(core): implement worktree isolation sandbox`
     - `fix(mcp): resolve stdio jsonrpc framing on Windows`

3. **PR Description Quality**:
   - Every PR must explain **What**, **Why**, and include **Verification Evidence** (test outputs or CLI logs).

---

## 🛡️ Anti-AI Noise & Clean-Room Policy

OpenContrib adheres to strict contribution ethics:
- **No Unverified AI Dumps**: Submissions must be reasoned through, tested locally, and accompanied by reproduction evidence.
- **100-Line RFC Gate**: Proactive bug fixes should remain surgical and focused. Architectural refactors >100 lines require an approved Feature RFC Issue first.
- **Zero Credential Leaks**: Never commit API keys, personal access tokens, or sensitive environment files.

---

## 💬 Community & Support

- Questions & Ideas: [GitHub Discussions](https://github.com/MeiSiristhebest/opencontrib/discussions)
- Bugs & Features: [GitHub Issues](https://github.com/MeiSiristhebest/opencontrib/issues)
