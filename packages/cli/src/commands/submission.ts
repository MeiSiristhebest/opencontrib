/** `opencontrib submission <sub>` — submit only an approved run intent. */

import { Command } from "commander";
import {
  buildAgentSubmissionPort,
  buildContributionRunManager,
  type ContributionRunManager,
  SubmissionIntentArtifactSchema,
} from "@opencontrib/core";
import { printJSON } from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

export const submissionCommand = new Command("submission")
  .description("Submit a PR only from a trusted, approved run intent")
  .command("submit")
  .description("Submit the immutable approved intent for a contribution run")
  .option("--owner <owner>", "Inspection-only upstream owner")
  .option("--repo <repo>", "Inspection-only upstream repository")
  .option("--title <title>", "Inspection-only approved PR title")
  .option("--body <body>", "Inspection-only approved PR body")
  .option("--branch <branch>", "Inspection-only run-owned branch")
  .option("--commit-message <msg>", "Inspection-only approved commit message")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--draft", "Inspection-only approved draft flag")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      owner?: string;
      repo?: string;
      title?: string;
      body?: string;
      branch?: string;
      commitMessage?: string;
      runId?: string;
      draft?: boolean;
      pretty?: boolean;
    }) => {
      try {
        const runManager = getRunManager();
        const runId = runManager.resolveRunId(opts.runId);
        if (!runId) {
          console.error(
            "❌ No runId found in active session or --run-id option.",
          );
          throw new CliExitError(1);
        }

        const run = runManager.getRun(runId);
        const intentResult = SubmissionIntentArtifactSchema.safeParse(
          run?.artifacts.submissionIntent,
        );
        if (!intentResult.success) {
          throw new Error(
            "No immutable SubmissionIntentArtifact found. Run governance request-approval first; this command never creates or edits a submission payload.",
          );
        }
        const intent = intentResult.data;
        const checks: Array<[string, unknown, unknown]> = [
          ["title", opts.title, intent.title],
          ["body", opts.body, intent.body],
          ["branch", opts.branch, intent.branchName],
          ["commit-message", opts.commitMessage, intent.commitMessage],
          ["draft", opts.draft, intent.isDraft],
        ];
        for (const [name, supplied, approved] of checks) {
          if (supplied !== undefined && supplied !== approved) {
            throw new Error(
              `SubmissionIntentMismatchError: --${name} differs from the approved intent.`,
            );
          }
        }

        // Agent-facing CLI code never receives a GitHub credential and never
        // performs a provider write. The trusted host/broker owns both.
        const submissionArtifact = await buildAgentSubmissionPort(
          runManager,
        ).submit(runId, intent.intentSha256);

        printJSON(
          {
            status: "success",
            prNumber: submissionArtifact.prNumber,
            prUrl: submissionArtifact.prUrl,
            headSha: submissionArtifact.headSha,
            verified: submissionArtifact.verified,
          },
          opts.pretty,
        );
      } catch (err: any) {
        if (err instanceof CliExitError) throw err;
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );
