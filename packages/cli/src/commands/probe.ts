import * as fs from "fs";
import * as path from "path";
import { Command } from "commander";
import {
  extractRepoFingerprint,
  negotiateProbes,
  runProbes,
  analyzeGitHotspots,
  generatePropertyTest,
  ProbeRegistry,
  createDefaultPluginHost,
  triagePointerFindings,
  ActiveSessionManager,
  buildContributionRunManager,
  getLocalRepositoryFullName,
  type ContributionRunManager,
  type ProbeCost,
  type DefectCategory,
} from "@opencontrib/core";
import { printJSON, printPhaseGuidance } from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

function resolveTargetDirectory(target?: string): string {
  if (target && target !== ".") {
    return path.resolve(target);
  }
  return path.resolve(".");
}

function resolveTrackedTarget(runIdArg: string | undefined, target?: string) {
  const manager = getRunManager();
  const runId = manager.resolveRunId(runIdArg);
  if (!runId || !manager.getRun(runId)) {
    throw new Error("An existing contribution run is required before probing; create a run first.");
  }
  const resolved = resolveTargetDirectory(target);
  manager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));
  return { manager, runId, resolved };
}

function saveProbeArtifact(
  manager: ContributionRunManager,
  runId: string,
  result: Record<string, unknown>,
): void {
  const previous = manager.getRun(runId)?.artifacts.probe;
  let existing: Record<string, unknown> = {};
  if (typeof previous === "string") {
    try {
      const parsed: unknown = JSON.parse(previous);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        existing = parsed as Record<string, unknown>;
      }
    } catch {
      // An unstructured legacy artifact has no fields that can be merged.
    }
  } else if (typeof previous === "object" && previous !== null && !Array.isArray(previous)) {
    existing = previous as Record<string, unknown>;
  }
  manager.saveArtifact(runId, "probe", { ...existing, ...result });
}

export const probeCommand = new Command("probe").description(
  "Progressive probe discovery, repository fingerprinting, hotspot forensics, and targeted scanning",
);

probeCommand
  .command("plan [target]")
  .description(
    "Extract repository fingerprint and negotiate active probes without executing them",
  )
  .option(
    "--only <probes>",
    "Comma-separated probe names to exclusively consider",
  )
  .option("--skip <probes>", "Comma-separated probe names to ignore")
  .option(
    "--max-cost <cost>",
    "Maximum allowed execution cost: fast, medium, deep",
    "medium",
  )
  .option("--no-check-binaries", "Skip checking host binary existence")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print JSON output", false)
  .action(async (target, opts) => {
    try {
      const { manager, runId, resolved } = resolveTrackedTarget(opts.runId, target);
      const fingerprint = await extractRepoFingerprint(resolved);

      const only = opts.only
        ? opts.only.split(",").map((s: string) => s.trim())
        : undefined;
      const skip = opts.skip
        ? opts.skip.split(",").map((s: string) => s.trim())
        : undefined;

      const plan = negotiateProbes(
        fingerprint,
        {
          only,
          skip,
          maxCost: opts.maxCost as ProbeCost,
          checkBinaries: opts.checkBinaries,
        },
        new ProbeRegistry(),
      );
      saveProbeArtifact(manager, runId, { target: resolved, plan });

      printJSON(
        {
          status: "success",
          runId,
          currentPhase: manager.getRun(runId)!.manifest.currentPhase,
          target: resolved,
          plan,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Probe planning failed: ${err.message}`);
      throw new CliExitError(1);
    }
  });

probeCommand
  .command("run [target]")
  .description(
    "Negotiate and execute targeted probes against repository, returning normalized findings",
  )
  .option(
    "--only <probes>",
    "Comma-separated probe names to exclusively consider",
  )
  .option("--skip <probes>", "Comma-separated probe names to ignore")
  .option(
    "--max-cost <cost>",
    "Maximum allowed execution cost: fast, medium, deep",
    "medium",
  )
  .option(
    "--min-score <score>",
    "Minimum PR potential score threshold (0-100)",
    "0",
  )
  .option(
    "--min-confidence <confidence>",
    "Minimum finding confidence threshold (0-100)",
    "80",
  )
  .option(
    "--limit <n>",
    "Maximum number of top high-value Smart Pointers to output (default: 5)",
    "5",
  )
  .option("--all", "Output all raw pointers without top-K triage", false)
  .option("--timeout <ms>", "Per-probe execution timeout in ms", "30000")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print JSON output", false)
  .action(async (target, opts) => {
    try {
      const runId = getRunManager().resolveRunId(opts.runId);
      if (!runId || !getRunManager().getRun(runId)) {
        throw new Error("An existing contribution run is required before probing; create a run first.");
      }
      const resolved = resolveTargetDirectory(target);
      getRunManager().assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));
      const fingerprint = await extractRepoFingerprint(resolved);
      const host = await createDefaultPluginHost({
        workspacePath: resolved,
      });

      const only = opts.only
        ? opts.only.split(",").map((s: string) => s.trim())
        : undefined;
      const skip = opts.skip
        ? opts.skip.split(",").map((s: string) => s.trim())
        : undefined;

      // Negotiate active probes from both Microkernel Plugins and Probe Registry
      const matchingProbes = host.listAll().filter((probe) => {
        if (only && !only.includes(probe.id)) return false;
        if (skip && skip.includes(probe.id)) return false;
        return probe.match(fingerprint);
      });

      // Execute full plugin scan through ProbeScanScheduler
      const scanResult = await host.executeScan(resolved, matchingProbes);

      // Rank and triage pointers using pure core domain function
      const minConfidence = parseInt(opts.minConfidence ?? "80", 10);
      const limit = parseInt(opts.limit ?? "5", 10);
      const triaged = triagePointerFindings(scanResult.pointersCreated, {
        limit,
        minConfidence,
        includeAll: Boolean(opts.all),
      });

      saveProbeArtifact(getRunManager(), runId, {
        target: resolved,
        executedProbes: scanResult.executedProbes,
        totalPointersCount: scanResult.pointersCreated.length,
        triagedPointersCount: triaged.triagedCount,
        topPointers: triaged.topPointers,
      });

      printJSON(
        {
          status: "success",
          target: resolved,
          executedProbes: scanResult.executedProbes,
          totalPointersCount: scanResult.pointersCreated.length,
          triagedPointersCount: triaged.triagedCount,
          triageSummary: triaged.summary,
          topPointers: triaged.topPointers,
        },
        opts.pretty,
      );

      printPhaseGuidance({
        currentPhase: getRunManager().getRun(runId)!.manifest.currentPhase,
        runId,
        status: "SUCCESS",
        humanCheckpoint: "Checkpoint 1 (Review Smart Pointer Findings)",
        // Derive next command, forbidden actions, and invariants from the
        // canonical PROBE_COMPLETED protocol contract.
      });
    } catch (err: any) {
      console.error(`❌ Probe execution failed: ${err.message}`);
      throw new CliExitError(1);
    }
  });

probeCommand
  .command("hotspot [target]")
  .description(
    "Run Code as a Crime Scene Git churn and cyclomatic complexity hotspot analysis",
  )
  .option("--limit <number>", "Number of top hotspot files to return", "5")
  .option("--since-months <number>", "Months of commit history to inspect", "6")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print JSON output", false)
  .action((target, opts) => {
    try {
      const { manager, runId, resolved } = resolveTrackedTarget(opts.runId, target);
      const result = analyzeGitHotspots(resolved, {
        limit: parseInt(opts.limit, 10),
        sinceMonths: parseInt(opts.sinceMonths, 10),
      });
      saveProbeArtifact(manager, runId, { target: resolved, hotspots: result });

      printJSON(
        {
          status: "success",
          runId,
          currentPhase: manager.getRun(runId)!.manifest.currentPhase,
          target: resolved,
          result,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Hotspot analysis failed: ${err.message}`);
      throw new CliExitError(1);
    }
  });

probeCommand
  .command("fuzz [target]")
  .description(
    "Generate property-based boundary fuzzing test harness for target repo language & defect category",
  )
  .option(
    "--category <category>",
    "Target defect category (e.g. numerical_bounds, protocol_drift, distributed_cache)",
    "numerical_bounds",
  )
  .option("--function-name <name>", "Target function to fuzz", "processInput")
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print JSON output", false)
  .action(async (target, opts) => {
    try {
      const { manager, runId, resolved } = resolveTrackedTarget(opts.runId, target);
      const fingerprint = await extractRepoFingerprint(resolved);

      const langLower = fingerprint.primaryLanguage.toLowerCase();
      const lang = [
        "typescript",
        "javascript",
        "python",
        "rust",
        "go",
      ].includes(langLower)
        ? (langLower as any)
        : "typescript";

      const spec = generatePropertyTest(
        opts.category as DefectCategory,
        lang,
        opts.functionName,
      );
      saveProbeArtifact(manager, runId, { target: resolved, fuzz: spec });

      printJSON(
        {
          status: "success",
          runId,
          currentPhase: manager.getRun(runId)!.manifest.currentPhase,
          target: resolved,
          spec,
        },
        opts.pretty,
      );
    } catch (err: any) {
      console.error(`❌ Fuzz harness generation failed: ${err.message}`);
      throw new CliExitError(1);
    }
  });
