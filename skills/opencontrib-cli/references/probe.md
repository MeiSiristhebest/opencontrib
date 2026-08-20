# Progressive Probe & Plugin System

OpenContrib includes a modular, progressive probe negotiation engine for proactive vulnerability discovery and deep-water defect hunting.

---

## 🔍 Core Philosophy: Progressive Probe Negotiation

Instead of blindly running dozens of heavy linters across every codebase, OpenContrib performs **Progressive Capability Negotiation**:
1. **Fingerprint (0.05s)**: Instantly identifies primary/secondary languages, manifest files (`go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`), frameworks, and risk surface.
2. **Negotiate (0.01s)**: Matches registered probe manifests against the fingerprint. Irrelevant languages and missing host binaries are cleanly filtered out.
3. **Execute (Targeted)**: Runs only the 2-3 most relevant, high-SNR probes concurrently, normalizing all findings into the 8 Deep-Water Defect categories.

---

## 🛠️ CLI Commands

### 1. `opencontrib probe plan [target]`
Extract repository fingerprint and negotiate active probes without executing them:

```bash
# Plan probes for current directory
opencontrib probe plan .

# Plan with filters and max cost
opencontrib probe plan /path/to/repo --max-cost fast --pretty
opencontrib probe plan . --only nilaway,goleak
```

### 2. `opencontrib probe run [target]`
Negotiate and execute targeted probes against the repository, returning normalized findings:

```bash
# Run auto-negotiated probes
opencontrib probe run .

# Run with minimum score filter
opencontrib probe run /path/to/repo --min-score 85 --pretty
```

### 3. `opencontrib plugin list`
List all registered builtin and custom probe plugins with their language targets, manifest triggers, and binary requirements:

```bash
opencontrib plugin list --pretty
```

### 4. `opencontrib plugin add <manifestFileOrJson>`
Register a custom probe manifest to `~/.opencontrib/plugins/<name>.json`:

```bash
opencontrib plugin add ./my-custom-probe.json
```

### 5. `opencontrib plugin remove <name>`
Remove a custom probe plugin:

```bash
opencontrib plugin remove my-custom-probe
```

---

## 📦 Creating a Custom Probe Manifest

Save a JSON file with the following schema:

```json
{
  "name": "custom-solidity-audit",
  "version": "1.0.0",
  "description": "Slither static analyzer for smart contract vulnerabilities",
  "category": "security_cwe",
  "author": "Security Researcher",
  "activation": {
    "languages": ["solidity"],
    "manifestFiles": ["foundry.toml", "hardhat.config.js"],
    "requiresBinaries": ["slither"]
  },
  "execution": {
    "cost": "medium",
    "stage": "scout",
    "command": "slither {target} --json -",
    "timeoutMs": 30000
  }
}
```

---

## 📊 Normalized Finding Schema

All probes output normalized findings mapped directly to OpenContrib's 8 Deep-Water Defect archetypes:

```json
{
  "id": "nilaway-pkg_server-42",
  "probeName": "nilaway",
  "category": "lifecycle_leak",
  "title": "Potential nil pointer dereference on user context",
  "description": "Field 'UserContext' can be nil when unauthenticated request reaches handler.",
  "file": "pkg/server/handler.go",
  "line": 42,
  "severity": "high",
  "cwe": "CWE-476",
  "prPotentialScore": 94
}
```
