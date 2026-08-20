import type { RepoFingerprint } from './contract.js';
import type {
  CapabilityType,
  CapabilityProviderDescriptor,
  CapabilityRoutingPlan,
} from './capability.js';

export class CapabilityRouter {
  private providers = new Map<string, CapabilityProviderDescriptor>();

  public registerProvider(provider: CapabilityProviderDescriptor): void {
    this.providers.set(provider.providerId, provider);
  }

  public unregisterProvider(providerId: string): boolean {
    return this.providers.delete(providerId);
  }

  public getProvider(providerId: string): CapabilityProviderDescriptor | undefined {
    return this.providers.get(providerId);
  }

  public listProviders(): CapabilityProviderDescriptor[] {
    return Array.from(this.providers.values());
  }

  /**
   * Progressive Level 0 Disclosure (~15 tokens)
   * High-level capability domains available on host
   */
  public getLevel0Domains(): string[] {
    const domains = new Set<string>();
    for (const p of this.providers.values()) {
      const rootDomain = p.capability.split('.')[0];
      domains.add(rootDomain);
    }
    return Array.from(domains);
  }

  /**
   * Progressive Level 1 Disclosure (~40 tokens)
   * Lists fine-grained capability types
   */
  public getLevel1Capabilities(): CapabilityType[] {
    const types = new Set<CapabilityType>();
    for (const p of this.providers.values()) {
      types.add(p.capability);
    }
    return Array.from(types);
  }

  /**
   * Capability Scoring Engine & Intelligent Route Planning
   * Evaluates language matching, cost profiles, and repository characteristics.
   */
  public planRouting(
    fingerprint: RepoFingerprint,
    options: { intent?: string; maxDurationMs?: number; enableHeavy?: boolean } = {},
  ): CapabilityRoutingPlan {
    const primaryLang = (fingerprint?.primaryLanguage || 'unknown').toLowerCase();
    const selected: CapabilityRoutingPlan['selectedCapabilities'] = [];
    const deferred: CapabilityRoutingPlan['deferredHeavyCapabilities'] = [];

    // Group providers by capability type
    const byCapability = new Map<CapabilityType, CapabilityProviderDescriptor[]>();
    for (const p of this.providers.values()) {
      if (!byCapability.has(p.capability)) {
        byCapability.set(p.capability, []);
      }
      byCapability.get(p.capability)!.push(p);
    }

    let totalEstimatedMs = 0;

    for (const [capType, providerList] of byCapability.entries()) {
      for (const provider of providerList) {
        const langMatch =
          provider.languages.includes('*') ||
          provider.languages.map((l) => l.toLowerCase()).includes(primaryLang);

        if (!langMatch) continue;

        const baseScore = provider.scoreProvider(fingerprint, options.intent);

        if (!provider.isCore && provider.cost.cpu === 'heavy' && !options.enableHeavy) {
          deferred.push({
            capability: capType,
            provider,
            matchScore: baseScore,
            reason: 'Heavy scan provider deferred; enable with --enable-heavy or high risk threshold',
          });
        } else if (baseScore >= 50) {
          selected.push({
            capability: capType,
            provider,
            matchScore: baseScore,
            reason: `Optimal provider for ${capType} on ${primaryLang}`,
          });
          totalEstimatedMs += provider.cost.typicalLatencyMs;
        }
      }
    }

    return {
      targetRepo: fingerprint.repoPath,
      primaryLanguage: fingerprint.primaryLanguage,
      summaryLevel0: this.getLevel0Domains(),
      selectedCapabilities: selected,
      deferredHeavyCapabilities: deferred,
      estimatedDurationMs: totalEstimatedMs,
    };
  }
}
