/**
 * testkit — injectable test doubles for the core ports.
 *
 * These let unit tests exercise domain & application logic with zero network,
 * zero real subprocesses, and deterministic time/ids (see review §15.4).
 */

export { FixedClock } from "../ports/clock.port.js";
export { SequentialIdGenerator } from "../ports/id-generator.port.js";
export type { Clock } from "../ports/clock.port.js";
export type { IdGenerator } from "../ports/id-generator.port.js";

import type {
  IssueSource,
  DiscoveredIssue,
  IssueQuery,
} from "../ports/issue-source.port.js";

/** In-memory issue source — feed it a fixed list, no network. */
export class InMemoryIssueSource implements IssueSource {
  constructor(private readonly issues: DiscoveredIssue[] = []) {}

  async listIssues(
    _repoFullName: string,
    query?: IssueQuery,
  ): Promise<DiscoveredIssue[]> {
    let result = this.issues;
    if (query?.state && query.state !== "all") {
      result = result.filter((i) => i.state === query.state);
    }
    if (query?.labels?.length) {
      result = result.filter((i) =>
        (i.labels ?? []).some((l) => query.labels!.includes(l)),
      );
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
} from "../sandbox/sandbox-runtime.js";

/** Sandbox that replays a pre-arranged queue of execution results. */
export class ScriptedSandboxProvider implements SandboxProvider {
  public readonly name = "scripted";
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
      command: _options.command ?? "",
      exitCode: 0,
      passed: true,
      stdout: "",
      stderr: "",
      output: "",
      isSandboxed: true,
      isolationWarnings: [],
    };
  }

  getAvailability(): SandboxAvailability {
    return {
      available: true,
      isolationMode: "SANITIZED_ENVIRONMENT",
      warnings: [],
    };
  }

  getDeniedPaths(): string[] {
    return [];
  }

  isPathWithinBoundary(_targetPath: string, _rootBoundary: string): boolean {
    return true;
  }
}

import type { RunRepository } from "../ports/run-repository.port.js";
import type {
  CreateRunInput,
  ContributionRunManifest,
  ContributionRunSummary,
  SavedArtifactResult,
  ArtifactType,
} from "../run/types.js";

/** In-memory run repository — no filesystem, no ~/.opencontrib writes. */
export class InMemoryRunRepository implements RunRepository {
  private runs = new Map<string, ContributionRunManifest>();
  private artifacts = new Map<string, Record<string, unknown>>();

  /** Draft artifact kinds have one server-owned phase mapping. */
  private static readonly draftPhaseByArtifact: Partial<
    Record<ArtifactType, ContributionRunManifest["currentPhase"]>
  > = {
    opportunity: "OPPORTUNITY_SCOUTED",
    probe: "PROBE_COMPLETED",
    context: "CONTEXT_ASSEMBLED",
    poc: "POC_GENERATED",
    patch: "PATCH_DRAFTED",
  };

  private static readonly allowedDraftSources: Record<string, string[]> = {
    OPPORTUNITY_SCOUTED: ["INITIALIZED"],
    PROBE_COMPLETED: ["INITIALIZED", "OPPORTUNITY_SCOUTED"],
    CONTEXT_ASSEMBLED: [
      "INITIALIZED",
      "OPPORTUNITY_SCOUTED",
      "PROBE_COMPLETED",
    ],
    POC_GENERATED: ["WORKSPACE_PREPARED"],
    PATCH_DRAFTED: ["RED_CAPTURED"],
  };

  resolveRunId(runId?: string): string | undefined {
    return runId ?? undefined;
  }

  createRun(input: CreateRunInput): ContributionRunManifest {
    const runId = `run_mem_${this.runs.size + 1}_${input.repoFullName}`;
    const manifest: ContributionRunManifest = {
      schemaVersion: "1.0.0",
      runId,
      repoFullName: input.repoFullName,
      issueNumber: input.issueNumber,
      issueTitle: input.issueTitle,
      currentPhase: "INITIALIZED",
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
    const stored = this.artifacts.get(runId) ?? {};
    const artifacts = { ...stored } as ContributionRunSummary["artifacts"];
    if ((artifacts as any).pr_draft && !(artifacts as any).prDraft) {
      (artifacts as any).prDraft = (artifacts as any).pr_draft;
      delete (artifacts as any).pr_draft;
    }
    return {
      manifest,
      artifacts,
      availableArtifactFiles: Object.keys(stored),
    };
  }

  listRuns(): ContributionRunManifest[] {
    return Array.from(this.runs.values());
  }

  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
  ): SavedArtifactResult {
    if (
      [
        "workspace",
        "validated_patch",
        "evidence_red",
        "evidence",
        "governance",
        "submission_intent",
        "approval",
        "submission",
        "result",
      ].includes(type)
    ) {
      throw new Error(`AuthoritativeArtifactViolationError: ${type}`);
    }
    if (!this.runs.has(runId)) throw new Error(`Run ${runId} does not exist`);
    const manifest = this.runs.get(runId)!;
    const derivedPhase = InMemoryRunRepository.draftPhaseByArtifact[type];
    if (
      derivedPhase &&
      manifest.currentPhase !== derivedPhase &&
      !InMemoryRunRepository.allowedDraftSources[derivedPhase]?.includes(
        manifest.currentPhase,
      )
    ) {
      throw new Error(
        `[PhaseGateViolation] Run ${runId} cannot save '${type}' from phase '${manifest.currentPhase}'.`,
      );
    }

    const existing = this.artifacts.get(runId) ?? {};
    const key = type === "pr_draft" ? "prDraft" : type;
    existing[key] = content;
    this.artifacts.set(runId, existing);

    if (
      derivedPhase &&
      manifest.currentPhase !== derivedPhase &&
      InMemoryRunRepository.allowedDraftSources[derivedPhase]?.includes(
        manifest.currentPhase,
      )
    ) {
      manifest.currentPhase = derivedPhase;
      manifest.updatedAt = new Date().toISOString();
    }

    return {
      runId,
      artifactType: type,
      filePath: `memory://${runId}/${type}`,
      savedAt: new Date(0).toISOString(),
      byteSize: JSON.stringify(content).length,
    };
  }
}
