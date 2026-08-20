# Microkernel Plugin System & Smart Pointer Protocol

OpenContrib features a **Microkernel Architecture & Smart Pointer Protocol** inspired by the minimal kernel design of the Pi coding agent.

---

## 🏛️ Microkernel Architecture

```text
┌─────────────────────────────────────────────────────────────┐
│                 OpenContrib Microkernel Core                │
│  • Lifecycle Event Bus (repo:fingerprint, scout, evidence)  │
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

To avoid polluting the Agent's context window with large AST traces, raw JSON payloads, or multi-thousand line logs, tools store heavy artifacts in the **Smart Pointer Store** and return lightweight pointer URIs.

```text
URI Syntax: ptr://<namespace>/<resource_id>[?view=<stub|slice|evidence|all>]
```

### 3-Level Progressive Dereferencing:

| Level | View | Token Cost | Data Included | Agent Workflow Stage |
| :--- | :--- | :---: | :--- | :--- |
| **Level 1** | `?view=stub` | **~25 tokens** | `id`, `title`, `category`, `severity`, `file:line`, `confidence` | Scout & Triage (browsing candidates) |
| **Level 2** | `?view=slice` | **~150 tokens** | Code snippet slice, surrounding context, rule explanation, remediation pseudo-code | Investigation & Planning |
| **Level 3** | `?view=evidence` | **On Demand** | AST data-flow trace, runnable `poc.*` Fail-First script, raw diagnostic payload | Verification & Fail-First Execution |

---

## 🛠️ CLI Commands

### 1. Pointer Management (`opencontrib pointer` / `ptr`)

```bash
# List all active smart pointers (Level 1 stub metadata)
opencontrib pointer list

# Resolve a pointer to Level 2 code slice view
opencontrib pointer resolve ptr://findings/ocr-auth-handler-42 --view slice

# Resolve a pointer to Level 3 deep evidence / PoC script
opencontrib pointer resolve ptr://poc/repro-npe-auth --view evidence --pretty
```

### 2. Plugin & Microkernel Commands (`opencontrib plugin`)

```bash
# List all active plugins and probes in the microkernel
opencontrib plugin list --pretty

# Inspect a specific probe's capabilities
opencontrib plugin info ocr --pretty
```

### 3. Proactive Exploration & Forensics

```bash
# Preview negotiated probes based on repository fingerprint
opencontrib probe plan . --pretty

# Run Code as a Crime Scene hotspot forensics (Churn × Complexity)
opencontrib probe hotspot . --limit 5 --pretty

# Generate property-based boundary fuzzing test harness
opencontrib probe fuzz . --category numerical_bounds --pretty
```
