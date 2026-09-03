/**
 * RunRepository port — persistence seam for contribution-run manifests, artifacts
 * and phase transitions. `ContributionRunManager` is the filesystem-backed
 * implementation; `InMemoryRunRepository` (testkit) is the test double.
 */

import type {
  CreateRunInput,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  SavedArtifactResult,
  ArtifactType,
} from '../run/types.js';

export interface RunRepository {
  resolveRunId(runId?: string): string | undefined;
  createRun(input: CreateRunInput): ContributionRunManifest;
  getRun(runId: string): ContributionRunSummary | null;
  listRuns(): ContributionRunManifest[];
  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
    autoAdvancePhase?: ContributionRunPhase,
  ): SavedArtifactResult;
  updateRunPhase(runId: string, newPhase: ContributionRunPhase): ContributionRunManifest;
}
