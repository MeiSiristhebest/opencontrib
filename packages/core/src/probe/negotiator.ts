import { execSync } from 'child_process';
import type { ProbeManifest, RepoFingerprint, ProbeNegotiationPlan, SkippedProbeInfo, ProbeCost, ProbeStage } from './types.js';
import { ProbeRegistry } from './registry.js';

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
    const cmd = isWindows ? `where.exe ${binary}` : `which ${binary}`;
    execSync(cmd, { stdio: 'ignore' });
    binaryCache.set(binary, true);
    return true;
  } catch {
    binaryCache.set(binary, false);
    return false;
  }
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
    // 1. Check user explicit skip
    if (options.skip && options.skip.includes(probe.name)) {
      skippedProbes.push({
        name: probe.name,
        reason: 'user_skipped',
        details: 'Explicitly skipped via --skip option',
      });
      continue;
    }

    // 2. Check user explicit only
    if (options.only && options.only.length > 0 && !options.only.includes(probe.name)) {
      skippedProbes.push({
        name: probe.name,
        reason: 'user_skipped',
        details: 'Not included in --only filter',
      });
      continue;
    }

    // 3. Check cost filter
    if (options.maxCost && COST_RANK[probe.execution.cost] > COST_RANK[options.maxCost]) {
      skippedProbes.push({
        name: probe.name,
        reason: 'cost_filtered',
        details: `Cost ${probe.execution.cost} exceeds maximum requested cost ${options.maxCost}`,
      });
      continue;
    }

    // 4. Check Language match
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

    // 5. Check Manifest file requirement if specified
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

    // 6. Check Binary availability if required
    const checkBin = options.checkBinaries !== false;
    if (checkBin && probe.activation.requiresBinaries && probe.activation.requiresBinaries.length > 0) {
      // If any of the alternative binaries is available
      const anyBinaryFound = probe.activation.requiresBinaries.some((bin) => isBinaryAvailable(bin));
      if (!anyBinaryFound) {
        skippedProbes.push({
          name: probe.name,
          reason: 'binary_not_found',
          details: `Required binary [${probe.activation.requiresBinaries.join(' or ')}] is not installed or not in PATH`,
        });
        continue;
      }
    }

    selectedProbes.push(probe);
  }

  // Calculate estimated duration
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
