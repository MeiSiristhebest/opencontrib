/** `opencontrib submission <sub>` — Authorize and submit PR via the verified service. */

import { Command } from "commander";
import {
  GitHubClient,
  GitHubSubmissionService,
  ContributionPrService,
  buildContributionRunManager,
  type ContributionRunManager,
  type GitTreeEntry,
} from "@opencontrib/core";
import { printJSON } from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

/**
 * Structural view of the trusted "patch" artifact (a JSON-serialized PatchDraft).
 * Kept local (not imported) because contracts/index does not re-export llm-schemas.
 */
interface TrustedPatchShape {
  title?: string;
  files?: Array<{
    path?: unknown;
    content?: unknown;
    operation?: unknown;
  }>;
}

/**
 * Provenance boundary: the PR payload files must come from the trusted
 * "patch" artifact recorded on the run — NEVER from free caller input.
 * Fail-closed: throws when the artifact is missing, unparseable, or has
 * zero usable file entries (we never open an empty PR).
 */
function loadTrustedSubmissionPayload(
  runId: string,
): { files: GitTreeEntry[]; commitMessage: string } {
  const run = getRunManager().getRun(runId);
  const patchRaw = run?.artifacts?.patch;
  if (typeof patchRaw !== "string" || patchRaw.trim() === "") {
    throw new Error(
      `No trusted patch artifact found for run ${runId}. ` +
        "Complete the patch-draft stage before submitting.",
    );
  }

  let patch: TrustedPatchShape;
  try {
    patch = JSON.parse(patchRaw) as TrustedPatchShape;
  } catch {
    throw new Error(
      `Trusted patch artifact for run ${runId} is not a parseable PatchDraft; ` +
        "refusing to submit without trusted file contents.",
    );
  }

  const files: GitTreeEntry[] = (patch.files ?? [])
    .filter(
      (f) =>
        !!f &&
        typeof f.path === "string" &&
        f.path.trim() !== "" &&
        typeof f.content === "string",
    )
    .map((f) => ({
      path: f.path as string,
      content: f.content as string,
      mode: "100644" as const,
    }));

  if (files.length === 0) {
    throw new Error(
      `Trusted patch for run ${runId} contains no file contents; refusing to open an empty PR.`,
    );
  }

  const commitMessage =
    typeof patch.title === "string" && patch.title.trim() !== ""
      ? patch.title.trim()
      : "chore: opencontrib contribution";

  return { files, commitMessage };
}

export const submissionCommand = new Command("submission")
  .description(
    "Authorize and submit pull request through verified GitHubSubmissionService",
  )
  .command("submit")
  .description("Authorize and submit PR for an audited contribution run")
  .requiredOption("--owner <owner>", "Target upstream repository owner")
  .requiredOption("--repo <repo>", "Target upstream repository name")
  .requiredOption("--title <title>", "PR title")
  .option("--body <body>", "PR body text or markdown (falls back to trusted pr_draft artifact)")
  .requiredOption("--branch <branch>", "Branch name to submit")
  .option("--commit-message <msg>", "Commit message (defaults to trusted patch title)")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--draft", "Create as draft PR", false)
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      owner: string;
      repo: string;
      title: string;
      body?: string;
      branch: string;
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

        // Provenance: files + default commit message come from the trusted patch artifact.
        const trusted = loadTrustedSubmissionPayload(runId);
        const files = trusted.files;
        const commitMessage = opts.commitMessage ?? trusted.commitMessage;

        // Prefer the trusted pr_draft artifact for the body; fall back to the free flag.
        const run = runManager.getRun(runId);
        const prDraftRaw = run?.artifacts?.prDraft;
        const body =
          typeof prDraftRaw === "string" && prDraftRaw.trim() !== ""
            ? prDraftRaw
            : opts.body ?? "";

        const client = new GitHubClient();
        const prService = new ContributionPrService(client);
        const submissionService = new GitHubSubmissionService(
          prService,
          client,
          runManager,
        );

        // 1. Authorize submission first (zero external side effects if gates or approvals fail).
        const permit = submissionService.authorizeSubmission(
          runId,
          opts.owner,
          opts.repo,
        );

        // 2. Submit and verify PR with provider (fail-closed).
        const result = await submissionService.submitAndVerifyPullRequest({
          runId,
          permit,
          submissionOptions: {
            upstreamOwner: opts.owner,
            upstreamRepo: opts.repo,
            title: opts.title,
            body,
            branchName: opts.branch,
            files,
            commitMessage,
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
