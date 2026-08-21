export type ContributionRunPhase =
  | 'INITIALIZED'
  | 'OPPORTUNITY_SCOUTED'
  | 'PROBE_COMPLETED'
  | 'CONTEXT_ASSEMBLED'
  | 'WORKSPACE_PREPARED'
  | 'POC_GENERATED'
  | 'PATCH_DRAFTED'
  | 'EVIDENCE_COLLECTED'
  | 'GOVERNANCE_AUDITED'
  | 'PR_SUBMITTED'
  | 'COMPLETED'
  | 'FAILED';

export interface ContributionRunManifest {
  schemaVersion: string;
  runId: string;
  repoFullName: string;
  issueNumber?: number;
  issueTitle?: string;
  currentPhase: ContributionRunPhase;
  createdAt: string;
  updatedAt: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export type ArtifactType =
  | 'opportunity'
  | 'probe'
  | 'context'
  | 'workspace'
  | 'poc'
  | 'patch'
  | 'evidence'
  | 'governance'
  | 'pr_draft'
  | 'result';

export interface SavedArtifactResult {
  runId: string;
  artifactType: ArtifactType;
  filePath: string;
  savedAt: string;
  byteSize: number;
}

export interface RunEvent {
  eventId: string;
  runId: string;
  timestamp: string;
  phase: ContributionRunPhase;
  eventType: string;
  payload?: Record<string, unknown>;
}

export interface ContributionRunSummary {
  manifest: ContributionRunManifest;
  artifacts: {
    opportunity?: Record<string, unknown>;
    context?: Record<string, unknown>;
    workspace?: Record<string, unknown>;
    patch?: string;
    evidence?: Record<string, unknown>;
    governance?: Record<string, unknown>;
    prDraft?: string;
    result?: Record<string, unknown>;
  };
  events?: RunEvent[];
  availableArtifactFiles: string[];
}
