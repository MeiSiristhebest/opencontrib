import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { join } from "path";

import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import {
  ContributionRecordSchema,
  EvidenceReportSchema,
  ResultArtifactSchema,
  SubmissionArtifactSchema,
  type ContributionRecord,
} from "../contracts/schemas.js";
import type { ContributionRunManager } from "../run/run-manager.js";
import { getOpenContribDataDir } from "../kernel/home.js";

export class ProfileFlywheel {
  private ledgerPath: string;

  constructor() {
    const dir = getOpenContribDataDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.ledgerPath = join(dir, "contributions.json");
  }

  loadRecords(): ContributionRecord[] {
    if (!existsSync(this.ledgerPath)) return [];
    try {
      const data = JSON.parse(readFileSync(this.ledgerPath, "utf-8"));
      if (!Array.isArray(data)) {
        throw new Error(`[ProfileSync] Ledger file is not an array`);
      }
      return data;
    } catch (err: any) {
      // Propagate to saveRecord() so it knows the read failed (vs genuinely empty).
      // Returning [] from here and then writing back in saveRecord() causes total data wipe.
      throw new Error(
        `[ProfileSync] CRITICAL: Failed to load ledger: ${err.message}`,
      );
    }
  }

  saveRecord(record: ContributionRecord): void {
    const validated = ContributionRecordSchema.parse(record);
    let records: ContributionRecord[];
    try {
      records = this.loadRecords();
    } catch {
      // If ledger is unreadable, we cannot safely append — would overwrite with a single entry.
      throw new Error(
        `[ProfileSync] Cannot save record: failed to load existing ledger. Data loss prevention.`,
      );
    }
    const existingIndex = records.findIndex(
      (r) => r.id === validated.id || (r.prUrl && r.prUrl === validated.prUrl),
    );
    if (existingIndex >= 0) {
      records[existingIndex] = validated;
    } else {
      records.unshift(validated);
    }
    const tmpPath = this.ledgerPath + ".tmp";
    try {
      writeFileSync(tmpPath, JSON.stringify(records, null, 2), "utf-8");
      renameSync(tmpPath, this.ledgerPath);
    } catch {
      try {
        unlinkSync(tmpPath);
      } catch {}
      throw new Error(
        `Failed to save contribution record to ${this.ledgerPath}`,
      );
    }
  }

  renderProfileMarkdown(
    records: ContributionRecord[] = this.loadRecords(),
  ): string {
    const mergedRecords = records.filter((r) => r.status === "merged");

    if (mergedRecords.length === 0) {
      return `<!-- START_OPENCONTRIB_SECTION -->
### 🚀 Open Source Contributions
*Active contributions are tracked in local ledger. Merged contributions will be displayed here.*
<!-- END_OPENCONTRIB_SECTION -->`;
    }

    let md = `<!-- START_OPENCONTRIB_SECTION -->
### 🚀 Open Source Contributions (Live Flywheel)

> **Merged Contributions**: 🌟 ${mergedRecords.length}

| Repository | Issue / Contribution | PR | Status | Merged Date |
| :--- | :--- | :--- | :--- | :--- |
`;

    for (const r of mergedRecords.slice(0, 10)) {
      const issueText = r.issueNumber
        ? `#${r.issueNumber} ${r.issueTitle}`
        : r.issueTitle;
      const prText = r.prNumber ? `#${r.prNumber}` : "View PR";
      md += `| [\`${r.repoFullName}\`](https://github.com/${r.repoFullName}) | ${issueText} | [${prText}](${r.prUrl}) | 🟣 **Merged** | \`${r.submittedAt.split("T")[0]}\` |\n`;
    }

    md += `\n*Updated automatically via [OpenContrib Engine](https://github.com/MeiSiristhebest/opencontrib)*\n<!-- END_OPENCONTRIB_SECTION -->`;

    return md;
  }

  renderBadgeSvg(records: ContributionRecord[] = this.loadRecords()): string {
    const mergedCount = records.filter((r) => r.status === "merged").length;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="28" viewBox="0 0 180 28" fill="none">
  <rect width="180" height="28" rx="6" fill="#18181B"/>
  <text x="12" y="18" fill="#A1A1AA" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="500">OpenContrib</text>
  <rect x="95" y="4" width="75" height="20" rx="4" fill="#8B5CF6"/>
  <text x="132" y="18" fill="#FFFFFF" font-family="system-ui, -apple-system, sans-serif" font-size="12" font-weight="700" text-anchor="middle">★ ${mergedCount} Merged</text>
</svg>`;
  }

  syncFromRun(
    runManager: ContributionRunManager,
    runId: string,
  ): { success: boolean; recordCount: number; record: ContributionRecord } {
    const run = runManager.getRun(runId);
    if (!run) throw new Error(`Unknown contribution run: ${runId}`);
    if (run.manifest.currentPhase !== "PR_SUBMITTED" && run.manifest.currentPhase !== "COMPLETED") {
      throw new Error(
        `FlywheelSyncError: run ${runId} is not submission-verified (phase ${run.manifest.currentPhase}).`,
      );
    }
    const submissionResult = SubmissionArtifactSchema.safeParse(run.artifacts.submission);
    if (!submissionResult.success || submissionResult.data.verified !== true) {
      throw new Error(
        "FlywheelSyncError: only a verified canonical submission may enter the profile ledger.",
      );
    }
    const evidenceResult = EvidenceReportSchema.safeParse(run.artifacts.evidence);
    if (!evidenceResult.success || evidenceResult.data.reproductionVerified !== true) {
      throw new Error(
        "FlywheelSyncError: canonical verified evidence is required before profile ingestion.",
      );
    }

    const submission = submissionResult.data;
    const evidence = evidenceResult.data;
    const existingResult = ResultArtifactSchema.safeParse(run.artifacts.result);
    if (!existingResult.success) {
      const result = {
        runId,
        submission,
        submissionVerified: true as const,
        prNumber: submission.prNumber,
        prUrl: submission.prUrl,
        completedAt: new Date().toISOString(),
      };
      ResultArtifactSchema.parse(result);
      saveCanonicalArtifact(runManager, runId, "result", result, "COMPLETED");
    }
    const record: ContributionRecord = {
      id: runId,
      repoFullName: run.manifest.repoFullName,
      issueNumber: run.manifest.issueNumber,
      issueTitle: run.manifest.issueTitle || "Open Source Contribution",
      prNumber: submission.prNumber,
      prUrl: submission.prUrl,
      status: "submitted",
      submittedAt: submission.submittedAt,
      diffStat: `verified head ${submission.headSha}`,
      evidenceSummary: `reproduction verified; ${evidence.stressLoopRuns} stress loop run(s); all tests passing=${evidence.allTestsPassing === true}`,
      provenance: {
        source: "system_recorded",
        verified: true,
        verifiedAt: new Date().toISOString(),
      },
    };
    this.saveRecord(record);
    return { success: true, recordCount: this.loadRecords().length, record };
  }
}
