/** `opencontrib discovery <sub>` — Opportunity scoring, qualification, context assembly. */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import {
  assessFeasibility,
  detectSystemCapabilities,
  diagnoseManifests,
  GitHubClient,
  qualifyIssue,
  rankOpportunitySignals,
} from "@opencontrib/core";
import type { ContributionRunManager } from "@opencontrib/core";
import type { IssueBindingProvider } from "../../../core/src/github/issue-binding-service.js";
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
  .option(
    "--repo <owner/repo>",
    "Target repository full name (e.g. alibaba/open-code-review)",
  )
  .option(
    "--issue <number>",
    "Target issue number to qualify directly against live GitHub",
    (v) => parseInt(v, 10),
  )
  .option("--input <json>", "JSON object with issue data (or pipe via stdin)")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      repo?: string;
      issue?: number;
      input?: string;
      pretty?: boolean;
    }) => {
      try {
        let normalizedInput: any;

        if (opts.repo && typeof opts.issue === "number") {
          const parts = opts.repo.trim().split("/");
          if (parts.length !== 2) {
            console.error('❌ "--repo" must be in the format "owner/repo"');
            throw new CliExitError(1);
          }
          const [owner, repo] = parts;
          const client = new GitHubClient();
          const [issueRes, commentsRes] = await Promise.all([
            client.getIssue(owner, repo, opts.issue),
            client.getIssueComments(owner, repo, opts.issue),
          ]);

          if (issueRes.status !== "OK" || !issueRes.data) {
            console.error(
              `❌ Failed to fetch issue #${opts.issue} from ${opts.repo}: ${issueRes.status} ${issueRes.error || ""}`,
            );
            throw new CliExitError(1);
          }

          const issue = issueRes.data;
          const prsRes = await client.getIssueLinkedPrs(
            owner,
            repo,
            opts.issue,
            2,
            issue.title,
          );
          const comments = (commentsRes.data || []).map((c: any) => ({
            id: c.id,
            body: c.body || "",
            user: { login: c.user?.login },
            author_association: c.author_association,
            created_at: c.created_at,
          }));

          const linkedPrItems =
            prsRes.status === "OK" && prsRes.data
              ? [
                  ...(prsRes.data.open || []).map((n) => ({
                    number: n,
                    state: "open",
                  })),
                  ...(prsRes.data.closed || []).map((n) => ({
                    number: n,
                    state: "closed",
                    isMerged: true,
                  })),
                ]
              : [];

          normalizedInput = {
            issueNumber: issue.number,
            issueTitle: issue.title,
            issueBody: issue.body || "",
            labels: issue.labels || [],
            isOpen: issue.state === "open",
            assignees: [],
            createdAt: new Date().toISOString(),
            authorLogin: undefined,
            comments,
            commentsApiStatus: commentsRes.status,
            existingLinkedPrsCount: prsRes.data?.open?.length ?? 0,
            hasPrLinked: (prsRes.data?.all?.length ?? 0) > 0,
            linkedPrs: linkedPrItems,
            timelineApiStatus: prsRes.status,
          };
        } else {
          const input = opts.input ?? (await readStdin());
          const parsed = parseJSON(input, "stdin") as any;
          const issueNumber = parsed?.issueNumber ?? parsed?.number ?? 1;
          const issueTitle = parsed?.issueTitle ?? parsed?.title;
          if (!issueTitle) {
            console.error(
              '❌ Missing required "issueTitle" (or "title") in input JSON',
            );
            throw new CliExitError(1);
          }
          const rawLinkedPrs = parsed.linkedPrs ?? parsed.prs ?? [];
          const hasPrLinked =
            parsed.hasPrLinked === true ||
            rawLinkedPrs.length > 0 ||
            Boolean(
              parsed.existingLinkedPrsCount &&
                parsed.existingLinkedPrsCount > 0,
            );

          normalizedInput = {
            issueNumber,
            issueTitle,
            issueBody: parsed.issueBody ?? parsed.body ?? "",
            labels: parsed.labels ?? [],
            isOpen: parsed.isOpen ?? (parsed.state !== "closed"),
            assignees:
              parsed.assignees ?? (parsed.assignee ? [parsed.assignee] : []),
            createdAt:
              parsed.createdAt ?? parsed.created_at ?? new Date().toISOString(),
            authorLogin: parsed.authorLogin ?? parsed.user?.login,
            comments: parsed.comments ?? [],
            existingLinkedPrsCount:
              parsed.existingLinkedPrsCount ?? parsed.linkedPrsCount,
            hasPrLinked,
            linkedPrs: rawLinkedPrs,
          };
        }

        const qualification = qualifyIssue(normalizedInput);
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
    },
  );

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

export function createContextCommand(
  dependencies: {
    runManager?: ContributionRunManager;
    issueBindingProvider?: IssueBindingProvider;
  } = {},
): Command {
  return new Command("context")
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
          IssueBindingArtifactSchema,
          buildContributionRunManager,
          buildPublicIssueBindingProvider,
          isPreparedRepositoryWorkspace,
          requiresPrivateVulnerabilityDisclosure,
          runRepositoryGit,
        } = await import("@opencontrib/core");
        const { IssueBindingService } = await import(
          "../../../core/src/github/issue-binding-service.js"
        );
        const assembler = new ContextAssembler();
        const runManager =
          dependencies.runManager ?? buildContributionRunManager();
        const runId = runManager.resolveRunId(opts.runId);
        if (!runId) {
          throw new Error("A canonical contribution run is required before assembling context; create a run and prepare its workspace first.");
        }
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
        const privateDisclosureRoute = Boolean(
          run && requiresPrivateVulnerabilityDisclosure(run),
        );
        if (
          !privateDisclosureRoute &&
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
        const requestedIssueNumber =
          parsed.issue.number === undefined
            ? undefined
            : Number(parsed.issue.number);
        const issueBinding = IssueBindingArtifactSchema.safeParse(
          run?.artifacts.issueBinding,
        );
        let verifiedIssueContext:
          | { number: number; title: string; body: string; labels: string[] }
          | undefined;
        if (runId && privateDisclosureRoute) {
          if (
            requestedIssueNumber !== undefined ||
            run?.manifest.issueNumber !== undefined ||
            run?.artifacts.issueBinding !== undefined
          ) {
            throw new Error(
              `Private disclosure run ${runId} cannot use a public issue number or binding during context assembly.`,
            );
          }
        } else if (runId) {
          if (
            !Number.isSafeInteger(requestedIssueNumber) ||
            requestedIssueNumber! <= 0 ||
            !issueBinding.success ||
            issueBinding.data.runId !== runId ||
            issueBinding.data.repoFullName.toLowerCase() !== requestedRepo ||
            issueBinding.data.provider !== "github" ||
            issueBinding.data.providerVerified !== true ||
            issueBinding.data.providerIssueId !== requestedIssueNumber ||
            run?.manifest.issueNumber !== requestedIssueNumber ||
            issueBinding.data.title !== parsed.issue.title
          ) {
            throw new Error(
              `Contribution run ${runId} has no provider-verified issue binding matching issue #${parsed.issue.number}; prepare the workspace for that issue first.`,
            );
          }
          const verified = await new IssueBindingService(
            runManager,
            dependencies.issueBindingProvider ?? buildPublicIssueBindingProvider(),
          ).verifyIssueContext({
            runId,
            repoFullName: requestedRepo!,
            issueNumber: requestedIssueNumber!,
          });
          verifiedIssueContext = verified.issue;
        }
        const repoTree = (parsed.repoTree || []).map((item: any) => ({
          path: item.path,
          mode: "100644",
          type: item.type as any,
          ...(item.sha ? { sha: item.sha } : {}),
        }));
        const context = await assembler.assembleContext({
          issue: {
            ...(verifiedIssueContext === undefined && requestedIssueNumber === undefined
              ? {}
              : { number: verifiedIssueContext?.number ?? requestedIssueNumber }),
            title: verifiedIssueContext?.title ?? parsed.issue.title,
            body: verifiedIssueContext?.body ?? parsed.issue.body,
            labels: verifiedIssueContext?.labels ?? parsed.issue.labels ?? [],
            isOpen: true,
            assignees: [],
            createdAt: parsed.issue.createdAt || new Date().toISOString(),
            comments: verifiedIssueContext ? [] : parsed.issue.comments || [],
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
}

const manifestsCommand = new Command("manifests")
  .description(
    "Diagnose repo manifests (workflows, package.json, pyproject, etc.) for ≤100-line PR improvements",
  )
  .argument(
    "[target]",
    "Target repository directory to scan (defaults to current dir if no input piped)",
    ".",
  )
  .option(
    "--input <json>",
    "JSON with workflows, readmeContent, packageJsonContent, etc. (or pipe via stdin)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(async (target: string, opts: { input?: string; pretty?: boolean }) => {
    try {
      let parsed: any;
      if (opts.input) {
        parsed = parseJSON(opts.input, "--input");
      } else if (!process.stdin.isTTY) {
        try {
          const input = await readStdin();
          if (input && input.trim()) {
            parsed = parseJSON(input, "stdin");
          }
        } catch {
          // If stdin read fails or is empty, fall back to directory scan
        }
      }

      if (!parsed) {
        const resolved = path.resolve(target || ".");
        const workflows: Array<{ path: string; content: string }> = [];
        const workflowsDir = path.join(resolved, ".github", "workflows");
        if (fs.existsSync(workflowsDir)) {
          const files = fs.readdirSync(workflowsDir);
          for (const f of files) {
            if (f.endsWith(".yml") || f.endsWith(".yaml")) {
              const full = path.join(workflowsDir, f);
              try {
                workflows.push({
                  path: path.relative(resolved, full).replace(/\\/g, "/"),
                  content: fs.readFileSync(full, "utf8"),
                });
              } catch {}
            }
          }
        }

        const readIfExists = (rel: string) => {
          const full = path.join(resolved, rel);
          return fs.existsSync(full) ? fs.readFileSync(full, "utf8") : undefined;
        };

        parsed = {
          workflows,
          readmeContent: readIfExists("README.md") ?? readIfExists("readme.md"),
          packageJsonContent: readIfExists("package.json"),
          pyprojectContent: readIfExists("pyproject.toml"),
          cargoContent: readIfExists("Cargo.toml"),
          gitignoreContent: readIfExists(".gitignore"),
          dependabotContent:
            readIfExists(".github/dependabot.yml") ??
            readIfExists(".github/dependabot.yaml"),
        };
      }

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
  .addCommand(createContextCommand())
  .addCommand(manifestsCommand);
