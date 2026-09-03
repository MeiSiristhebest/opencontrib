import { Command, Argument } from "commander";
import {
  buildContributionRunManager,
  buildContributionPipeline,
  renderReport,
  type ContributionRunManager,
} from "@opencontrib/core";
import {
  printJSON,
  parseJSON,
  readStdin,
  printPhaseGuidance,
} from "../utils/output.js";

// Lazy factory: the run manager is constructed on first use (inside an action),
// not at module load time — so importing the command module never touches the
// filesystem or writes to ~/.opencontrib, and tests can inject a fake.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

// ─── run create ───────────────────────────────────────────────────────────────
const runCreate = new Command("create")
  .description("Initialize a new contribution run")
  .requiredOption("--repo <name>", 'Repository full name, e.g. "owner/repo"')
  .option("--issue <num>", "Issue number")
  .option("--title <text>", "Issue title")
  .option("--tags <list>", "Comma-separated tags", (v) => v.split(","))
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      repo: string;
      issue?: string;
      title?: string;
      tags?: string[];
      pretty?: boolean;
    }) => {
      try {
        const manifest = getRunManager().createRun({
          repoFullName: opts.repo,
          issueNumber: opts.issue ? Number(opts.issue) : undefined,
          issueTitle: opts.title,
          tags: opts.tags,
        });
        printJSON({ status: "success", manifest }, opts.pretty);

        printPhaseGuidance({
          currentPhase: "INITIALIZED",
          runId: manifest.runId,
          status: "SUCCESS",
          humanCheckpoint: "Checkpoint 1 (Initialize Session)",
          nextCommand: `opencontrib probe plan . --pretty (Track A) OR opencontrib scout ${opts.repo} (Track B)`,
          invariants: [
            `Session active: ${manifest.runId}`,
            "All subsequent commands will automatically inherit this active session.",
          ],
        });
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
    },
  );

// ─── run get <runId> ─────────────────────────────────────────────────────────
const runGet = new Command("get")
  .description("Retrieve full manifest and artifacts for a run")
  .addArgument(new Argument("[runId]", "Run ID (defaults to active session)"))
  .option("--pretty", "Pretty-print", false)
  .action(async (targetRunId?: string, opts?: { pretty?: boolean }) => {
    try {
      const runId = getRunManager().resolveRunId(targetRunId);
      if (!runId) {
        console.error("❌ No run ID provided and no active session found");
        process.exit(1);
      }
      const run = getRunManager().getRun(runId);
      if (!run) {
        console.error(`❌ Run "${runId}" not found`);
        process.exit(1);
      }
      printJSON({ status: "success", run }, opts?.pretty);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── run resume <runId> ──────────────────────────────────────────────────────
const runResume = new Command("resume")
  .description(
    "Resume an interrupted run with latest phase, artifacts, and suggested next action",
  )
  .addArgument(new Argument("[runId]", "Run ID (defaults to active session)"))
  .option("--pretty", "Pretty-print", false)
  .action(async (targetRunId?: string, opts?: { pretty?: boolean }) => {
    try {
      const runId = getRunManager().resolveRunId(targetRunId);
      if (!runId) {
        console.error("❌ No run ID provided and no active session found");
        process.exit(1);
      }
      const resume = getRunManager().resumeRun(runId);
      printJSON({ status: "success", resume }, opts?.pretty);
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── run save <runId> ────────────────────────────────────────────────────────
const runSave = new Command("save")
  .description(
    "Save a stage artifact to a run (reads JSON from stdin or --content)",
  )
  .addArgument(new Argument("<runId>", "Run ID"))
  .requiredOption("--type <type>", "Artifact type", (v) => {
    const valid = [
      "opportunity",
      "context",
      "workspace",
      "patch",
      "evidence",
      "governance",
      "pr_draft",
      "result",
    ];
    if (!valid.includes(v)) {
      throw new Error(
        `Invalid type "${v}". Must be one of: ${valid.join(", ")}`,
      );
    }
    return v;
  })
  .option("--content <json>", "Artifact payload as JSON string")
  .option("--phase <phase>", "Phase to auto-advance to")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (
      runId: string,
      opts: {
        type: string;
        content?: string;
        phase?: string;
        pretty?: boolean;
      },
    ) => {
      try {
        let payload: string | Record<string, unknown>;
        if (opts.content) {
          payload =
            (parseJSON(opts.content, "--content") as Record<string, unknown>) ||
            {};
        } else {
          const stdinData = await readStdin();
          if (!stdinData) {
            console.error(
              "❌ No content provided. Use --content <json> or pipe via stdin",
            );
            process.exit(1);
          }
          payload =
            (parseJSON(stdinData, "stdin") as Record<string, unknown>) || {};
        }
        const saved = getRunManager().saveArtifact(
          runId,
          opts.type as any,
          payload,
          opts.phase as any,
        );
        printJSON({ status: "success", saved }, opts.pretty);
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
    },
  );

// ─── run list ─────────────────────────────────────────────────────────────────
const runList = new Command("list")
  .description("List all tracked contribution runs under ~/.opencontrib/runs/")
  .option("--limit <n>", "Maximum number of runs to return", "20")
  .option("--pretty", "Pretty-print", false)
  .action((opts: { limit?: string; pretty?: boolean }) => {
    try {
      const limit = parseInt(opts.limit || "20", 10);
      const runs = getRunManager().listRuns().slice(0, limit);
      printJSON(
        {
          status: "success",
          count: runs.length,
          runs,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ ${err.message}`);
      process.exit(1);
    }
  });

// ─── run execute (autonomous pipeline execution facade) ───────────────────────
const runExecute = new Command("execute")
  .description(
    "Execute the autonomous contribution pipeline (use-case facade) for a target repository",
  )
  .requiredOption("--repo <name>", 'Repository full name, e.g. "owner/repo"')
  .option("--token <token>", "GitHub token (or set GITHUB_TOKEN env)")
  .option(
    "--approved",
    "Pre-approve PR creation (skip human gate in interactive mode)",
    false,
  )
  .option(
    "--stress-runs <n>",
    "Number of stress loop iterations",
    (v) => Number(v),
    1,
  )
  .option("--pretty", "Pretty-print JSON output", false)
  .action(
    async (opts: {
      repo: string;
      token?: string;
      approved?: boolean;
      stressRuns?: number;
      pretty?: boolean;
    }) => {
      try {
        const pipeline = buildContributionPipeline({
          githubToken: opts.token || process.env.GITHUB_TOKEN,
        });
        const result = await pipeline.run({
          profile: {
            techStack: ["typescript", "javascript", "python", "go", "rust"],
            focusAreas: ["bugfix", "testing", "security"],
            proficiency: "intermediate",
            minMatchScore: 60,
          },
          targetRepo: opts.repo,
          humanApproved: opts.approved,
          stressLoopRuns: opts.stressRuns,
        });

        if (opts.pretty) {
          console.log(renderReport(result, "json"));
        } else {
          console.log(renderReport(result, "summary"));
        }
      } catch (err: any) {
        console.error(`❌ ${err.message}`);
        process.exit(1);
      }
    },
  );

// ─── Top-level command ────────────────────────────────────────────────────────

export const runCommand = new Command("run")
  .description(
    "Manage auditable contribution run sessions under ~/.opencontrib/runs/",
  )
  .addCommand(runCreate)
  .addCommand(runGet)
  .addCommand(runResume)
  .addCommand(runSave)
  .addCommand(runList)
  .addCommand(runExecute);
