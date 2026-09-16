/** `opencontrib flywheel <sub>` — Profile flywheel and PR tracking. */

import { Command } from "commander";
import {
  ProfileFlywheel,
  buildContributionRunManager,
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
  .option("--repo <name>", "Inspection-only expected repository")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("-f, --input-file <path>", "Optional JSON containing only runId/repo")
  .option("--input <json>", "Optional JSON containing only runId/repo")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      repo?: string;
      runId?: string;
      inputFile?: string;
      input?: string;
      pretty?: boolean;
    }) => {
      try {
        let parsed: { runId?: string; repo?: string } = {};
        if (opts.inputFile && fs.existsSync(opts.inputFile)) {
          parsed = (parseJSON(fs.readFileSync(opts.inputFile, "utf-8"), "input-file") as typeof parsed) || {};
        } else if (opts.input) {
          parsed = (parseJSON(opts.input, "--input") as typeof parsed) || {};
        } else if (!opts.runId) {
          const stdin = await readStdin();
          if (stdin.trim()) parsed = (parseJSON(stdin, "stdin") as typeof parsed) || {};
        }

        const runManager = getRunManager();
        const runId = opts.runId || parsed.runId || runManager.resolveRunId();
        if (!runId) {
          throw new Error("Missing runId; provide --run-id or create an active contribution run.");
        }
        const run = runManager.getRun(runId);
        if (!run) throw new Error(`Unknown contribution run: ${runId}`);
        const expectedRepo = opts.repo || parsed.repo;
        if (expectedRepo && expectedRepo.toLowerCase() !== run.manifest.repoFullName.toLowerCase()) {
          throw new Error("FlywheelSyncError: --repo does not match the run manifest.");
        }

        const result = flywheel.syncFromRun(runManager, runId);
        const effectivePhase = runManager.getRun(runId)?.manifest.currentPhase || "COMPLETED";
        printJSON({ status: "success", flywheelResult: result }, opts.pretty);
        printPhaseGuidance({
          currentPhase: effectivePhase,
          runId,
          status: "SUCCESS",
          invariants: [
            "Profile data was derived only from canonical verified submission and evidence artifacts.",
            "The canonical result artifact and completion transition were produced by the trusted flywheel service.",
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
