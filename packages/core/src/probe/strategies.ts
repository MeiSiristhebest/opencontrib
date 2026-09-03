/**
 * Probe strategies — the OCP-compliant replacement for the string `if/else`
 * dispatch chains that used to live in `runner.ts`.
 *
 * Each probe now *owns* its output parser and its fallback command builders.
 * Adding a new probe means adding one registry entry here — no existing
 * branching code is touched.
 */

import * as path from 'path';
import type { ProbeManifest, NormalizedFinding } from './types.js';
import { mapToDefectCategory, mapSeverity } from './defect-category.js';
import { isBinaryOnPath } from '../kernel/tool-registry.js';
import { discoverDocker } from '../discovery/docker-discovery.js';
import { execWithSpawn } from '../kernel/process-runner.js';

// ── Output parsers ────────────────────────────────────────────────────────────

export type OutputParser = (
  probe: ProbeManifest,
  data: any,
  targetPath: string,
) => NormalizedFinding[];

export const OUTPUT_PARSERS: Record<string, OutputParser> = {
  semgrep: (probe, data, targetPath) => {
    if (!Array.isArray(data.results)) return [];
    const findings: NormalizedFinding[] = [];
    for (const res of data.results) {
      findings.push({
        id: `semgrep-${res.check_id}-${res.start?.line || 1}`,
        probeName: 'semgrep',
        category: mapToDefectCategory(res.extra?.metadata?.category || 'security'),
        title: res.extra?.message || `Semgrep finding: ${res.check_id}`,
        description: res.extra?.metadata?.summary || res.extra?.message || '',
        file: path.relative(targetPath, res.path || ''),
        line: res.start?.line || 1,
        column: res.start?.col,
        endLine: res.end?.line,
        severity: mapSeverity(res.extra?.severity),
        cwe: res.extra?.metadata?.cwe?.[0],
        ruleId: res.check_id,
        prPotentialScore: res.extra?.severity === 'ERROR' ? 95 : 85,
      });
    }
    return findings;
  },

  'osv-scanner': (probe, data, targetPath) => {
    if (!Array.isArray(data.results)) return [];
    const findings: NormalizedFinding[] = [];
    for (const res of data.results) {
      for (const pkg of res.packages || []) {
        for (const vuln of pkg.vulnerabilities || []) {
          findings.push({
            id: `osv-${vuln.id}`,
            probeName: 'osv-scanner',
            category: 'security_cwe',
            title: `Vulnerable dependency: ${pkg.package?.name}@${pkg.package?.version} (${vuln.id})`,
            description: vuln.summary || vuln.details || 'Known vulnerability reported in OSV database.',
            file: path.relative(targetPath, res.source?.path || 'package.json'),
            line: 1,
            severity: 'high',
            cwe: vuln.aliases?.[0],
            ruleId: vuln.id,
            remediation: `Upgrade ${pkg.package?.name} to fixed version`,
            prPotentialScore: 90,
          });
        }
      }
    }
    return findings;
  },

  knip: (probe, data, _targetPath) => {
    if (!(data.files || data.unused)) return [];
    const unusedFiles: string[] = data.files || [];
    return unusedFiles.map((uf: string) => ({
      id: `knip-unused-${uf.replace(/[^a-zA-Z0-9]/g, '_')}`,
      probeName: 'knip',
      category: 'dead_code' as const,
      title: `Dead Code / Unused File: ${uf}`,
      description: 'File is not imported by any entry point or module in project.',
      file: uf,
      line: 1,
      severity: 'low' as const,
      remediation: `Remove dead file ${uf}`,
      prPotentialScore: 82,
    }));
  },

  ruff: (probe, data, targetPath) => {
    if (!Array.isArray(data)) return [];
    return (data as any[]).map((item) => ({
      id: `ruff-${item.code}-${item.filename}-${item.location?.row || 1}`,
      probeName: 'ruff',
      category: mapToDefectCategory(item.code || 'protocol_drift'),
      title: `[${item.code}] ${item.message}`,
      description: item.message || '',
      file: path.relative(targetPath, item.filename || ''),
      line: item.location?.row || 1,
      column: item.location?.column,
      severity: 'medium' as const,
      ruleId: item.code,
      remediation: item.fix?.message,
      prPotentialScore: item.code.startsWith('B') || item.code.startsWith('ASYNC') ? 90 : 80,
    }));
  },
};

/** Generic `findings` array (any probe that emits `{ findings: [...] }`). */
function parseGenericFindings(probe: ProbeManifest, data: any): NormalizedFinding[] {
  if (!Array.isArray(data.findings)) return [];
  return data.findings.map((f: any) => ({
    id: f.id || `${probe.name}-${Math.random().toString(36).slice(2, 8)}`,
    probeName: probe.name,
    category: f.category || probe.category,
    title: f.title || f.message || 'Probe finding',
    description: f.description || '',
    file: f.file || '',
    line: f.line || 1,
    severity: f.severity || 'medium',
    prPotentialScore: f.prPotentialScore || 85,
  }));
}

/** Last-resort: match `file:line: error:/warning:` lines in non-JSON output. */
function parseLineByLine(probe: ProbeManifest, stdout: string): NormalizedFinding[] {
  const findings: NormalizedFinding[] = [];
  const lines = stdout.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.includes(': error:') || line.includes(': warning:')) {
      findings.push({
        id: `${probe.name}-line-${i + 1}`,
        probeName: probe.name,
        category: probe.category,
        title: line,
        description: line,
        file: line.split(':')[0] || '',
        line: parseInt(line.split(':')[1], 10) || 1,
        severity: line.includes('error') ? 'high' : 'medium',
        prPotentialScore: 80,
      });
    }
  }
  return findings;
}

export function parseProbeOutput(
  probe: ProbeManifest,
  stdout: string,
  targetPath: string,
): NormalizedFinding[] {
  if (!stdout || stdout.trim() === '') return [];
  try {
    const data = JSON.parse(stdout);
    const parser = OUTPUT_PARSERS[probe.name];
    if (parser) {
      const parsed = parser(probe, data, targetPath);
      if (parsed.length > 0) return parsed;
    }
    const generic = parseGenericFindings(probe, data);
    if (generic.length > 0) return generic;
    return [];
  } catch {
    return parseLineByLine(probe, stdout);
  }
}

// ── Fallback command strategies ────────────────────────────────────────────────

export interface FallbackCommandBuilders {
  ephemeral?: (targetPath: string) => string | undefined;
  docker?: (targetPath: string) => string | undefined;
}

export const FALLBACK_COMMANDS: Record<string, FallbackCommandBuilders> = {
  semgrep: {
    ephemeral: (t) => (isBinaryOnPath('uv')
      ? `uvx semgrep scan --config auto --config p/security-audit --config p/owasp-top-ten --json --quiet ${t}`
      : undefined),
    docker: (t) => {
      const n = t.replace(/\\/g, '/');
      return `docker run --rm -v "${n}:/src" -w /src returntocorp/semgrep semgrep scan --config auto --config p/security-audit --config p/owasp-top-ten --json --quiet /src`;
    },
  },
  ruff: {
    ephemeral: (t) => (isBinaryOnPath('uv')
      ? `uvx ruff check --output-format json ${t}`
      : undefined),
    docker: (t) => {
      const n = t.replace(/\\/g, '/');
      return `docker run --rm -v "${n}:/src" -w /src ghcr.io/astral-sh/ruff check --output-format json /src`;
    },
  },
  knip: {
    ephemeral: (t) => {
      if (isBinaryOnPath('bun')) return `bun x knip --reporter json`;
      if (isBinaryOnPath('npx')) return `npx knip --reporter json`;
      return undefined;
    },
    docker: (t) => {
      const n = t.replace(/\\/g, '/');
      return `docker run --rm -v "${n}:/src" -w /src node:alpine npx --yes knip --reporter json`;
    },
  },
  'ast-grep': {
    ephemeral: (t) => {
      if (isBinaryOnPath('bun')) return `bun x @ast-grep/cli scan ${t}`;
      if (isBinaryOnPath('npx')) return `npx @ast-grep/cli scan ${t}`;
      return undefined;
    },
    docker: (t) => {
      const n = t.replace(/\\/g, '/');
      return `docker run --rm -v "${n}:/src" -w /src node:alpine npx --yes @ast-grep/cli scan /src`;
    },
  },
};

export function getEphemeralFallbackCommand(probeName: string, targetPath: string): string | undefined {
  return FALLBACK_COMMANDS[probeName]?.ephemeral?.(targetPath);
}

export function getDockerFallbackCommand(probeName: string, targetPath: string): string | undefined {
  const builder = FALLBACK_COMMANDS[probeName]?.docker;
  if (!builder) return undefined;
  const dockerDiscovery = discoverDocker();
  return dockerDiscovery.found ? builder(targetPath) : undefined;
}

// ── Fallback-chain composition (OCP) ───────────────────────────────────────────
//
// The old `runner.ts` expressed the probe fallback chain as nested imperative
// try/catch blocks: primary command → ephemeral (`uvx`/`npx`/`bunx`) → Docker.
// That ordering lived *inside* the hot loop and had to be edited to add a stage.
// Now the chain is a composed list of attempt thunks executed by `withFallback`,
// so adding a new fallback strategy is a data change (extend the attempt list),
// never a control-flow edit.

export interface CommandOutcome {
  stdout?: string;
  error?: unknown;
}

/**
 * Runs a single probe command, recovering partial output that a scanner may emit
 * on a non-zero exit (e.g. semgrep prints findings to stdout even when it exits
 * non-zero). Mirrors the original runner behaviour exactly: non-empty stdout is
 * treated as success; otherwise the error is preserved for the next fallback.
 */
export async function execProbeCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandOutcome> {
  try {
    const res = await execWithSpawn(cmd, {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout: res.stdout };
  } catch (err: any) {
    if (err?.stdout && typeof err.stdout === 'string' && err.stdout.trim().length > 0) {
      return { stdout: err.stdout };
    }
    return { error: err };
  }
}

/**
 * Composes an ordered fallback chain. Each attempt is tried in turn; the first
 * that yields non-empty stdout wins and its outcome is returned. The most recent
 * underlying error is propagated if every attempt fails.
 */
export async function withFallback(
  attempts: Array<() => Promise<CommandOutcome>>,
): Promise<CommandOutcome> {
  let error: unknown;
  for (const attempt of attempts) {
    const outcome = await attempt();
    if (outcome.stdout && typeof outcome.stdout === 'string' && outcome.stdout.trim().length > 0) {
      return outcome;
    }
    // Keep the *first* underlying error (mirrors the original runner: a failed
    // fallback stage that emits no stdout does not clobber the primary error).
    if (outcome.error !== undefined && error === undefined) error = outcome.error;
  }
  return { error };
}

