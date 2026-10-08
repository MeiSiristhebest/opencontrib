/** `opencontrib scout <target>` — Discover high-value contribution opportunities. */

import { Command, Argument } from "commander";
import {
  scoutOpportunities,
  buildContributionRunManager,
  type ContributionRunManager,
} from "@opencontrib/core";
import { printJSON, printPhaseGuidance } from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

export const scoutCommand = new Command("scout")
  .description(
    "Scout high-value, unclaimed contribution opportunities for the run repository",
  )
  .addArgument(
    new Argument("[target]", "Repository full name (owner/repo), matching the run"),
  )
  .option("-r, --repo <target>", "Target repository (owner/repo), matching the run")
  .option(
    "--tech-stack <list>",
    "Developer tech stack keywords, comma-separated",
    (v) => v.split(","),
  )
  .option("--focus <list>", "Focus areas, comma-separated", (v) => v.split(","))
  .option("--limit <n>", "Max candidates to return", (v) => Number(v), 5)
  .option("--min-stars <n>", "Minimum repository stars", (v) => Number(v), 50)
  .option("--token <token>", "GitHub token (or set GITHUB_TOKEN env)")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--include-attempted", "Include issues even if previously attempted in local runs", false)
  .option("--pretty", "Pretty-print", false)
  .action(
    async (
      targetArg: string | undefined,
      opts: {
        repo?: string;
        techStack?: string[];
        focus?: string[];
        limit?: number;
        minStars?: number;
        token?: string;
        runId?: string;
        includeAttempted?: boolean;
        pretty?: boolean;
      },
    ) => {
      try {
        const target = targetArg || opts.repo;
        if (!target) {
          throw new CliExitError(
            1,
            "Target repository is required: provide <target> argument or --repo <target>",
          );
        }
        const runId = getRunManager().resolveRunId(opts.runId);
        if (!runId || !getRunManager().getRun(runId)) {
          throw new Error("An existing contribution run is required before scouting; create a run first.");
        }
        getRunManager().assertRepositoryTarget(runId, target);
        const profile = {
          techStack: opts.techStack ?? ["typescript", "javascript"],
          focusAreas: opts.focus ?? ["bugfix", "testing", "docs"],
          proficiency: "intermediate" as const,
          minMatchScore: 60,
        };
        const opportunities = await scoutOpportunities(profile, {
          repo: target,
          limit: opts.limit ?? 5,
          minStars: opts.minStars ?? 0,
          githubToken: opts.token || process.env.GITHUB_TOKEN,
          excludeCompletedRuns: !opts.includeAttempted,
        });

        if (opportunities.length > 0) {
          getRunManager().saveArtifact(runId, "opportunity", {
            target,
            opportunities,
            topOpportunity: opportunities[0],
          });
        }

        printJSON(
          {
            status: "success",
            target,
            foundCount: opportunities.length,
            opportunities,
          },
          opts.pretty,
        );

        const top = opportunities[0];
        const nextCmd = top
          ? `opencontrib workspace prepare --repo ${top.repoFullName} --issue ${top.issueNumber}`
          : `opencontrib workspace prepare --repo ${target} --issue <id>`;

        printPhaseGuidance({
          currentPhase: getRunManager().getRun(runId)!.manifest.currentPhase,
          runId,
          status: opportunities.length > 0 ? "SUCCESS" : "WARNING",
          humanCheckpoint: "Checkpoint 1 (Candidate Issue Selection)",
          nextCommand: nextCmd,
          forbiddenActions: [
            "DO NOT select issues that have existing PRs or active claims by other developers.",
            "DO NOT begin editing without preparing an isolated Git worktree.",
          ],
        });
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );
