/**
 * Integration-test guards.
 *
 * Some suites exercise real network / tooling (GitHub discovery, Docker, probe
 * binaries). They are meaningful in a networked CI image but must NOT fail (or
 * hang) in an offline sandbox or a machine without the toolchain. These helpers
 * let a test file declare its prerequisite and `skipIf` it cleanly.
 *
 * Fast paths (env overrides):
 *   - `OPENCONTRIB_OFFLINE=1`        → skip every integration test (no network).
 *   - `OPENCONTRIB_NETWORK_TESTS=1`  → force "online": run the network tests.
 *
 * NOTE: all helpers are SYNCHRONOUS on purpose. bun:test collects `describe`/
 * `it` blocks at module-evaluation time, so a top-level `await` before a
 * `describe` would defer registration past collection and yield "Ran 0 tests".
 * The reachability probe is therefore done inside a short-lived child process
 * (synchronous from the parent's point of view via `spawnSync`).
 */

import { spawnSync } from 'node:child_process';
import { isBinaryOnPath } from '../../src/kernel/tool-registry.js';

const PROBE_BINARIES = ['semgrep', 'ast-grep', 'ruff', 'knip', 'piolium', 'codeql'];

function offlineForced(): boolean {
  return process.env.OPENCONTRIB_OFFLINE === '1';
}

function networkTestsForced(): boolean {
  return process.env.OPENCONTRIB_NETWORK_TESTS === '1';
}

/**
 * Explicit opt-in for fragile live-data integration tests (e.g. the
 * orchestrator pipeline tests that depend on GitHub returning issues that match
 * a specific profile for a specific repo). Even with network + auth present,
 * the live data may not match the test's assumptions, so these must be enabled
 * deliberately in a controlled CI job — they are skipped by default.
 */
export function isIntegrationEnabled(): boolean {
  return networkTestsForced();
}

/**
 * Synchronous TCP reachability probe.
 *
 * DNS resolution alone is NOT sufficient: many sandboxes resolve
 * `api.github.com` via a captive DNS resolver but block egress, which would
 * make a DNS-only check return a false positive and let the network test run
 * and fail. We instead attempt a real TCP connect to `host:port` inside a
 * short-lived child process — if the connection cannot be established, egress
 * is unavailable and the test should skip. This keeps the build deterministic
 * in an offline sandbox while still auto-running in a networked CI image.
 */
function tcpReachable(host: string, port: number, timeoutMs = 1500): boolean {
  const script = `
    const net = require('net');
    const s = net.connect(${port}, ${JSON.stringify(host)});
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      try { s.destroy(); } catch {}
      process.stdout.write(ok ? '1' : '0');
    };
    s.setTimeout(${timeoutMs});
    s.on('connect', () => finish(true));
    s.on('timeout', () => finish(false));
    s.on('error', () => finish(false));
  `;
  try {
    const r = spawnSync(process.execPath, ['-e', script], {
      timeout: timeoutMs + 1000,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return String(r.stdout ?? '').trim() === '1';
  } catch {
    return false;
  }
}

/**
 * True only when an authenticated GitHub context is available. The discovery
 * client reads `GH_TOKEN` / `GITHUB_TOKEN`, then falls back to `gh auth token`;
 * without one, live API calls fail (rate-limited / 401). Unauthenticated runs
 * must skip the network tests.
 */
function hasGitHubAuth(): boolean {
  if (process.env.GH_TOKEN || process.env.GITHUB_TOKEN) return true;
  try {
    const r = spawnSync('gh', ['auth', 'token'], {
      timeout: 4000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (r.status === 0 && String(r.stdout ?? '').trim().length > 0) return true;
  } catch {
    /* gh not installed or not authenticated */
  }
  return false;
}

/**
 * GitHub integration readiness for network-dependent tests. Requires BOTH:
 *  1. network egress to api.github.com:443 (a real TCP connect, not just DNS),
 *  2. an authenticated GitHub context (token or `gh` auth).
 * Unauthenticated API calls fail, so a token is a hard prerequisite.
 *
 * Overrides:
 *  - `OPENCONTRIB_OFFLINE=1`       → skip (offline).
 *  - `OPENCONTRIB_NETWORK_TESTS=1` → run (assume the caller has network + auth).
 */
export function isGitHubReachable(): boolean {
  if (offlineForced()) return false;
  if (networkTestsForced()) return true;
  return tcpReachable('api.github.com', 443) && hasGitHubAuth();
}

/**
 * True when a responsive Docker daemon is available. Cached for the process.
 */
let dockerCached: boolean | null = null;
function dockerAvailable(): boolean {
  if (dockerCached !== null) return dockerCached;
  try {
    const r = spawnSync('docker', ['info'], { timeout: 4000, windowsHide: true });
    dockerCached = r.status === 0;
  } catch {
    dockerCached = false;
  }
  return dockerCached;
}

/**
 * True when the probe execution environment is usable: at least one probe binary
 * is on PATH, or a responsive Docker daemon is available. Respects
 * `OPENCONTRIB_OFFLINE`.
 */
export function isProbeRuntimeAvailable(): boolean {
  if (offlineForced()) return false;
  return PROBE_BINARIES.some((b) => isBinaryOnPath(b)) || dockerAvailable();
}

/**
 * True only when the GitHub SecLab Taskflow engine's specific prerequisite is
 * present: the `seclab-taskflow-agent` binary (or a `seclab` binary) or a
 * responsive Docker daemon. This is more precise than `isProbeRuntimeAvailable`
 * (which is satisfied by any probe binary) so the TaskflowEngine integration
 * test does not run — and fail — merely because, say, `semgrep` happens to be
 * installed. Respects `OPENCONTRIB_OFFLINE`; forced on by
 * `OPENCONTRIB_NETWORK_TESTS=1`.
 */
export function isTaskflowAvailable(): boolean {
  if (offlineForced()) return false;
  if (networkTestsForced()) return true;
  return isBinaryOnPath('seclab-taskflow-agent') || isBinaryOnPath('seclab') || dockerAvailable();
}
