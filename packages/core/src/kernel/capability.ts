/**
 * OpenContrib Capability Taxonomy & Provider Specification
 * Defines standard agent capabilities, cost profiles, and scoring heuristics.
 */

import type { RepoFingerprint, DefectCategory } from './contract.js';

export type CapabilityType =
  | 'security.static-analysis'
  | 'concurrency.leak-detection'
  | 'lifecycle.resource-leak'
  | 'bug.reproduction'
  | 'forensics.git-hotspot'
  | 'testing.property-fuzz'
  | 'ci.workflow-lint'
  | 'architecture.dead-code';

export interface CapabilityCostProfile {
  cpu: 'low' | 'medium' | 'heavy';
  token: 'zero' | 'low'; // Deterministic native scanners have 'zero' token cost
  typicalLatencyMs: number;
}

export interface CapabilityProviderDescriptor {
  providerId: string;
  name: string;
  capability: CapabilityType;
  defectCategory: DefectCategory;
  languages: string[]; // e.g. ['go', 'typescript', 'rust', '*']
  detects: string[]; // e.g. ['npe', 'sql-injection', 'path-traversal', 'deadlock']
  cost: CapabilityCostProfile;
  evidenceTier: 'stub' | 'slice' | 'reproducible_poc';
  isCore: boolean; // Core (fast/deterministic) vs Optional Heavy (CodeQL, etc.)
  scoreProvider: (fingerprint: RepoFingerprint, intent?: string) => number;
}

export interface CapabilityRoutingPlan {
  targetRepo: string;
  primaryLanguage: string;
  summaryLevel0: string[]; // Level 0: ['security', 'concurrency', 'forensics', 'testing']
  selectedCapabilities: Array<{
    capability: CapabilityType;
    provider: CapabilityProviderDescriptor;
    matchScore: number;
    reason: string;
  }>;
  deferredHeavyCapabilities: Array<{
    capability: CapabilityType;
    provider: CapabilityProviderDescriptor;
    matchScore: number;
    reason: string;
  }>;
  estimatedDurationMs: number;
}
