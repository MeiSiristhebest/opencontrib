import { existsSync, readdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { ArtifactBundleManager } from './artifact-bundle.js';
import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  SavedArtifactResult,
} from './types.js';

export interface CreateRunInput {
  repoFullName: string;
  issueNumber?: number;
  issueTitle?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface ResumeRunResult {
  runId: string;
  currentPhase: ContributionRunPhase;
  manifest: ContributionRunManifest;
  availableArtifacts: ArtifactType[];
  latestArtifactSummary: {
    hasOpportunity: boolean;
    hasContext: boolean;
    hasWorkspace: boolean;
    hasPatch: boolean;
    hasEvidence: boolean;
    hasGovernance: boolean;
    hasPrDraft: boolean;
    hasResult: boolean;
  };
  suggestedNextAction: string;
}

export class ContributionRunManager {
  private bundleManager: ArtifactBundleManager;
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || join(homedir(), '.opencontrib', 'runs');
    this.bundleManager = new ArtifactBundleManager(this.baseDir);
  }

  generateRunId(repoFullName: string, issueNumber?: number): string {
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const cleanRepo = repoFullName.replace(/[^a-zA-Z0-9]/g, '_').toLowerCase();
    const issueSuffix = issueNumber ? `_issue_${issueNumber}` : '';
    const randomSuffix = Math.random().toString(36).substring(2, 6);
    return `run_${timestamp}_${cleanRepo}${issueSuffix}_${randomSuffix}`;
  }

  createRun(input: CreateRunInput): ContributionRunManifest {
    const runId = this.generateRunId(input.repoFullName, input.issueNumber);
    const now = new Date().toISOString();

    const manifest: ContributionRunManifest = {
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: 'INITIALIZED',
      createdAt: now,
      updatedAt: now,
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };

    this.bundleManager.saveManifest(manifest);
    return manifest;
  }

  updateRunPhase(runId: string, newPhase: ContributionRunPhase): ContributionRunManifest {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    manifest.currentPhase = newPhase;
    manifest.updatedAt = new Date().toISOString();
    this.bundleManager.saveManifest(manifest);
    return manifest;
  }

  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
    autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult {
    const manifest = this.bundleManager.readManifest(runId);
    if (!manifest) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }

    const saved = this.bundleManager.saveArtifact(runId, type, content);

    if (autoAdvancePhase) {
      this.updateRunPhase(runId, autoAdvancePhase);
    } else {
      // Map artifact type to natural next phase if manifest is behind
      manifest.updatedAt = new Date().toISOString();
      this.bundleManager.saveManifest(manifest);
    }

    return saved;
  }

  getRun(runId: string): ContributionRunSummary | null {
    return this.bundleManager.getRunSummary(runId);
  }

  listRuns(): ContributionRunManifest[] {
    if (!existsSync(this.baseDir)) {
      return [];
    }

    const entries = readdirSync(this.baseDir);
    const manifests: ContributionRunManifest[] = [];

    for (const entry of entries) {
      const manifest = this.bundleManager.readManifest(entry);
      if (manifest) {
        manifests.push(manifest);
      }
    }

    return manifests.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  resumeRun(runId: string): ResumeRunResult {
    const summary = this.bundleManager.getRunSummary(runId);
    if (!summary) {
      throw new Error(`Contribution run ${runId} not found`);
    }

    const artifacts = summary.artifacts;
    const availableTypes: ArtifactType[] = [];

    if (artifacts.opportunity) availableTypes.push('opportunity');
    if (artifacts.context) availableTypes.push('context');
    if (artifacts.workspace) availableTypes.push('workspace');
    if (artifacts.patch) availableTypes.push('patch');
    if (artifacts.evidence) availableTypes.push('evidence');
    if (artifacts.governance) availableTypes.push('governance');
    if (artifacts.prDraft) availableTypes.push('pr_draft');
    if (artifacts.result) availableTypes.push('result');

    let suggestedAction = 'assemble_context';
    switch (summary.manifest.currentPhase) {
      case 'INITIALIZED':
        suggestedAction = 'scout_opportunity';
        break;
      case 'OPPORTUNITY_SCOUTED':
        suggestedAction = 'assemble_context';
        break;
      case 'CONTEXT_ASSEMBLED':
        suggestedAction = 'prepare_workspace';
        break;
      case 'WORKSPACE_PREPARED':
        suggestedAction = 'draft_patch';
        break;
      case 'PATCH_DRAFTED':
        suggestedAction = 'collect_evidence';
        break;
      case 'EVIDENCE_COLLECTED':
        suggestedAction = 'audit_governance';
        break;
      case 'GOVERNANCE_AUDITED':
        suggestedAction = 'render_pr_and_submit';
        break;
      case 'PR_SUBMITTED':
      case 'COMPLETED':
        suggestedAction = 'sync_flywheel';
        break;
      default:
        suggestedAction = 'inspect_artifacts';
    }

    return {
      runId: summary.manifest.runId,
      currentPhase: summary.manifest.currentPhase,
      manifest: summary.manifest,
      availableArtifacts: availableTypes,
      latestArtifactSummary: {
        hasOpportunity: !!artifacts.opportunity,
        hasContext: !!artifacts.context,
        hasWorkspace: !!artifacts.workspace,
        hasPatch: !!artifacts.patch,
        hasEvidence: !!artifacts.evidence,
        hasGovernance: !!artifacts.governance,
        hasPrDraft: !!artifacts.prDraft,
        hasResult: !!artifacts.result,
      },
      suggestedNextAction: suggestedAction,
    };
  }
}
