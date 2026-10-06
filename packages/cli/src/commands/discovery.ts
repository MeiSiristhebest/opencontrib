/** `opencontrib discovery <sub>` — Opportunity scoring, qualification, context assembly. */

import { Command } from "commander";
import {
  assessFeasibility,
  detectSystemCapabilities,
  diagnoseManifests,
  qualifyIssue,
  rankOpportunitySignals,
} from "@opencontrib/core";
import { printJSON, parseJSON, readStdin } from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

function normalizeRepoFullName(value: unknown): string | undefined {
  return typeof value === "string"
    ? value.trim().replace(/\.git$/i, "").toLowerCase()
    : undefined;
}

// ─── Sub-commands (defined before discoveryCommand to avoid TDZ) ───────────────

const rankCommand = new Command("rank")
  .description("Rank an opportunity by multi-dimensional probability signals")
  .option(
    "--input <json>",
    "JSON object with issue, repository, developerProfile (or pipe via stdin)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(async (opts: { pretty?: boolean }) => {
    try {
      const input = (opts as any).input ?? (await readStdin());
      const parsed = parseJSON(input, "stdin") as any;
      if (!parsed?.issue) {
        console.error('❌ Missing required "issue" field in input JSON');
        throw new CliExitError(1);
      }
      const repoObj = parsed.repository || parsed.repo;
      const normalizedRepo = {
        fullName: repoObj?.fullName || "unknown/unknown",
        stars: repoObj?.stars ?? repoObj?.starsCount ?? 0,
        primaryLanguage: repoObj?.primaryLanguage,
      };
      const signals = rankOpportunitySignals({
        issue: parsed.issue,
        repository: normalizedRepo,
        developerProfile: parsed.developerProfile,
      });
      printJSON({ status: "success", signals }, opts.pretty);
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

const qualifyCommand = new Command("qualify")
  .description(
    "Check author-first-right, anti-bandwagoning, and blocking labels",
  )
  .option("--input <json>", "JSON object with issue data (or pipe via stdin)")
  .option("--pretty", "Pretty-print", false)
  .action(async (opts: { pretty?: boolean }) => {
    try {
      const input = (opts as any).input ?? (await readStdin());
      const parsed = parseJSON(input, "stdin") as any;
      if (!parsed?.issueNumber || !parsed.issueTitle) {
        console.error(
          '❌ Missing required "issueNumber" and "issueTitle" in input JSON',
        );
        throw new CliExitError(1);
      }
      const qualification = qualifyIssue(parsed);
      printJSON(
        {
          status: qualification.isQualified ? "qualified" : "disqualified",
          qualification,
        },
        opts.pretty,
      );
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

const feasibilityCommand = new Command("feasibility")
  .description("Assess OS and toolchain execution feasibility for an issue")
  .requiredOption("--title <text>", "Issue title")
  .option("--body <text>", "Issue body text", "")
  .option("--labels <list>", "Issue labels, comma-separated", (v) =>
    v.split(","),
  )
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      title: string;
      body?: string;
      labels?: string[];
      pretty?: boolean;
    }) => {
      try {
        const capabilities = detectSystemCapabilities();
        const assessment = assessFeasibility(
          opts.title,
          opts.body || "",
          opts.labels || [],
          capabilities,
        );
        printJSON(
          {
            status: "success",
            assessment,
            localCapabilities: {
              os: capabilities.os,
              hasWsl: capabilities.hasWsl,
              hasDocker: capabilities.hasDocker,
            },
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

const contextCommand = new Command("context")
  .description(
    "Assemble multi-dimensional context for an issue (problem, repo skeleton, test targets)",
  )
  .option(
    "--input <json>",
    "JSON with issue, repoDetails, repoTree (or pipe via stdin)",
  )
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: { input?: string; runId?: string; pretty?: boolean }) => {
      try {
        const input = (opts as any).input ?? (await readStdin());
        const parsed = parseJSON(input, "stdin") as any;
        if (!parsed?.issue || !parsed.repoDetails) {
          console.error(
            '❌ Missing required "issue" and "repoDetails" in input JSON',
          );
          throw new CliExitError(1);
        }
        const {
          ContextAssembler,
          buildContributionRunManager,
          isPreparedRepositoryWorkspace,
          runRepositoryGit,
        } = await import("@opencontrib/core");
        const assembler = new ContextAssembler();
        const runManager = buildContributionRunManager();
        const runId = runManager.resolveRunId(opts.runId);
        const requestedRepoFullName =
          parsed.repoDetails.fullName ||
          `${parsed.repoDetails.owner}/${parsed.repoDetails.repo}`;
        const run = runId ? runManager.getRun(runId) : undefined;
        if (runId && !run) {
          throw new Error(`Contribution run ${runId} was not found.`);
        }
        const runRepo = normalizeRepoFullName(run?.manifest.repoFullName);
        const requestedRepo = normalizeRepoFullName(requestedRepoFullName);
        const workspace = run?.artifacts.workspace;
        const workspaceRepo = normalizeRepoFullName(
          workspace?.repoFullName,
        );
        if (
          runId &&
          (!runRepo || runRepo !== requestedRepo ||
            (workspace && (!workspaceRepo || workspaceRepo !== requestedRepo))
        )) {
          throw new Error(
            `Contribution run ${runId} is bound to ${run?.manifest.repoFullName || "an unknown repository"}, but the request names ${requestedRepoFullName}.`,
          );
        }
        if (
          runId &&
          run?.manifest.issueNumber !== undefined &&
          Number(parsed.issue.number) !== run.manifest.issueNumber
        ) {
          throw new Error(
            `Contribution run ${runId} is bound to issue #${run.manifest.issueNumber}, but the request names issue #${parsed.issue.number}.`,
          );
        }
        const workspacePath = workspace?.workspacePath;
        if (
          runId &&
          (typeof workspacePath !== "string" ||
            typeof workspace?.repoFullName !== "string" ||
            typeof workspace.baseCommitSha !== "string" ||
            !isPreparedRepositoryWorkspace(workspacePath, {
              repoFullName: workspace.repoFullName,
              baseCommitSha: workspace.baseCommitSha,
            }))
        ) {
          throw new Error(
            `Contribution run ${runId} has no prepared workspace matching its recorded repository and base commit; prepare the workspace before assembling context.`,
          );
        }
        const repoTree = (parsed.repoTree || []).map((item: any) => ({
          path: item.path,
          mode: "100644",
          type: item.type as any,
          ...(item.sha ? { sha: item.sha } : {}),
        }));
        const context = await assembler.assembleContext({
          issue: {
            number: parsed.issue.number,
            title: parsed.issue.title,
            body: parsed.issue.body,
            labels: parsed.issue.labels || [],
            isOpen: true,
            assignees: [],
            createdAt: parsed.issue.createdAt || new Date().toISOString(),
            comments: parsed.issue.comments || [],
          },
          repoDetails: {
            ...parsed.repoDetails,
            fullName: requestedRepoFullName,
          },
          repoTree,
          workspacePath: typeof workspacePath === "string" ? workspacePath : undefined,
          runGit: typeof workspacePath === "string" ? runRepositoryGit : undefined,
        });

        if (runId) {
          runManager.saveArtifact(runId, "context", context as any);
        }

        printJSON({ status: "success", context }, opts.pretty);
      } catch (err: any) {
        if (err instanceof CliExitError) throw err;
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

const manifestsCommand = new Command("manifests")
  .description(
    "Diagnose repo manifests (workflows, package.json, pyproject, etc.) for ≤100-line PR improvements",
  )
  .option(
    "--input <json>",
    "JSON with workflows, readmeContent, packageJsonContent, etc. (or pipe via stdin)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(async (opts: { pretty?: boolean }) => {
    try {
      const input = (opts as any).input ?? (await readStdin());
      const parsed = parseJSON(input, "stdin") as any;
      const result = diagnoseManifests(parsed || {});
      printJSON(result, opts.pretty);
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const discoveryCommand = new Command("discovery")
  .description("Opportunity scoring, qualification, and context assembly")
  .addCommand(rankCommand)
  .addCommand(qualifyCommand)
  .addCommand(feasibilityCommand)
  .addCommand(contextCommand)
  .addCommand(manifestsCommand);
