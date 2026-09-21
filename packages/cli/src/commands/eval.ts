/**
 * `opencontrib eval <sub>` — Agent-Native LLM-as-a-Judge Trajectory Evaluator
 *
 * Design: The CLI prepares the judge prompt and prints it.
 * The Agent (Antigravity / Codex / Cursor) then spawns a neutral sub-agent
 * to do the actual LLM reasoning — zero external API keys required.
 *
 * Two-phase workflow:
 *   Phase 1: `opencontrib eval judge <file>` → prints compressed trajectory + judge prompt
 *   Phase 2: Agent feeds prompt to neutral sub-agent → sub-agent returns JSON
 *   Phase 3: `opencontrib eval parse-judgment <raw-json-file>` → validates + scores
 */

import { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import {
  parseTrajectoryFromJSONL,
  buildJudgePrompt,
  parseJudgeResponse,
  synthesizeReflexionInsights,
  persistReflexionToMemoryLedger,
  STANDARD_BENCHMARK_SCENARIOS,
  executeBenchmarkScenario,
  normalizePatchLineEndings,
  parseSchemaV2Report,
  RepoMemoryLedger,
  ADVERSARIAL_SCENARIOS,
  runAdversarialBenchmark,
  createBenchmarkFixture,
  runPiAdversarialScenario,
  PiAgentRunner,
  type AdversarialScenarioId,
} from "@opencontrib/core";
import type { BenchmarkBundle, TrajectoryEvent } from "@opencontrib/core";
import { printJSON } from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

/**
 * Read a run bundle directory (containing events.jsonl + artifact files)
 * into a BenchmarkBundle for cross-validation against transcript actions.
 */
function readRunBundle(bundleDir: string): BenchmarkBundle {
  const eventsPath = path.join(bundleDir, "events.jsonl");
  const artifactTypes: string[] = [];
  const eventPhases: string[] = [];

  if (fs.existsSync(eventsPath)) {
    const lines = fs
      .readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as { phase?: string };
        if (event.phase) eventPhases.push(event.phase);
      } catch {
        /* skip malformed event */
      }
    }
  }

  // Discover artifact files by filename convention (e.g. evidence_red.json, patch.diff)
  try {
    const files = fs.readdirSync(bundleDir);
    for (const file of files) {
      if (file === "manifest.json") continue;
      if (file.endsWith(".json")) {
        artifactTypes.push(file.replace(/\.json$/, ""));
      } else if (file === "patch.diff") {
        // patch.diff is the canonical artifact for patch type
        artifactTypes.push("patch");
      }
    }
  } catch {
    /* dir not readable */
  }

  let manifest: { runId: string; currentPhase: string } | undefined;
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      manifest = { runId: m.runId, currentPhase: m.currentPhase };
    } catch {
      /* skip malformed manifest */
    }
  }

  return { manifest, eventPhases, artifactTypes };
}

// ─── eval judge ───────────────────────────────────────────────────────────────
// Phase 1: Compress trajectory and emit the judge prompt for a neutral sub-agent.
const judgeCommand = new Command("judge")
  .description(
    "Compress a transcript into a G-Eval judge prompt.\n" +
      "Feed the output to a NEUTRAL sub-agent (not yourself) for blind evaluation.\n" +
      "Then run `eval parse-judgment` to validate the sub-agent's JSON response.",
  )
  .argument("<transcript-file>", "Path to transcript.jsonl file")
  .option("--pretty", "Pretty-print metrics summary", false)
  .action(async (transcriptFile: string, opts: { pretty?: boolean }) => {
    try {
      if (!fs.existsSync(transcriptFile)) {
        printJSON(
          { status: "error", message: `File not found: ${transcriptFile}` },
          opts.pretty,
        );
        throw new CliExitError(1);
      }

      const { events, metrics, actions } = parseTrajectoryFromJSONL(transcriptFile);
      const { systemPrompt, userPrompt } = buildJudgePrompt(events, metrics, actions);

      // Print a human-readable guide for the Agent to follow
      console.log(
        [
          "## G-Eval Judge Prompt Ready",
          "",
          `Steps: ${metrics.totalSteps} | Commands: ${metrics.totalCommandsRun} | view_file calls: ${metrics.viewFileCalls}`,
          `Max consecutive view_file: ${metrics.maxConsecutiveFileViews}`,
          "",
          "## ⚠️  AGENT INSTRUCTIONS",
          "You MUST spawn a NEUTRAL, INDEPENDENT sub-agent with the prompts below.",
          "Do NOT evaluate the trajectory yourself — you have context bias from this session.",
          "The sub-agent must see only these prompts and nothing else from your conversation.",
          "",
          "### SYSTEM PROMPT (pass as system prompt to sub-agent)",
          "---",
          systemPrompt,
          "---",
          "",
          "### USER PROMPT (pass as first user message to sub-agent)",
          "---",
          userPrompt,
          "---",
          "",
          "### After the sub-agent responds:",
          "  opencontrib eval parse-judgment <path-to-sub-agent-response.json>",
          "  (or pipe: echo '<json>' | opencontrib eval parse-judgment --stdin)",
        ].join("\n"),
      );
    } catch (err: any) {
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

// ─── eval parse-judgment ──────────────────────────────────────────────────────
// Phase 2: Validate and score the neutral sub-agent's raw JSON response.
const parseJudgmentCommand = new Command("parse-judgment")
  .description(
    "Validate and score the neutral judge sub-agent's raw JSON response",
  )
  .argument(
    "[response-file]",
    "Path to the JSON file containing the sub-agent's raw response",
  )
  .option("--stdin", "Read raw JSON from stdin", false)
  .option("--transcript <file>", "Original transcript path (for metadata)")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (
      responseFile?: string,
      opts?: { stdin?: boolean; transcript?: string; pretty?: boolean },
    ) => {
      try {
        let rawText: string;

        if (opts?.stdin) {
          rawText = await new Promise<string>((resolve) => {
            const chunks: string[] = [];
            const dataHandler = (d: string | Buffer) => {
              chunks.push(d.toString());
            };
            const endHandler = () => {
              process.stdin.removeListener("data", dataHandler);
              process.stdin.removeListener("end", endHandler);
              process.stdin.setEncoding("utf8");
              resolve(chunks.join(""));
            };
            process.stdin.setEncoding("utf8");
            process.stdin.on("data", dataHandler);
            process.stdin.on("end", endHandler);
            const syncChunk = process.stdin.read?.();
            if (syncChunk) {
              chunks.push(syncChunk.toString());
              endHandler();
            }
          });
        } else if (responseFile) {
          if (!fs.existsSync(responseFile)) {
            printJSON(
              { status: "error", message: `File not found: ${responseFile}` },
              opts?.pretty,
            );
            throw new CliExitError(1);
          }
          rawText = fs.readFileSync(responseFile, "utf8");
        } else {
          printJSON(
            {
              status: "error",
              message: "Provide a response file or use --stdin",
            },
            opts?.pretty,
          );
          throw new CliExitError(1);
        }

        let metrics;
        if (opts?.transcript && fs.existsSync(opts.transcript)) {
          ({ metrics } = parseTrajectoryFromJSONL(opts.transcript));
        }

        const report = parseJudgeResponse(rawText, metrics);
        printJSON({ status: "success", report }, opts?.pretty);
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts?.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── eval reflect ─────────────────────────────────────────────────────────────
const reflectCommand = new Command("reflect")
  .description("Synthesize MIT Reflexion lessons from a parsed judgment report")
  .argument(
    "<judgment-file>",
    "Path to the JSON file produced by `eval parse-judgment`",
  )
  .option("--repo <name>", "Target repository full name (e.g. owner/repo)")
  .option("--run-id <id>", "Contribution Run ID")
  .option(
    "--trajectory <file>",
    "Path to trajectory JSON file (enables golden action sequence extraction)",
  )
  .option(
    "--persist",
    "Persist distilled lessons to local repo memory ledger",
    false,
  )
  .option("--pretty", "Pretty-print", false)
  .action(
    async (
      judgmentFile: string,
      opts: {
        repo?: string;
        runId?: string;
        trajectory?: string;
        persist?: boolean;
        pretty?: boolean;
      },
    ) => {
      try {
        if (!fs.existsSync(judgmentFile)) {
          printJSON(
            { status: "error", message: `File not found: ${judgmentFile}` },
            opts.pretty,
          );
          throw new CliExitError(1);
        }

        let report;
        try {
          const raw = fs.readFileSync(judgmentFile, "utf8");
          const parsed = JSON.parse(raw);
          report = parsed.report ?? parsed;
        } catch (err: any) {
          printJSON(
            {
              status: "error",
              message: `Failed to parse judgment file: ${err.message}`,
            },
            opts.pretty,
          );
          throw new CliExitError(1);
        }

        let events: TrajectoryEvent[] = [];
        if (opts.trajectory) {
          if (!fs.existsSync(opts.trajectory)) {
            printJSON(
              { status: "error", message: `Trajectory file not found: ${opts.trajectory}` },
              opts.pretty,
            );
            throw new CliExitError(1);
          }
          const trajRaw = fs.readFileSync(opts.trajectory, "utf8");
          const trajParsed = JSON.parse(trajRaw);
          events = trajParsed.events ?? trajParsed;
        }

        const insight = synthesizeReflexionInsights(report, events, {
          runId: opts.runId,
          repoFullName: opts.repo,
        });

        if (opts.persist) {
          const memLedger = new RepoMemoryLedger();
          persistReflexionToMemoryLedger(insight, memLedger);
        }

        printJSON(
          { status: "success", insight, persisted: opts.persist ?? false },
          opts.pretty,
        );
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── eval benchmark ───────────────────────────────────────────────────────────
const benchmarkCommand = new Command("benchmark")
  .description(
    "Run automated dual-track benchmark scenarios (Track A 0-Day & Track B Issue)",
  )
  .argument(
    "[scenario-id]",
    "Specific scenario ID to run (e.g. track-a-0day-ssrf-ipv6)",
  )
  .option("--pretty", "Pretty-print", false)
  .option(
    "--report-dir <dir>",
    "Output directory for grading reports (SWE-bench integration)",
  )
  .option(
    "--patch-file <file>",
    "Two-phase workflow: read model patch from file and apply before grading",
  )
  .option(
    "--fixtures <dir>",
    "SWE-bench fixtures directory (instance IDs loaded from fixtures/)",
  )
  .option(
    "--transcript <file>",
    "Trajectory JSONL for real execution evidence",
  )
  .option(
    "--run-bundle <dir>",
    "Run bundle directory (contains events.jsonl + artifact files) for cross-validation",
  )
  .option(
    "-v, --v2",
    "Output per-test verdicts in schema-v2 format with resolved_ids",
    false,
  )
  .action(
    async (
      scenarioId?: string,
      opts?: {
        pretty?: boolean;
        reportDir?: string;
        patchFile?: string;
        fixtures?: string;
        transcript?: string;
        runBundle?: string;
        v2?: boolean;
      },
    ) => {
      try {
        // ── Load SWE-bench fixtures if provided ──
        const scenarioInstances = scenarioId
          ? STANDARD_BENCHMARK_SCENARIOS.filter((s) => s.id === scenarioId)
          : STANDARD_BENCHMARK_SCENARIOS;

        if (opts?.fixtures && fs.existsSync(opts.fixtures)) {
          const fixtureDir = opts.fixtures;
          const fixtureEntries = fs
            .readdirSync(fixtureDir)
            .filter((e) => fs.statSync(path.join(fixtureDir, e)).isDirectory());
          const fixtureInstances = fixtureEntries.map((dir) => {
            const metaPath = path.join(fixtureDir, dir, "metadata.json");
            let instanceId = dir;
            if (fs.existsSync(metaPath)) {
              try {
                const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
                instanceId = meta.instance_id || dir;
              } catch {
                /* use dir name */
              }
            }
            return instanceId;
          });
          if (fixtureInstances.length > 0) {
            printJSON(
              {
                status: "fixtures-loaded",
                count: fixtureInstances.length,
                instances: fixtureInstances,
              },
              opts?.pretty,
            );
          }
        }

        if (scenarioInstances.length === 0) {
          printJSON(
            { status: "error", message: `Scenario not found: ${scenarioId}` },
            opts?.pretty,
          );
          throw new CliExitError(1);
        }

        let appliedPatch: string | undefined;
        if (opts?.patchFile && fs.existsSync(opts.patchFile)) {
          const rawPatch = fs.readFileSync(opts.patchFile, "utf8");
          appliedPatch = normalizePatchLineEndings(rawPatch);
          printJSON(
            {
              status: "patch-loaded",
              path: opts.patchFile,
              bytes: Buffer.byteLength(rawPatch),
            },
            opts?.pretty,
          );
        }

        if (!opts?.transcript) {
          printJSON(
            {
              status: "error",
              message:
                "Benchmark requires --transcript <file> so it can evaluate real execution evidence instead of self-certifying expected phases.",
            },
            opts?.pretty,
          );
          throw new CliExitError(1);
        }

        if (!fs.existsSync(opts.transcript)) {
          printJSON(
            { status: "error", message: `File not found: ${opts.transcript}` },
            opts?.pretty,
          );
          throw new CliExitError(1);
        }

        // ── Read run bundle for cross-validation ──
        let bundle: BenchmarkBundle | undefined;
        if (opts.runBundle) {
          if (!fs.existsSync(opts.runBundle)) {
            printJSON(
              { status: "error", message: `Run bundle not found: ${opts.runBundle}` },
              opts?.pretty,
            );
            throw new CliExitError(1);
          }
          bundle = readRunBundle(opts.runBundle);
        }

        const { metrics, actions } = parseTrajectoryFromJSONL(opts.transcript);
        const stepsCount = metrics.totalSteps;
        const durationMs = metrics.totalDurationMs ?? 0;

        const results = scenarioInstances.map((s) =>
          executeBenchmarkScenario(s, actions, stepsCount, durationMs, bundle),
        );

        const aggregate: {
          status: string;
          scenariosCount: number;
          results: {
            scenarioId: string;
            success: boolean;
            stepsTaken: number;
            durationMs: number;
            actionSequenceVerified: boolean;
            runBundleVerified?: boolean;
            errors: string[];
          }[];
          appliedPatch?: string;
          reportDir?: string;
        } = {
          status: results.every((r) => r.success) ? "passed" : "failed",
          scenariosCount: scenarioInstances.length,
          results,
        };
        if (appliedPatch) aggregate.appliedPatch = appliedPatch;

        if (opts?.v2) {
          const report = parseSchemaV2Report(aggregate, results);
          if (opts?.reportDir) {
            if (!fs.existsSync(opts.reportDir)) {
              fs.mkdirSync(opts.reportDir, { recursive: true });
            }
            const reportPath = path.join(opts.reportDir, "report-v2.json");
            fs.writeFileSync(
              reportPath,
              JSON.stringify(report, null, 2),
              "utf8",
            );
            printJSON(
              { status: "report-written", path: reportPath },
              opts?.pretty,
            );
          }
          printJSON(report, opts?.pretty);
        } else {
          printJSON(aggregate, opts?.pretty);
        }
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts?.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── Top-level command ────────────────────────────────────────────────────────

// ─── eval adversarial ───────────────────────────────────────────────────────────
// Closed-loop adversarial acceptance benchmark: scripted agent vs. in-memory
// trusted host (no network). Optionally adds a Pi-driven round (CLI/MCP axis).
const adversarialCommand = new Command("adversarial")
  .description(
    "Run the closed-loop adversarial acceptance benchmark: scripted agent vs. in-memory trusted host (no network). Optionally add a Pi-driven round (CLI/MCP axis).",
  )
  .option("--agent <mode>", "scripted | pi | all", "scripted")
  .option("--scenario <id>", `all | ${ADVERSARIAL_SCENARIOS.join("|")}`, "all")
  .option("--axis <axis>", "Pi agent axis: cli | mcp", "cli")
  .option("--pi-bin <path>", "pi executable for pi rounds", "pi")
  .option(
    "--repo-root <path>",
    "OpenContrib repo root for Pi-driven CLI/MCP tasks",
    process.cwd(),
  )
  .option(
    "--skip-pi",
    "Never run Pi-driven rounds even in --agent all mode",
    false,
  )
  .option("--pretty", "Pretty-print the report", false)
  .action(
    async (opts: {
      agent: string;
      scenario: string;
      axis: string;
      piBin: string;
      repoRoot: string;
      skipPi?: boolean;
      pretty?: boolean;
    }) => {
      try {
        const mode = opts.agent.toLowerCase();
        if (!["scripted", "pi", "all"].includes(mode)) {
          printJSON(
            {
              status: "error",
              message: `Unknown --agent mode: ${opts.agent} (expected scripted | pi | all)`,
            },
            opts.pretty,
          );
          throw new CliExitError(1);
        }
        if (!["cli", "mcp"].includes(opts.axis)) {
          printJSON(
            {
              status: "error",
              message: `Unknown --axis: ${opts.axis} (expected cli | mcp)`,
            },
            opts.pretty,
          );
          throw new CliExitError(1);
        }
        const scenarioFilter =
          opts.scenario === "all"
            ? undefined
            : ([opts.scenario] as AdversarialScenarioId[]);
        if (
          scenarioFilter &&
          !ADVERSARIAL_SCENARIOS.includes(scenarioFilter[0])
        ) {
          printJSON(
            {
              status: "error",
              message: `Unknown --scenario: ${opts.scenario} (expected ${ADVERSARIAL_SCENARIOS.join(" | ")})`,
            },
            opts.pretty,
          );
          throw new CliExitError(1);
        }

        const report: Record<string, unknown> = {
          generatedAt: new Date().toISOString(),
        };

        if (mode === "scripted" || mode === "all") {
          report.scripted = await runAdversarialBenchmark({
            scenarios: scenarioFilter,
          });
        }

        if ((mode === "pi" || mode === "all") && !opts.skipPi) {
          const piRunner = new PiAgentRunner(opts.piBin);
          if (piRunner.available()) {
            const repoRoot = path.resolve(opts.repoRoot);
            const cliEntry = path.join(
              repoRoot,
              "packages",
              "cli",
              "src",
              "index.ts",
            );
            const mcpEntry = path.join(
              repoRoot,
              "packages",
              "mcp-server",
              "src",
              "index.ts",
            );
            const results = [];
            for (const scenario of ["normal", "malicious"] as const) {
              if (scenarioFilter && !scenarioFilter.includes(scenario))
                continue;
              const rootDir = path.join(
                process.env.TEMP ?? process.env.TMP ?? ".tmp-pi-bench",
                `oc-pi-bench-${Date.now()}-${scenario}`,
              );
              fs.mkdirSync(rootDir, { recursive: true });
              const fixture = createBenchmarkFixture(rootDir);
              const result = await runPiAdversarialScenario({
                rootDir,
                fixture,
                scenario,
                axis: opts.axis as "cli" | "mcp",
                piRunner,
                cliEntry,
                mcpEntry: opts.axis === "mcp" ? mcpEntry : undefined,
              });
              results.push(result);
            }
            report.pi = {
              axis: opts.axis,
              agent: piRunner.name,
              results,
              trustChainHeld: results.every((r) => r.passed),
            };
          } else {
            report.pi = {
              skipped: true,
              reason: `pi executable not found (${opts.piBin}); install pi-coding-agent or use --agent scripted`,
            };
          }
        }

        printJSON(report, opts.pretty);
      } catch (error: any) {
        if (error instanceof CliExitError) {
          throw error;
        }
        printJSON(
          {
            status: "error",
            message: `Adversarial benchmark failed: ${error.message}`,
          },
          opts.pretty,
        );
        throw new CliExitError(1);
      }
    },
  );

// ─── Top-level command ────────────────────────────────────────────────────────
export const evalCommand = new Command("eval")
  .description(
    "Agent-native LLM-as-a-Judge evaluation, trajectory auditing, and self-evolution flywheel",
  )
  .addCommand(judgeCommand)
  .addCommand(parseJudgmentCommand)
  .addCommand(reflectCommand)
  .addCommand(benchmarkCommand)
  .addCommand(adversarialCommand);
