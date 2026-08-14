# Contributing to OpenContrib

Thank you for your interest in contributing to OpenContrib! We are dedicated to building a high-trust, production-grade autonomous contribution ecosystem.

## Development Workflow

1. **Prerequisites**: Ensure you have [Bun](https://bun.sh) (v1.2+) installed.
2. **Clone & Install**:
   ```bash
   git clone https://github.com/opencontrib/opencontrib.git
   cd opencontrib
   bun install
   ```
3. **Run Test Matrix**:
   ```bash
   bun test
   ```
4. **Start Studio Web UI**:
   ```bash
   bun run studio
   ```
5. **Start MCP Server**:
   ```bash
   bun run mcp
   ```

## Contribution Principles

- **Minimal Scope**: PRs should focus strictly on single issues (<100 lines diff where possible).
- **Empirical Evidence**: All proactive bug fixes must be backed by a failing reproduction script verified before and after the patch.
- **Clean Room Hygiene**: Ensure all temporary worktrees and test files are cleaned up.
- **Zero AI Boilerplate**: PR descriptions and commit messages must conform to natural, concise human engineering tone.
