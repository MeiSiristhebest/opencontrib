import * as fs from 'fs';
import * as path from 'path';
import { execWithSpawn } from '../kernel/process-runner.js';
import type {
  ProbeNegotiationPlan,
  ProbeRunResult,
  NormalizedFinding,
  ProbeManifest,
  RepoFingerprint,
} from './types.js';
import { analyzeGitHotspots } from './forensics.js';
import { generatePropertyTest } from './fuzz-generator.js';
import { constructPoCForFinding, verifyFindingAdversarially } from './adapters/piolium.js';
import {
  getEphemeralFallbackCommand,
  getDockerFallbackCommand,
  parseProbeOutput,
  withFallback,
  execProbeCommand,
} from './strategies.js';

export interface RunOptions {
  timeoutMs?: number;
  concurrency?: number;
  minScore?: number;
}

export async function runProbes(
  plan: ProbeNegotiationPlan,
  options: RunOptions = {},
): Promise<ProbeRunResult> {
  const executedProbes: string[] = [];
  const failedProbes: Array<{ name: string; error: string }> = [];
  const findings: NormalizedFinding[] = [];

  const targetPath = plan.target;
  const timeoutMs = options.timeoutMs || 30000;

  for (const probe of plan.selectedProbes) {
    executedProbes.push(probe.name);
    try {
      // OCP: builtin probes are dispatched through the BUILTIN_RUNNERS registry.
      // Adding a new builtin probe means adding one registry entry — no branch
      // edits in this hot loop. A probe matches by its `name` or its
      // `execution.transformer` (e.g. `builtin:hotspot`).
      const runner =
        BUILTIN_RUNNERS[probe.name] ??
        (probe.execution?.transformer ? BUILTIN_RUNNERS[probe.execution.transformer] : undefined);

      if (runner) {
        const builtinFindings = await runner(probe, targetPath, plan.fingerprint, findings);
        findings.push(...builtinFindings);
      } else if (probe.execution.command) {
        // Execute external probe command — normalize to forward slashes & wrap in quotes
        const normalizedTarget = `"${targetPath.replace(/\\/g, '/').replace(/"/g, '\\"')}"`;
        const formattedCmd = probe.execution.command
          .replace('{target}', normalizedTarget)
          .replace('{outputJson}', '');
        const baseTimeout = probe.execution.timeoutMs || timeoutMs;

        // OCP fallback chain: primary → ephemeral (uvx/npx/bunx) → Docker sandbox.
        // Each stage is an attempt thunk; `withFallback` stops at the first that
        // yields output. Adding a new fallback stage = extend this list.
        const outcome = await withFallback([
          () => execProbeCommand(formattedCmd, targetPath, baseTimeout),
          async () => {
            const fb = getEphemeralFallbackCommand(probe.name, normalizedTarget);
            return fb ? execProbeCommand(fb, targetPath, baseTimeout * 2) : { error: undefined };
          },
          async () => {
            const dc = getDockerFallbackCommand(probe.name, targetPath);
            return dc ? execProbeCommand(dc, targetPath, baseTimeout * 2) : { error: undefined };
          },
        ]);

        const stdoutResult = outcome.stdout;
        const executionError = outcome.error;

        if (stdoutResult) {
          const parsed = parseProbeOutput(probe, stdoutResult, targetPath);
          findings.push(...parsed);
          if (executionError) {
            failedProbes.push({
              name: probe.name,
              error: `Executed with warnings (recovered ${parsed.length} finding(s)): ${(executionError as any)?.message || String(executionError)}`,
            });
          }
        } else if (executionError) {
          failedProbes.push({
            name: probe.name,
            error: (executionError as any)?.message || String(executionError),
          });
        }
      }
    } catch (err: any) {
      failedProbes.push({
        name: probe.name,
        error: err.message || String(err),
      });
    }
  }

  // Filter by minScore if provided
  const minScore = options.minScore || 0;
  const filteredFindings = findings.filter((f) => f.prPotentialScore >= minScore);

  // Group summary by category
  const summaryByCategory: Record<string, number> = {};
  for (const f of filteredFindings) {
    summaryByCategory[f.category] = (summaryByCategory[f.category] || 0) + 1;
  }

  return {
    target: targetPath,
    timestamp: new Date().toISOString(),
    fingerprint: plan.fingerprint,
    executedProbes,
    failedProbes,
    findingsCount: filteredFindings.length,
    findings: filteredFindings.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
    summaryByCategory,
  };
}

async function runBuiltinWorkflowLinter(targetPath: string): Promise<NormalizedFinding[]> {
  const findings: NormalizedFinding[] = [];
  const workflowsDir = path.join(targetPath, '.github', 'workflows');

  if (!fs.existsSync(workflowsDir)) return findings;

  try {
    const files = fs.readdirSync(workflowsDir);
    for (const file of files) {
      if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
      const relPath = path.join('.github', 'workflows', file);
      const fullPath = path.join(workflowsDir, file);
      const content = fs.readFileSync(fullPath, 'utf8');

      // Check actions/checkout@v2 or v3
      if (content.includes('actions/checkout@v2') || content.includes('actions/checkout@v3')) {
        const line = findLineNumber(content, 'actions/checkout@v');
        findings.push({
          id: `ci-checkout-${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
          probeName: 'workflow-linter',
          category: 'ci_workflow',
          title: `Upgrade deprecated actions/checkout in ${file}`,
          description: 'Workflow uses outdated actions/checkout@v2 or v3 which may fail on modern Node runtimes.',
          file: relPath,
          line,
          severity: 'medium',
          remediation: 'Upgrade to actions/checkout@v4',
          pocSnippet: 'Verify workflow triggers with v4 checkout',
          prPotentialScore: 92,
        });
      }

      // Check actions/setup-node@v1, v2 or v3
      if (content.includes('actions/setup-node@v1') || content.includes('actions/setup-node@v2') || content.includes('actions/setup-node@v3')) {
        const line = findLineNumber(content, 'actions/setup-node@v');
        findings.push({
          id: `ci-setup-node-${file.replace(/[^a-zA-Z0-9]/g, '_')}`,
          probeName: 'workflow-linter',
          category: 'ci_workflow',
          title: `Upgrade deprecated actions/setup-node in ${file}`,
          description: 'Workflow uses deprecated setup-node version.',
          file: relPath,
          line,
          severity: 'low',
          remediation: 'Upgrade to actions/setup-node@v4',
          prPotentialScore: 88,
        });
      }
    }
  } catch {
    // Ignore read errors
  }

  return findings;
}

function findLineNumber(content: string, substring: string): number {
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(substring)) {
      return i + 1;
    }
  }
  return 1;
}

// ── Builtin probe registry (OCP) ──────────────────────────────────────────────
//
// Each entry maps a probe `name` *and* its `execution.transformer` to a runner.
// Adding a new builtin probe is a one-line addition here — the dispatch loop in
// `runProbes` never branches on probe identity.
//
// The `accumulated` parameter exposes the findings collected so far, preserving
// the original `piolium` behavior (it builds a PoC from the first prior finding).

export type BuiltinRunner = (
  probe: ProbeManifest,
  targetPath: string,
  fingerprint: RepoFingerprint,
  accumulated: NormalizedFinding[],
) => NormalizedFinding[] | Promise<NormalizedFinding[]>;

const BUILTIN_RUNNERS: Record<string, BuiltinRunner> = {
  'workflow-linter': (_probe, targetPath) => runBuiltinWorkflowLinter(targetPath),
  'builtin:workflow': (_probe, targetPath) => runBuiltinWorkflowLinter(targetPath),

  'git-hotspot': (_probe, targetPath) => runGitHotspotBuiltin(targetPath),
  'builtin:hotspot': (_probe, targetPath) => runGitHotspotBuiltin(targetPath),

  'property-fuzz': (_probe, targetPath, fingerprint) => runPropertyFuzzBuiltin(targetPath, fingerprint),
  'builtin:fuzz': (_probe, targetPath, fingerprint) => runPropertyFuzzBuiltin(targetPath, fingerprint),

  'piolium': (_probe, _targetPath, fingerprint, accumulated) =>
    runPioliumBuiltin(fingerprint, accumulated),
  'builtin:piolium': (_probe, _targetPath, fingerprint, accumulated) =>
    runPioliumBuiltin(fingerprint, accumulated),
};

function runGitHotspotBuiltin(targetPath: string): NormalizedFinding[] {
  const hotspotResult = analyzeGitHotspots(targetPath, { limit: 5 });
  const out: NormalizedFinding[] = [];
  for (const h of hotspotResult.topHotspots) {
    if (h.riskLevel === 'critical' || h.riskLevel === 'high') {
      out.push({
        id: `hotspot-${h.file.replace(/[^a-zA-Z0-9]/g, '_')}`,
        probeName: 'git-hotspot',
        category: 'lifecycle_leak',
        title: `High-Risk Defect Hotspot: ${h.file} (Score: ${h.hotspotScore})`,
        description: `File has ${h.commitsCount} recent commits and cyclomatic complexity ${h.cyclomaticComplexity}. High likelihood (${h.defectLikelihood}%) of concurrency/boundary bugs.`,
        file: h.file,
        line: 1,
        severity: h.riskLevel === 'critical' ? 'high' : 'medium',
        remediation: `Focus exploration on '${h.file}', inspect recent diffs by ${h.topContributors.join(', ')}.`,
        prPotentialScore: Math.min(80 + Math.round(h.hotspotScore / 10), 98),
      });
    }
  }
  return out;
}

function runPropertyFuzzBuiltin(targetPath: string, fingerprint: RepoFingerprint): NormalizedFinding[] {
  const lang = (fingerprint.primaryLanguage.toLowerCase() || 'typescript') as any;
  const fuzzSpec = generatePropertyTest(
    'numerical_bounds',
    ['typescript', 'javascript', 'python', 'rust', 'go'].includes(lang) ? lang : 'typescript',
  );
  return [
    {
      id: `fuzz-numerical-bounds`,
      probeName: 'property-fuzz',
      category: 'numerical_bounds',
      title: `Property-Based Invariant Verification: ${fuzzSpec.framework}`,
      description: `Generated property fuzzing harness targeting NaN/-0.0/Inf boundary attacks.`,
      file: 'tests/property_bounds.test',
      line: 1,
      severity: 'medium',
      pocSnippet: fuzzSpec.codeSnippet,
      prPotentialScore: 90,
    },
  ];
}

function runPioliumBuiltin(
  fingerprint: RepoFingerprint,
  accumulated: NormalizedFinding[],
): NormalizedFinding[] {
  const targetFinding: NormalizedFinding =
    accumulated[0] ||
    {
      id: `piolium-${fingerprint.primaryLanguage.toLowerCase()}`,
      probeName: 'piolium',
      category: 'security_cwe',
      title: `Adversarial PoC & Invariant Verification: ${fingerprint.primaryLanguage}`,
      file: 'tests/property_bounds.test',
      line: 1,
      severity: 'medium',
      prPotentialScore: 92,
    };
  const poc = constructPoCForFinding(targetFinding);
  const adv = verifyFindingAdversarially(targetFinding);
  return [
    {
      id: `poc-${targetFinding.id}`,
      probeName: 'piolium',
      category: targetFinding.category,
      title: `Autonomous Fail-First Reproduction PoC: ${targetFinding.title}`,
      description: `Constructed executable failure reproduction harness targeting boundary vulnerabilities with adversarial validation (Confidence: ${adv.confidenceScore}%).`,
      file: poc.pocFileName,
      line: 1,
      severity: targetFinding.severity,
      pocSnippet: poc.pocCode,
      remediation: `Verify with: ${poc.executionCommand}`,
      prPotentialScore: adv.confidenceScore,
    },
  ];
}
