# Microkernel Plugin System & Smart Pointer Protocol

OpenContrib features a **Microkernel Architecture & Smart Pointer Protocol** designed for progressive, token-efficient repository defect discovery.

---

## 🏛️ Microkernel Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 OpenContrib Microkernel Core                │
│  • Lifecycle Event Bus (fingerprint, scout, evidence)       │
│  • Smart Pointer Store (ptr:// URI content addressing)      │
│  • PluginHost Dynamic Isolation & Capability Negotiation    │
└─────────────────────────────────────────────────────────────┘
          ▲                         ▲                         ▲
          │ activate(ctx)           │ activate(ctx)           │ activate(ctx)
┌──────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│   plugin-ocr     │      │  plugin-piolium  │      │ plugin-ast-grep  │
│ (Alibaba NPE/SQL)│      │  (PoC & Adv-17)  │      │ (Tree-sitter AST)│
└──────────────────┘      └──────────────────┘      └──────────────────┘
```

---

## 📌 Smart Pointer Protocol (`ptr://...`)

To avoid polluting the Agent's context window with large AST traces, raw JSON payloads, or multi-thousand line logs, tools store findings in the **Smart Pointer Store** and return lightweight pointer URIs.

```text
URI Syntax: ptr://<namespace>/<defect_id>/<file>:<line>[?view=<stub|slice|evidence|all>]
```

### 3-Level Progressive Dereferencing:

| Level | View | Purpose | Data Included |
| :--- | :--- | :--- | :--- |
| **Level 1** | `stub` | Triage & Scanning | `id`, `title`, `category`, `severity`, `file:line`, `confidence` |
| **Level 2** | `slice` | Investigation & Planning | Code snippet slice, surrounding context, rule explanation |
| **Level 3** | `evidence` | Verification & Execution | AST data-flow trace, runnable PoC harness, raw diagnostic payload |

---

## 🛠️ CLI Commands & MCP Equivalents

### 1. Pointer Management (`opencontrib pointer` / `ptr`)

```bash
# List all active smart pointers (Level 1 stub metadata)
opencontrib pointer list --pretty

# Resolve a pointer to Level 2 code slice view
opencontrib pointer resolve ptr://ast-grep/ssrf-ipv6-bypass/src/fetch.ts:42 --view slice --pretty

# Resolve a pointer to Level 3 deep evidence / PoC script
opencontrib pointer resolve ptr://ast-grep/ssrf-ipv6-bypass/src/fetch.ts:42 --view evidence --pretty
```
*MCP Tool Equivalent:* `contrib_resolve_pointer`, `contrib_list_pointers`

---

### 2. Capability Router & Scoring Commands (`opencontrib capability` / `cap`)

```bash
# List available capability domains (Level 0) and capability types (Level 1)
opencontrib capability list --pretty

# Run Capability Scoring Engine against a repository to generate an optimal execution plan
opencontrib capability plan . --pretty

# Plan with explicit intent and optional heavy tools
opencontrib capability plan . --intent deep_security --enable-heavy --pretty
```
*MCP Tool Equivalent:* `contrib_plan_capabilities`

---

### 3. Plugin & Microkernel Commands (`opencontrib plugin`)

```bash
# List all active plugins and probes in the microkernel
opencontrib plugin list --pretty

# Inspect a specific probe's capabilities
opencontrib plugin info ocr --pretty
```
*MCP Tool Equivalent:* `contrib_list_plugins`, `contrib_plugin_info`

---

### 4. Proactive Exploration & Forensics (`opencontrib probe`)

```bash
# Preview negotiated probes based on repository fingerprint
opencontrib probe plan . --pretty

# Execute probe scanner and return Top-K triaged Smart Pointers
opencontrib probe run . --limit 5 --min-confidence 80 --pretty

# Run Code as a Crime Scene hotspot forensics (Churn × Complexity)
opencontrib probe hotspot . --limit 5 --pretty

# Generate property-based boundary fuzzing test harness
opencontrib probe fuzz . --category numerical_bounds --pretty
```
*MCP Tool Equivalent:* `contrib_probe_plan`, `contrib_probe_run`, `contrib_probe_hotspot`, `contrib_probe_fuzz`
