import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import type { EvidenceReport, RedEvidence } from "../contracts/schemas.js";
import {
  captureRedEvidence,
  verifyGreenEvidence,
  collectEvidence,
} from "./evidence-collector.js";

export interface CaptureRedInput {
  runId: string;
  cwd: string;
  testCommand: string;
  expectedAssertion?: string;
  testFile?: string;
  testFileSha256?: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
}

export interface VerifyGreenInput {
  runId: string;
  cwd: string;
  testCommand: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
}

export class EvidenceService {
  constructor(private readonly runManager: ContributionRunManager) {}

  /**
   * Capture authoritative RED baseline.
   * Only EvidenceService can write `evidence_red`.
   */
  captureRed(input: CaptureRedInput): RedEvidence {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }

    const red = captureRedEvidence({
      cwd: input.cwd,
      testCommand: input.testCommand,
      workspaceRoot: input.workspaceRoot,
      expectedAssertion: input.expectedAssertion,
      testFileSha256: input.testFileSha256,
      baselineCommitSha: input.baselineCommitSha,
      testFile: input.testFile,
    });

    // Save authoritative evidence_red artifact
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "evidence_red",
      red as any,
    );

    // Also update partial evidence report for convenience (does not advance phase)
    saveCanonicalArtifact(this.runManager, input.runId, "evidence", {
      baselineTestedAt: red.capturedAt,
      baselineFlakyTests: [],
      stressLoopRuns: 0,
      stressLoopPassed: false,
      handleLeakCheckPassed: true,
      passedUnitTestsCount: 0,
      redEvidence: red,
      reproductionVerified: false,
      allTestsPassing: false,
    });

    return red;
  }

  /**
   * Verify GREEN and bind it to the captured RED baseline.
   * Reads RED strictly from the trusted `evidence_red` artifact or `evidence.redEvidence`.
   * On verified reproduction, advances run phase to EVIDENCE_COLLECTED.
   */
  async verifyGreen(input: VerifyGreenInput): Promise<EvidenceReport> {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }

    // Load trusted RED evidence from evidence_red or evidence artifact
    const redEvidence = (run.artifacts?.evidenceRed ||
      run.artifacts?.evidence?.redEvidence) as RedEvidence | undefined;

    if (!redEvidence || !redEvidence.sourceTreeSha256) {
      throw new Error(
        `No authoritative RED baseline found for run ${input.runId}. Call EvidenceService.captureRed() first.`,
      );
    }

    const green = verifyGreenEvidence({
      cwd: input.cwd,
      testCommand: input.testCommand,
      workspaceRoot: input.workspaceRoot,
      redEvidence,
      stressLoopCount: input.stressLoopCount ?? 1,
      concurrencyWorkers: input.concurrencyWorkers ?? 1,
    });

    const full = await collectEvidence({
      cwd: input.cwd,
      workspaceRoot: input.workspaceRoot,
      baselineCommitSha: input.baselineCommitSha,
      testCommand: input.testCommand,
      stressLoopCount: input.stressLoopCount ?? 1,
      concurrencyWorkers: input.concurrencyWorkers ?? 1,
    });

    const report: EvidenceReport = {
      ...full,
      redEvidence,
      greenEvidence: green.greenEvidence,
      reproductionVerified:
        green.reproductionVerified && Boolean(full.allTestsPassing),
      allTestsPassing: Boolean(full.allTestsPassing),
    };

    if (report.reproductionVerified === true) {
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        report as any,
        "EVIDENCE_COLLECTED",
      );
    } else {
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        report as any,
      );
    }

    return report;
  }
}
