import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  SavedArtifactResult,
} from './types.js';

export class ArtifactBundleManager {
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || join(homedir(), '.opencontrib', 'runs');
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  getRunDir(runId: string): string {
    return join(this.baseDir, runId);
  }

  ensureRunDir(runId: string): string {
    const dir = this.getRunDir(runId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getArtifactFilename(type: ArtifactType): string {
    switch (type) {
      case 'opportunity':
        return 'opportunity.json';
      case 'context':
        return 'context.json';
      case 'workspace':
        return 'workspace.json';
      case 'patch':
        return 'patch.diff';
      case 'evidence':
        return 'evidence.json';
      case 'governance':
        return 'governance.json';
      case 'pr_draft':
        return 'pr_draft.md';
      case 'result':
        return 'result.json';
      default:
        return `${type}.json`;
    }
  }

  saveArtifact(runId: string, type: ArtifactType, content: string | Record<string, unknown>): SavedArtifactResult {
    const runDir = this.ensureRunDir(runId);
    const filename = this.getArtifactFilename(type);
    const filePath = join(runDir, filename);

    const stringContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
    writeFileSync(filePath, stringContent, 'utf-8');

    return {
      runId,
      artifactType: type,
      filePath,
      savedAt: new Date().toISOString(),
      byteSize: Buffer.byteLength(stringContent, 'utf-8'),
    };
  }

  readArtifact<T = unknown>(runId: string, type: ArtifactType): T | null {
    const runDir = this.getRunDir(runId);
    const filename = this.getArtifactFilename(type);
    const filePath = join(runDir, filename);

    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, 'utf-8');
    if (type === 'patch' || type === 'pr_draft') {
      return content as unknown as T;
    }

    try {
      return JSON.parse(content) as T;
    } catch {
      return content as unknown as T;
    }
  }

  saveManifest(manifest: ContributionRunManifest): void {
    const runDir = this.ensureRunDir(manifest.runId);
    const manifestPath = join(runDir, 'manifest.json');
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
  }

  readManifest(runId: string): ContributionRunManifest | null {
    const runDir = this.getRunDir(runId);
    const manifestPath = join(runDir, 'manifest.json');
    if (!existsSync(manifestPath)) {
      return null;
    }
    try {
      return JSON.parse(readFileSync(manifestPath, 'utf-8')) as ContributionRunManifest;
    } catch {
      return null;
    }
  }

  listArtifactFiles(runId: string): string[] {
    const runDir = this.getRunDir(runId);
    if (!existsSync(runDir)) {
      return [];
    }
    return readdirSync(runDir);
  }

  getRunSummary(runId: string): ContributionRunSummary | null {
    const manifest = this.readManifest(runId);
    if (!manifest) {
      return null;
    }

    return {
      manifest,
      artifacts: {
        opportunity: this.readArtifact(runId, 'opportunity') ?? undefined,
        context: this.readArtifact(runId, 'context') ?? undefined,
        workspace: this.readArtifact(runId, 'workspace') ?? undefined,
        patch: this.readArtifact(runId, 'patch') ?? undefined,
        evidence: this.readArtifact(runId, 'evidence') ?? undefined,
        governance: this.readArtifact(runId, 'governance') ?? undefined,
        prDraft: this.readArtifact(runId, 'pr_draft') ?? undefined,
        result: this.readArtifact(runId, 'result') ?? undefined,
      },
      availableArtifactFiles: this.listArtifactFiles(runId),
    };
  }
}
