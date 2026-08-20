# Progressive Probe, Forensics & Plugin System

OpenContrib provides an industrial-grade, 6-dimension probe and forensics engine for proactive vulnerability discovery, code forensics, and deep-water defect hunting.

---

## 🔍 Core Philosophy: Progressive Probe Negotiation

Instead of blindly running dozens of heavy linters across every codebase, OpenContrib performs **Progressive Capability Negotiation**:
1. **Fingerprint (<50ms)**: Instantly identifies primary/secondary languages, manifest files (`go.mod`, `package.json`, `Cargo.toml`, `pyproject.toml`), frameworks, and risk surface.
2. **Negotiate (10ms)**: Matches registered probe manifests against the fingerprint. Irrelevant languages and missing host binaries are cleanly filtered out.
3. **Execute (Targeted)**: Runs only the 2-3 most relevant, high-SNR probes concurrently, normalizing all findings into the 8 Deep-Water Defect categories.

---

## 📊 The 6-Dimension Integrated Probe Matrix

| Dimension | Integrated Probes & Engines | Target Defect / Value |
| :--- | :--- | :--- |
| **1. AI-Native Review & Audit** | `ocr` (Alibaba OpenCodeReview), `piolium` (Vigolium 17-Phase), `seclab` (GitHub Security Lab), `pr-agent` (Qodo) | NPE & concurrency rules, autonomous PoC construction (P13), false positive verification (P10), multi-agent security taskflows. |
| **2. AST & Taint Engines** | `semgrep` (SAST), `ast-grep` (Tree-sitter structural search), `codeql` (Inter-procedural taint queries) | Instant structural pattern search, SQLi, path traversal, ReDoS, crypto flaws. |
| **3. Deep-Water Defect Probes** | • **Go**: `nilaway`, `goleak`, `bodyclose`, `noctx`<br>• **Rust**: `cargo-geiger`, `miri`, `cargo-deny`<br>• **Python**: `ruff` (B, ASYNC), `pyright`<br>• **TypeScript**: `knip`, `eslint-security` | Nil panics, goroutine leaks, unclosed HTTP bodies, context loss, unsafe pointer derefs, UB, type contract drift, dead exports. |
| **4. Property & Fuzzing** | `property-fuzz` (`fast-check`, `hypothesis`, `proptest`, `testing/quick`) | Generates property test harnesses for extreme floats (NaN/-0.0/Inf), CRLF newlines, and boundary edge cases. |
| **5. Git Hotspot Forensics** | `git-hotspot` (Code as a Crime Scene) | Computes `Commit Churn × Cyclomatic Complexity` to pinpoint the top 3-5 high-risk files in <100ms. |
| **6. Supply Chain & CI** | `osv-scanner` (Google OSV), `workflow-linter` | Known CVE vulnerability audit and GitHub Actions workflow modernization. |

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

### 3. `opencontrib probe hotspot [target]`
Run Code as a Crime Scene Git churn and cyclomatic complexity hotspot analysis:

```bash
opencontrib probe hotspot . --limit 5 --pretty
```

### 4. `opencontrib probe fuzz [target]`
Generate a property-based boundary fuzz test harness for the target repository's primary language:

```bash
opencontrib probe fuzz . --category numerical_bounds --pretty
opencontrib probe fuzz . --category protocol_drift --function-name sanitizePath
```

### 5. `opencontrib plugin list`
List all registered builtin and custom probe plugins:

```bash
opencontrib plugin list --pretty
```

### 6. `opencontrib plugin add <manifestFileOrJson>`
Register a custom probe manifest to `~/.opencontrib/plugins/<name>.json`:

```bash
opencontrib plugin add ./my-custom-probe.json
```

---

## 📦 Custom Probe Manifest Example

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
