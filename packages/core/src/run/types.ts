export type ContributionRunPhase =
  | 'INITIALIZED'
  | 'OPPORTUNITY_SCOUTED'
  | 'CONTEXT_ASSEMBLED'
  | 'WORKSPACE_PREPARED'
  | 'PATCH_DRAFTED'
  | 'EVIDENCE_COLLECTED'
  | 'GOVERNANCE_AUDITED'
  | 'PR_SUBMITTED'
  | 'COMPLETED'
  | 'FAILED';

export interface ContributionRunManifest {
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
  | 'context'
  | 'workspace'
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
  availableArtifactFiles: string[];
}
