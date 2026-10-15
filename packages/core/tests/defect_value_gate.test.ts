import { describe, expect, it } from 'bun:test';
import {
  evaluateDefectSignificance,
  type DefectEvaluationInput,
} from '../src/domain/defect-value-gate.js';
import { triagePointerFindings } from '../src/probe/triage.js';
import type { PointerStub } from '../src/kernel/contract.js';

describe('Universal Open-Source Defect & Contribution Rubric (ODCR v2.0)', () => {
  describe('The 6 Deadly Anti-Patterns Enforcement', () => {
    it('rejects TRIVIAL_UNWRAP_SWALLOWING that masks errors with unwrap_or_default', () => {
      const input: DefectEvaluationInput = {
        title: 'fix(core): avoid panic by using unwrap_or_default',
        description: 'Calling .unwrap() might panic, so we replace it with unwrap_or_default()',
        proposedFix: 'let val = opt.unwrap_or_default();',
        isInternalPrivateScope: true,
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('TRIVIAL_UNWRAP_SWALLOWING');
      expect(result.rejectionReasons[0]).toMatch(/masks underlying logic errors/i);
    });

    it('rejects TRIVIAL_UNWRAP_SWALLOWING that catches exceptions and returns false silently', () => {
      const input: DefectEvaluationInput = {
        title: 'fix: swallow error in private parser',
        description: 'wrap with try/catch to avoid throwing',
        proposedFix: 'try { doParse(); } catch { return false; }',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('TRIVIAL_UNWRAP_SWALLOWING');
    });

    it('rejects GHOST_HUNTING_DEFENSE when adding speculative null checks in internal scope', () => {
      const input: DefectEvaluationInput = {
        title: 'fix: add null check just in case',
        description: 'defensively check if argument is null to be safe',
        isInternalPrivateScope: true,
        isPublicApiOrCli: false,
        hasExecutableRepro: false,
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('GHOST_HUNTING_DEFENSE');
      expect(result.rejectionReasons.some((r) => r.includes('Ghost-hunting defensive checks'))).toBe(true);
    });

    it('rejects SPECULATIVE_OVER_ENGINEERING in minimal-core repositories', () => {
      const input: DefectEvaluationInput = {
        title: 'refactor: introduce abstract factory for tool providers',
        description: 'redesign architecture with extensible provider framework and new configuration flag',
        communityPhilosophy: 'minimal_core',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('SPECULATIVE_OVER_ENGINEERING');
      expect(result.rejectionReasons.some((r) => r.includes('Minimal Core philosophy'))).toBe(true);
    });

    it('rejects STYLE_LINTER_CHURN that pollutes git blame', () => {
      const input: DefectEvaluationInput = {
        title: 'style: clean up whitespace and organize imports',
        description: 'reformatting files according to linter rules',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('STYLE_LINTER_CHURN');
    });

    it('rejects NO_REPRODUCER_THEORETICAL complaints lacking executable proof', () => {
      const input: DefectEvaluationInput = {
        title: 'fix: handle edge case that could hypothetically fail',
        description: 'theoretically possible for state to drift if unexpected inputs occur',
        hasExecutableRepro: false,
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('NO_REPRODUCER_THEORETICAL');
    });

    it('rejects AI_BOILERPLATE_FLUFF that signals automated PR spam', () => {
      const input: DefectEvaluationInput = {
        title: 'fix(core): resolve nullability',
        description: 'As an AI language model, I have carefully analyzed the codebase and crafted a solution.',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.detectedAntiPatterns).toContain('AI_BOILERPLATE_FLUFF');
    });
  });

  describe('5-Tier Real Defect Value Hierarchy', () => {
    it('accepts Tier 1 critical systemic breaches with top score (e.g. SSRF / RCE / Auth Bypass)', () => {
      const input: DefectEvaluationInput = {
        title: 'fix(security): bracketed IPv6 allows SSRF filter bypass',
        description: 'CWE-918: unstripped brackets on IPv6 host allow bypassing loopback blocklist',
        isPublicApiOrCli: true,
        hasExecutableRepro: true,
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(true);
      expect(result.tier).toBe('tier1_critical');
      expect(result.significanceScore).toBeGreaterThanOrEqual(95);
      expect(result.detectedAntiPatterns).toHaveLength(0);
    });

    it('accepts Tier 2 concurrency & lifecycle bugs (e.g. infinite spin / deadlock / descriptor leak)', () => {
      const input: DefectEvaluationInput = {
        title: 'fix(agent): acquireTrustLockSync busy-waits on Date.now() with 100% CPU spin',
        description: 'frozen fake timers cause infinite loop and process hang without releasing lock',
        isPublicApiOrCli: true,
        hasExecutableRepro: true,
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(true);
      expect(result.tier).toBe('tier2_concurrency');
      expect(result.significanceScore).toBeGreaterThanOrEqual(85);
    });

    it('accepts Tier 3 contract drift (e.g. Issue #10947 trust decision short-circuit bug)', () => {
      const input: DefectEvaluationInput = {
        title: 'fix(agent): isProjectTrusted() ignores saved Do-not-trust decision due to short-circuit',
        description: 'with no trust-requiring resources, !hasTrustRequiringResources short-circuits and ignores saved false in trust store',
        isPublicApiOrCli: true,
        hasExecutableRepro: true,
        communityPhilosophy: 'minimal_core',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(true);
      expect(result.tier).toBe('tier3_contract_drift');
      expect(result.significanceScore).toBeGreaterThanOrEqual(75);
    });

    it('accepts Tier 4 cross-platform invariants with verified repro (e.g. NO_PROXY subdomain match)', () => {
      const input: DefectEvaluationInput = {
        title: 'fix(ai): match subdomains and root domains in NO_PROXY',
        description: 'cross-platform HTTP client skips proxy bypass when domain lacks leading dot',
        hasExecutableRepro: true,
        communityPhilosophy: 'minimal_core',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(true);
      expect(result.tier).toBe('tier4_environment');
      expect(result.significanceScore).toBeGreaterThanOrEqual(60);
    });

    it('rejects Tier 5 internal hygiene / trivial comments from being accepted', () => {
      const input: DefectEvaluationInput = {
        title: 'docs: fix typo in README',
        description: 'fix spelling mistake in documentation',
      };

      const result = evaluateDefectSignificance(input);
      expect(result.isAccepted).toBe(false);
      expect(result.tier).toBe('tier5_internal_hygiene');
      expect(result.significanceScore).toBe(0);
    });
  });

  describe('Integration with Probe Triage Engine', () => {
    it('automatically filters out noisy defensive findings and prioritizes high-value pointers', () => {
      const pointers: PointerStub[] = [
        {
          uri: 'file:///repo/src/private.ts#L10',
          title: 'Speculative null check just in case in internal helper',
          description: 'defensively check if argument might be null',
          severity: 'high',
          category: 'dead_code',
          confidence: 90,
          fingerprint: 'fp-1',
        },
        {
          uri: 'file:///repo/src/auth.ts#L42',
          title: 'SSRF filter bypass via bracketed IPv6 (CWE-918)',
          description: 'CWE-918: unstripped brackets on IPv6 host allow bypassing loopback blocklist',
          severity: 'high',
          category: 'security_cwe',
          confidence: 95,
          fingerprint: 'fp-2',
        },
        {
          uri: 'file:///repo/src/sync.ts#L88',
          title: 'Mutex lock held forever causing deadlock under concurrent error',
          description: 'Missing defer Unlock causes deadlock and process freeze',
          severity: 'high',
          category: 'concurrency_race',
          confidence: 90,
          fingerprint: 'fp-3',
        },
      ];

      // Default triage with ODCR gate enabled: fp-1 (defensive ghost check) should be rejected
      const result = triagePointerFindings(pointers, {
        communityPhilosophy: 'minimal_core',
        filterAntiPatterns: true,
      });

      expect(result.triagedCount).toBe(2);
      expect(result.topPointers.map((p) => p.fingerprint)).toEqual(['fp-2', 'fp-3']);
      expect(result.topPointers[0].significance?.tier).toBe('tier1_critical');
      expect(result.topPointers[1].significance?.tier).toBe('tier2_concurrency');
    });
  });
});
