/** `opencontrib flywheel <sub>` — Profile flywheel and PR tracking. */

import { Command } from "commander";
import {
  ProfileFlywheel,
  buildContributionRunManager,
  defaultActiveSessionManager,
  type ContributionRunManager,
} from "@opencontrib/core";
import {
  printJSON,
  parseJSON,
  readStdin,
  printPhaseGuidance,
} from "../utils/output.js";
import * as fs from "fs";

const flywheel = new ProfileFlywheel();
// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

// ─── flywheel sync ────────────────────────────────────────────────────────────
const flywheelSync = new Command("sync")
  .description(
    "Persist contribution memory, update skill weights, refine heuristics",
  )
  .requiredOption("--repo <name>", "Repository full name")
  .option("-f, --input-file <path>", "Path to JSON file containing record")
  .option("--input <json>", "Record JSON (runId, status, techStack, etc.)")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      repo: string;
      inputFile?: string;
      input?: string;
      pretty?: boolean;
    }) => {
      try {
        let input = "";
        if (opts.inputFile && fs.existsSync(opts.inputFile)) {
          input = fs.readFileSync(opts.inputFile, "utf-8");
        } else if (opts.input) {
          input = opts.input;
        } else {
          input = await readStdin();
        }
        const parsed = (parseJSON(input, "stdin/--input") as any) || {};

        const runId = parsed.runId || getRunManager().resolveRunId();
        const status = parsed.status || "submitted";

        if (!runId) {
          console.error(
            "❌ Missing runId (no active session found and not provided in input JSON)",
          );
          process.exit(1);
        }

        const result = await flywheel.recordContribution(opts.repo, {
          id: runId,
          repoFullName: opts.repo,
          issueNumber: parsed.issueNumber,
          issueTitle: parsed.issueTitle || "",
          prNumber: parsed.prNumber,
          prUrl: parsed.prUrl || "",
          status,
          provenance: parsed.provenance || {
            source: "agent_claim",
            verified: false,
          },
          submittedAt: parsed.submittedAt || new Date().toISOString(),
          mergedAt: parsed.mergedAt,
          closedAt: parsed.closedAt,
          diffStat: parsed.diffStat || "",
          evidenceSummary: parsed.evidenceSummary || "",
        } as any);

        // Trust boundary: COMPLETED must be gated on *verified* submission
        // provenance, not merely the presence of agent-supplied prNumber/prUrl.
        // A submission is only "verified" when its provenance marks itself
        // verified (e.g. a Submission V1 service that confirmed the PR via API).
        const provenanceVerified = parsed.provenance?.verified === true;
        const isActualSubmission =
          (Boolean(parsed.prNumber && parsed.prUrl) && provenanceVerified) ||
          status === "merged" ||
          status === "completed";

        let persistenceError: string | undefined;
        if (isActualSubmission) {
          try {
            // First ensure run transitions through PR_SUBMITTED if currently at GOVERNANCE_AUDITED
            const currentRun = getRunManager().getRun(runId);
            if (currentRun?.manifest.currentPhase === "GOVERNANCE_AUDITED") {
              try {
                getRunManager().transition(runId, "PR_SUBMITTED");
              } catch (phaseErr: any) {
                console.warn(
                  `[Flywheel] Could not advance to PR_SUBMITTED: ${phaseErr.message}`,
                );
              }
            }
            getRunManager().saveArtifact(
              runId,
              "result",
              {
                flywheelResult: result,
                status,
                prNumber: parsed.prNumber,
                prUrl: parsed.prUrl,
                submissionVerified: provenanceVerified,
                submissionProvenance: parsed.provenance || {
                  source: "agent_claim",
                  verified: false,
                },
              } as any,
              "COMPLETED",
            );
            defaultActiveSessionManager.updatePhase("COMPLETED", runId);
          } catch (err: any) {
            persistenceError = err.message;
          }
        } else {
          try {
            getRunManager().saveArtifact(runId, "result", {
              flywheelResult: result,
              status,
              submissionVerified: false,
            } as any);
          } catch (err: any) {
            persistenceError = err.message;
          }
        }

        const effectivePhase = persistenceError
          ? getRunManager().getRun(runId)?.manifest.currentPhase ||
            "GOVERNANCE_AUDITED"
          : isActualSubmission
            ? "COMPLETED"
            : "GOVERNANCE_AUDITED";

        printJSON({ status: "success", flywheelResult: result }, opts.pretty);

        printPhaseGuidance({
          currentPhase: effectivePhase,
          runId,
          status: "SUCCESS",
          invariants: [
            effectivePhase === "COMPLETED"
              ? "All 9 phases of OpenContrib contribution engine completed successfully."
              : "Contribution record saved to flywheel memory ledger (awaiting verified PR submission).",
            "Memory ledger and developer heuristics synchronized.",
          ],
        });
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        process.exit(1);
      }
    },
  );

// ─── flywheel pr-track ────────────────────────────────────────────────────────
const prTrackCommand = new Command("pr-track")
  .description("Track PR merge readiness, CI checks, and review feedback")
  .option(
    "-f, --input-file <path>",
    "Path to JSON file containing PR track data",
  )
  .option("--input <json>", "JSON with pr, reviews, checkRuns, comments")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: { inputFile?: string; input?: string; pretty?: boolean }) => {
      try {
        let input = "";
        if (opts.inputFile && fs.existsSync(opts.inputFile)) {
          input = fs.readFileSync(opts.inputFile, "utf-8");
        } else if (opts.input) {
          input = opts.input;
        } else {
          input = await readStdin();
        }
        const parsed = parseJSON(input, "stdin/--input") as any;

        if (!parsed?.pr) {
          console.error('❌ Missing required "pr" field in input JSON');
          process.exit(1);
        }
        const { trackPrStatus } = await import("@opencontrib/core");
        const evaluation = trackPrStatus({
          pr: parsed.pr,
          reviews: (parsed.reviews || []).map((r: any) => ({
            id: r.id,
            user: r.user,
            state: r.state,
            body: r.body,
            submittedAt: r.submittedAt,
          })),
          checkRuns: (parsed.checkRuns || []).map((c: any) => ({
            id: c.id,
            name: c.name,
            status: c.status,
            conclusion: c.conclusion,
            detailsUrl: c.detailsUrl,
          })),
          comments: (parsed.comments || []).map((c: any) => ({
            id: c.id,
            user: c.user,
            body: c.body,
            createdAt: c.createdAt,
          })),
        });
        printJSON({ status: "success", evaluation }, opts.pretty);
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        process.exit(1);
      }
    },
  );

// ─── Top-level command ────────────────────────────────────────────────────────

export const flywheelCommand = new Command("flywheel")
  .description("Profile flywheel persistence and PR lifecycle tracking")
  .addCommand(flywheelSync)
  .addCommand(prTrackCommand);
