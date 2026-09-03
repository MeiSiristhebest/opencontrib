/**
 * testkit — injectable test doubles for the core ports.
 *
 * These let unit tests exercise domain & application logic with zero network,
 * zero real subprocesses, and deterministic time/ids (see review §15.4).
 */

export { FixedClock } from '../ports/clock.port.js';
export { SequentialIdGenerator } from '../ports/id-generator.port.js';
export type { Clock } from '../ports/clock.port.js';
export type { IdGenerator } from '../ports/id-generator.port.js';

import type { IssueSource, DiscoveredIssue, IssueQuery } from '../ports/issue-source.port.js';

/** In-memory issue source — feed it a fixed list, no network. */
export class InMemoryIssueSource implements IssueSource {
  constructor(private readonly issues: DiscoveredIssue[] = []) {}

  async listIssues(_repoFullName: string, query?: IssueQuery): Promise<DiscoveredIssue[]> {
    let result = this.issues;
    if (query?.state && query.state !== 'all') {
      result = result.filter((i) => i.state === query.state);
    }
    if (query?.labels?.length) {
      result = result.filter((i) => (i.labels ?? []).some((l) => query.labels!.includes(l)));
    }
    if (query?.limit) result = result.slice(0, query.limit);
    return result;
  }
}

import type {
  SandboxProvider,
  SandboxExecutionOptions,
  SandboxExecutionResult,
  SandboxAvailability,
} from '../sandbox/sandbox-runtime.js';

/** Sandbox that replays a pre-arranged queue of execution results. */
export class ScriptedSandboxProvider implements SandboxProvider {
  public readonly name = 'scripted';
  private queue: SandboxExecutionResult[] = [];

  constructor(private readonly script: SandboxExecutionResult[] = []) {
    this.queue = [...script];
  }

  push(result: SandboxExecutionResult): void {
    this.queue.push(result);
  }

  execute(_options: SandboxExecutionOptions): SandboxExecutionResult {
    const next = this.queue.shift();
    if (next) return next;
    return {
      command: _options.command ?? '',
      exitCode: 0,
      passed: true,
      stdout: '',
      stderr: '',
      output: '',
      isSandboxed: true,
      isolationWarnings: [],
    };
  }

  getAvailability(): SandboxAvailability {
    return { available: true, isolationMode: 'SANITIZED_ENVIRONMENT', warnings: [] };
  }

  getDeniedPaths(): string[] {
    return [];
  }

  isPathWithinBoundary(_targetPath: string, _rootBoundary: string): boolean {
    return true;
  }
}

import type { RunRepository } from '../ports/run-repository.port.js';
import type {
  CreateRunInput,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  SavedArtifactResult,
  ArtifactType,
} from '../run/types.js';

/** In-memory run repository — no filesystem, no ~/.opencontrib writes. */
export class InMemoryRunRepository implements RunRepository {
  private runs = new Map<string, ContributionRunManifest>();
  private artifacts = new Map<string, Record<string, unknown>>();

  resolveRunId(runId?: string): string | undefined {
    return runId ?? undefined;
  }

  createRun(input: CreateRunInput): ContributionRunManifest {
    const runId = `run_mem_${this.runs.size + 1}_${input.repoFullName}`;
    const manifest: ContributionRunManifest = {
      schemaVersion: '1.0.0',
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: 'INITIALIZED',
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      tags: input.tags ?? [],
      metadata: input.metadata ?? {},
    };
    this.runs.set(runId, manifest);
    return manifest;
  }

  getRun(runId: string): ContributionRunSummary | null {
    const manifest = this.runs.get(runId);
    if (!manifest) return null;
    return {
      manifest,
      artifacts: {} as ContributionRunSummary['artifacts'],
      availableArtifactFiles: [],
    };
  }

  listRuns(): ContributionRunManifest[] {
    return Array.from(this.runs.values());
  }

  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
    _autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult {
    const existing = this.artifacts.get(runId) ?? {};
    existing[type] = typeof content === 'string' ? { content } : content;
    this.artifacts.set(runId, existing);
    return {
      runId,
      artifactType: type,
      filePath: `memory://${runId}/${type}`,
      savedAt: new Date(0).toISOString(),
      byteSize: JSON.stringify(content).length,
    };
  }

  updateRunPhase(runId: string, newPhase: ContributionRunPhase): ContributionRunManifest {
    const manifest = this.runs.get(runId);
    if (!manifest) throw new Error(`Run ${runId} does not exist`);
    manifest.currentPhase = newPhase;
    return manifest;
  }
}
