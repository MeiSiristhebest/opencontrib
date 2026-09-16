import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  SavedArtifactResult,
} from "./types.js";
import type { ContributionRunManager } from "./run-manager.js";

/**
 * Private application-layer capability used by canonical artifact services.
 * This module is deliberately not re-exported from the core barrel: agent-facing
 * CLI/MCP code can only use the generic RunManager API, which refuses
 * authoritative artifact types.
 */
export interface CanonicalRunWriter {
  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
    autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult;
  transition(
    runId: string,
    targetPhase: ContributionRunPhase,
  ): ContributionRunManifest;
}

const writers = new WeakMap<object, CanonicalRunWriter>();

export function registerCanonicalRunWriter(
  manager: ContributionRunManager,
  writer: CanonicalRunWriter,
): void {
  writers.set(manager, writer);
}

function getWriter(manager: ContributionRunManager): CanonicalRunWriter {
  const writer = writers.get(manager);
  if (!writer) {
    throw new Error(
      "CanonicalRunWriterUnavailableError: run manager is not wired through the composition root.",
    );
  }
  return writer;
}

export function saveCanonicalArtifact(
  manager: ContributionRunManager,
  runId: string,
  type: ArtifactType,
  content: string | Record<string, unknown>,
  autoAdvancePhase?: ContributionRunPhase,
): SavedArtifactResult {
  const authoritativeTypes = new Set<ArtifactType>([
    "evidence_red",
    "evidence",
    "governance",
    "submission_intent",
    "approval",
    "submission",
    "result",
  ]);
  if (!authoritativeTypes.has(type)) {
    throw new Error(
      `CanonicalArtifactTypeError: '${type}' is not an authoritative artifact type.`,
    );
  }
  return getWriter(manager).saveArtifact(
    runId,
    type,
    content,
    autoAdvancePhase,
  );
}

export function transitionCanonicalRun(
  manager: ContributionRunManager,
  runId: string,
  targetPhase: ContributionRunPhase,
): ContributionRunManifest {
  return getWriter(manager).transition(runId, targetPhase);
}
