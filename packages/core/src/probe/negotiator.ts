import { spawnSync } from 'child_process';
import type { ProbeManifest, RepoFingerprint, ProbeNegotiationPlan, SkippedProbeInfo, ProbeCost, ProbeStage } from './types.js';
import { ProbeRegistry } from './registry.js';
import { discoverDocker } from '../discovery/docker-discovery.js';

export interface NegotiateOptions {
  only?: string[];
  skip?: string[];
  maxCost?: ProbeCost;
  stage?: ProbeStage;
  checkBinaries?: boolean; // Default true
}

const COST_RANK: Record<ProbeCost, number> = {
  fast: 1,
  medium: 2,
  deep: 3,
};

const binaryCache = new Map<string, boolean>();

function isBinaryAvailable(binary: string): boolean {
  if (binaryCache.has(binary)) {
    return binaryCache.get(binary)!;
  }
  try {
    const isWindows = process.platform === 'win32';
    const cmd = isWindows ? 'where.exe' : 'command';
    const args = isWindows ? ['-q', binary] : ['-v', binary];
    const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000 });
    binaryCache.set(binary, result.status === 0);
    return result.status === 0;
  } catch {
    binaryCache.set(binary, false);
    return false;
  }
}

const DOCKER_SUPPORTED_PROBES = new Set([
  'semgrep',
  'ruff',
  'knip',
  'ast-grep',
  'go-analyzers',
  'nilaway',
  'bodyclose',
  'cargo-deny',
]);

function canExecuteProbe(probe: ProbeManifest): boolean {
  if (!probe.activation.requiresBinaries || probe.activation.requiresBinaries.length === 0) {
    return true;
  }

  // 1. Direct host binary match
  const anyDirect = probe.activation.requiresBinaries.some((bin) => isBinaryAvailable(bin));
  if (anyDirect) return true;

  // 2. Ephemeral fallbacks (uvx for semgrep/ruff, npx/bun for knip/ast-grep)
  if (probe.name === 'semgrep' || probe.name === 'ruff') {
    if (isBinaryAvailable('uv')) return true;
  }
  if (probe.name === 'knip' || probe.name === 'ast-grep') {
    if (isBinaryAvailable('npx') || isBinaryAvailable('bun')) return true;
  }

  // 3. Docker container fallback if Docker daemon is active
  if (DOCKER_SUPPORTED_PROBES.has(probe.name)) {
    try {
      const docker = discoverDocker();
      if (docker.found) return true;
    } catch {}
  }

  return false;
}

export function negotiateProbes(
  fingerprint: RepoFingerprint,
  options: NegotiateOptions = {},
  registry?: ProbeRegistry,
): ProbeNegotiationPlan {
  const reg = registry || new ProbeRegistry();
  const allProbes = reg.listAll();

  const selectedProbes: ProbeManifest[] = [];
  const skippedProbes: SkippedProbeInfo[] = [];

  const repoLangsLower = new Set(fingerprint.languages.map((l) => l.language.toLowerCase()));
  if (fingerprint.primaryLanguage && fingerprint.primaryLanguage !== 'unknown') {
    repoLangsLower.add(fingerprint.primaryLanguage.toLowerCase());
  }
  const manifestsSet = new Set(fingerprint.manifests);

  for (const probe of allProbes) {
    if (options.skip && options.skip.includes(probe.name)) {
      skippedProbes.push({
        name: probe.name,
        reason: 'user_skipped',
        details: 'Explicitly skipped via --skip option',
      });
      continue;
    }

    if (options.only && options.only.length > 0 && !options.only.includes(probe.name)) {
      skippedProbes.push({
        name: probe.name,
        reason: 'user_skipped',
        details: 'Not included in --only filter',
      });
      continue;
    }

    if (options.maxCost && COST_RANK[probe.execution.cost] > COST_RANK[options.maxCost]) {
      skippedProbes.push({
        name: probe.name,
        reason: 'cost_filtered',
        details: `Cost ${probe.execution.cost} exceeds maximum requested cost ${options.maxCost}`,
      });
      continue;
    }

    const probeLangs = probe.activation.languages.map((l) => l.toLowerCase());
    const isUniversal = probeLangs.includes('*');
    const hasLangMatch = isUniversal || probeLangs.some((l) => repoLangsLower.has(l));

    if (!hasLangMatch) {
      skippedProbes.push({
        name: probe.name,
        reason: 'language_mismatch',
        details: `Repository languages [${Array.from(repoLangsLower).join(', ')}] do not match probe targets [${probe.activation.languages.join(', ')}]`,
      });
      continue;
    }

    if (probe.activation.manifestFiles && probe.activation.manifestFiles.length > 0) {
      const hasRequiredManifest = probe.activation.manifestFiles.some((m) => manifestsSet.has(m));
      if (!hasRequiredManifest) {
        skippedProbes.push({
          name: probe.name,
          reason: 'manifest_missing',
          details: `Requires at least one manifest: [${probe.activation.manifestFiles.join(', ')}], found [${Array.from(manifestsSet).join(', ')}]`,
        });
        continue;
      }
    }

    const checkBin = options.checkBinaries !== false;
    if (checkBin && !canExecuteProbe(probe)) {
      skippedProbes.push({
        name: probe.name,
        reason: 'binary_not_found',
        details: `Required binary [${probe.activation.requiresBinaries?.join(' or ')}] is not installed in PATH, available via ephemeral runners, or supported via Docker`,
      });
      continue;
    }

    selectedProbes.push(probe);
  }

  let estimatedDurationMs = 0;
  for (const p of selectedProbes) {
    if (p.execution.cost === 'fast') estimatedDurationMs += 2000;
    else if (p.execution.cost === 'medium') estimatedDurationMs += 8000;
    else estimatedDurationMs += 25000;
  }

  return {
    target: fingerprint.repoPath,
    fingerprint,
    selectedProbes,
    skippedProbes,
    estimatedDurationMs,
  };
}
