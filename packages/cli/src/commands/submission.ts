import { Command } from "commander";
import { getRunManager } from "../utils/context.js";
import { printJSON } from "../utils/printer.js";
import { CliExitError } from "../utils/exit.js";
import {
  GitHubSubmissionService,
  GitHubClient,
  ContributionPrService,
} from "@opencontrib/core";

export const submissionCommand = new Command("submission")
  .description(
    "Authorize and submit pull request through verified GitHubSubmissionService",
  )
  .command("submit")
  .description("Authorize and submit PR for an audited contribution run")
  .requiredOption("--owner <owner>", "Target upstream repository owner")
  .requiredOption("--repo <repo>", "Target upstream repository name")
  .requiredOption("--title <title>", "PR title")
  .requiredOption("--body <body>", "PR body text or markdown")
  .requiredOption("--branch <branch>", "Branch name to submit")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--draft", "Create as draft PR", false)
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      owner: string;
      repo: string;
      title: string;
      body: string;
      branch: string;
      runId?: string;
      draft?: boolean;
      pretty?: boolean;
    }) => {
      try {
        const runId = getRunManager().resolveRunId(opts.runId);
        if (!runId) {
          console.error(
            "❌ No runId found in active session or --run-id option.",
          );
          throw new CliExitError(1);
        }

        const runManager = getRunManager();
        const client = new GitHubClient();
        const prService = new ContributionPrService(client);
        const submissionService = new GitHubSubmissionService(
          prService,
          client,
          runManager,
        );

        // 1. Authorize submission first (zero external side effects if gates or approvals fail)
        const permit = submissionService.authorizeSubmission(
          runId,
          opts.owner,
          opts.repo,
        );

        // 2. Submit and verify PR with provider (fail-closed)
        const result = await submissionService.submitAndVerifyPullRequest({
          runId,
          permit,
          submissionOptions: {
            upstreamOwner: opts.owner,
            upstreamRepo: opts.repo,
            title: opts.title,
            body: opts.body,
            branchName: opts.branch,
            isDraft: opts.draft ?? false,
          },
        });

        printJSON(
          {
            status: "success",
            prNumber: result.submissionArtifact.prNumber,
            prUrl: result.submissionArtifact.prUrl,
            headSha: result.submissionArtifact.headSha,
            verified: result.submissionArtifact.verified,
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
