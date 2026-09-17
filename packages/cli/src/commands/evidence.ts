/** `opencontrib evidence` — Dual-stage empirical verification. */

import { Command } from "commander";
import {
  capturePreFixAssertion,
  collectEvidence,
  buildContributionRunManager,
  verifyDualStageReproduction,
  captureRedEvidence,
  verifyGreenEvidence,
  EvidenceService,
  type ContributionRunManager,
  type RedEvidence,
} from "@opencontrib/core";
import { printJSON, printPhaseGuidance } from "../utils/output.js";

// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

// Shared context resolution for evidence subcommands.
interface EvidenceContextOptions {
  cwd?: string;
  runId?: string;
  workspaceRoot?: string;
  baselineSha?: string;
  testCmd?: string;
}
function resolveEvidenceContext(opts: EvidenceContextOptions): {
  runId?: string;
  workspaceRoot?: string;
  baselineSha?: string;
  targetCwd: string;
} {
  const runId = getRunManager().resolveRunId(opts.runId);
  let workspaceRoot = opts.workspaceRoot;
  let baselineSha = opts.baselineSha;
  let targetCwd = opts.cwd;

  if (runId) {
    try {
      const run = getRunManager().getRun(runId);
      if (run?.artifacts?.workspace?.workspacePath) {
        if (!workspaceRoot)
          workspaceRoot = String(run.artifacts.workspace.workspacePath);
        if (!targetCwd)
          targetCwd = String(run.artifacts.workspace.workspacePath);
      }
      if (run?.artifacts?.workspace?.baseCommitSha && !baselineSha) {
        baselineSha = String(run.artifacts.workspace.baseCommitSha);
      }
    } catch (err: any) {
      console.warn(`Warning: Could not resolve run "${runId}": ${err.message}`);
    }
  }

  if (!targetCwd) {
    targetCwd = process.cwd();
  }
  return { runId, workspaceRoot, baselineSha, targetCwd };
}

export const evidenceCommand = new Command("evidence").description(
  "Empirical evidence: RED→GREEN dual-stage verification (one-shot via 'run', or capture-red + verify-green)",
);

export const evidenceRunCommand = evidenceCommand
  .command("run")
  .description(
    "Execute one-shot dual-stage empirical verification (pre-fix baseline + post-fix stress loop)",
  )
  .option(
    "--cwd <path>",
    "Workspace directory to run tests in (defaults to active session workspace)",
  )
  .requiredOption(
    "--test-cmd <cmd>",
    'Test command, e.g. "npm test" or "pytest"',
  )
  .option(
    "--pre-fix-cmd <cmd>",
    "Separate command to trigger pre-fix failure baseline",
  )
  .option("--assertion <regex>", "Expected failure assertion regex before fix")
  .option(
    "--stress-loop <n>",
    "Stress loop iterations (use >1 for concurrency/race tests)",
    (v) => Number(v),
    1,
  )
  .option(
    "--concurrency <n>",
    "Concurrent stampede worker threads",
    (v) => Number(v),
    1,
  )
  .option("--workspace-root <path>", "Root workspace for security boundary")
  .option("--baseline-sha <sha>", "Baseline commit SHA before changes")
  .option(
    "--run-id <id>",
    "Auto-resolve workspace from run and save evidence artifact (defaults to active session)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      cwd?: string;
      testCmd: string;
      preFixCmd?: string;
      assertion?: string;
      stressLoop?: number;
      concurrency?: number;
      workspaceRoot?: string;
      baselineSha?: string;
      runId?: string;
      pretty?: boolean;
    }) => {
      try {
        const runId = getRunManager().resolveRunId(opts.runId);
        let workspaceRoot = opts.workspaceRoot;
        let baselineSha = opts.baselineSha;
        let targetCwd = opts.cwd;

        if (runId) {
          try {
            const run = getRunManager().getRun(runId);
            if (run?.artifacts?.workspace?.workspacePath) {
              if (!workspaceRoot)
                workspaceRoot = String(run.artifacts.workspace.workspacePath);
              if (!targetCwd)
                targetCwd = String(run.artifacts.workspace.workspacePath);
            }
            if (run?.artifacts?.workspace?.baseCommitSha && !baselineSha) {
              baselineSha = String(run.artifacts.workspace.baseCommitSha);
            }
          } catch (err: any) {
            console.warn(
              `Warning: Could not resolve run "${runId}": ${err.message}`,
            );
          }
        }

        if (!targetCwd) {
          targetCwd = process.cwd();
        }

        let dualStage: any;
        if (opts.assertion) {
          const preFixCheck = capturePreFixAssertion(
            targetCwd,
            opts.preFixCmd || opts.testCmd,
            workspaceRoot,
            opts.assertion,
          );
          dualStage = await verifyDualStageReproduction({
            cwd: targetCwd,
            workspaceRoot,
            testCommand: opts.testCmd,
            preFixBaselineCaptured: preFixCheck.assertionCaptured,
            preFixFailureOutput: preFixCheck.baselineOutput,
            stressLoopCount: opts.stressLoop ?? 1,
          });
        }

        const evidence = await collectEvidence({
          cwd: targetCwd,
          workspaceRoot,
          baselineCommitSha: baselineSha,
          testCommand: opts.testCmd,
          stressLoopCount: opts.stressLoop ?? 1,
          concurrencyWorkers: opts.concurrency ?? 1,
        });

        const fullReport = {
          ...evidence,
          reproductionVerified: dualStage
            ? Boolean(dualStage.isReproductionVerified)
            : false,
          allTestsPassing:
            evidence.stressLoopPassed &&
            (evidence.failedUnitTestsCount ?? 0) === 0,
          dualStage,
        };

        let persistence: { saved: boolean; error?: string } | undefined;
        const isVerified =
          fullReport.reproductionVerified === true &&
          fullReport.allTestsPassing;
        if (runId) {
          // `evidence run` is diagnostic one-shot mode. It cannot create a
          // canonical RED artifact and GREEN artifact in one agent turn, so
          // never persist its self-reported bundle as authoritative evidence.
          persistence = {
            saved: false,
            error:
              "One-shot evidence is diagnostic-only; use capture-red followed by verify-green to persist canonical Evidence V2.",
          };
        }

        printJSON(
          {
            status: persistence?.error ? "PARTIAL_SUCCESS" : "success",
            evidence: fullReport,
            persistence,
          },
          opts.pretty,
        );

        const redVerified = Boolean(fullReport.reproductionVerified);
        printPhaseGuidance({
          currentPhase: redVerified ? "EVIDENCE_COLLECTED" : "PATCH_DRAFTED",
          runId,
          status: redVerified ? "SUCCESS" : "WARNING",
          humanCheckpoint: redVerified
            ? "Checkpoint 2 (Empirical Reproduction Verified)"
            : "Checkpoint 2 (Unverified Baseline - RED Not Captured)",
          nextCommand: redVerified
            ? 'opencontrib governance audit --patch <file> --pr-title "<title>"'
            : "opencontrib evidence capture-red --test-cmd '<cmd>' --assertion '<pattern>'",
          invariants: [
            redVerified
              ? "Empirical fail-first baseline confirmed and verified."
              : "Warning: Dual-stage reproduction was not verified. Capture the RED baseline before proceeding to governance.",
            redVerified
              ? "Next, execute Phase 7 Governance Audit to verify RFC-100 line limit and anti-AI rubric."
              : "Establish the failing baseline (RED) before running the governance audit.",
          ],
        });
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        process.exit(1);
      }
    },
  );

// Evidence V2 — capture-red: persist an immutable RED baseline before the fix.
export const captureRedCommand = evidenceCommand
  .command("capture-red")
  .description(
    "Capture immutable RED baseline (failing test + source tree hash) before applying the fix",
  )
  .requiredOption(
    "--test-cmd <cmd>",
    "Test command expected to FAIL on the buggy baseline",
  )
  .option("--assertion <regex>", "Expected failure assertion regex")
  .option("--cwd <path>", "Workspace directory to run tests in")
  .option("--run-id <id>", "Contribution run to persist the RED artifact into")
  .option("--baseline-sha <sha>", "Baseline commit SHA before changes")
  .option("--workspace-root <path>", "Root workspace for security boundary")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      testCmd: string;
      assertion?: string;
      cwd?: string;
      runId?: string;
      baselineSha?: string;
      workspaceRoot?: string;
      pretty?: boolean;
    }) => {
      try {
        const { runId, workspaceRoot, baselineSha, targetCwd } =
          resolveEvidenceContext(opts);
        const red = captureRedEvidence({
          cwd: targetCwd,
          testCommand: opts.testCmd,
          workspaceRoot,
          expectedAssertion: opts.assertion,
          baselineCommitSha: baselineSha,
        });
        let persistence: { saved: boolean; error?: string } | undefined;
        if (runId) {
          const evidenceService = new EvidenceService(getRunManager());
          evidenceService.captureRed({
            runId,
            cwd: targetCwd,
            testCommand: opts.testCmd,
            expectedAssertion: opts.assertion,
            workspaceRoot,
            baselineCommitSha: baselineSha,
          });
          persistence = { saved: true };
        }
        printJSON(
          {
            status: "success",
            redEvidence: red,
            persistence,
          },
          opts.pretty,
        );
        printPhaseGuidance({
          currentPhase: "PATCH_DRAFTED",
          runId,
          status: red.assertionMatched ? "SUCCESS" : "WARNING",
          humanCheckpoint: "Checkpoint 2 (RED Baseline Captured)",
          nextCommand:
            "Apply the fix, then run: opencontrib evidence verify-green --test-cmd '<cmd>'",
          invariants: [
            red.assertionMatched
              ? "RED baseline captured and failure assertion matched."
              : "Warning: the test did not fail as expected; no valid RED baseline.",
            "Apply the code change, then verify GREEN to advance to EVIDENCE_COLLECTED.",
          ],
        });
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        process.exit(1);
      }
    },
  );

// Evidence V2 — verify-green: verify the GREEN run and bind it to the captured RED.
export const verifyGreenCommand = evidenceCommand
  .command("verify-green")
  .description(
    "Verify the GREEN run, bind it to a captured RED baseline, and advance to EVIDENCE_COLLECTED when verified",
  )
  .requiredOption(
    "--test-cmd <cmd>",
    "Test command expected to PASS after the fix",
  )
  .option("--run-id <id>", "Contribution run holding the captured RED artifact")
  .option("--cwd <path>", "Workspace directory to run tests in")
  .option("--stress-loop <n>", "Stress loop iterations", (v) => Number(v), 1)
  .option("--concurrency <n>", "Concurrent workers", (v) => Number(v), 1)
  .option("--baseline-sha <sha>", "Baseline commit SHA")
  .option("--workspace-root <path>", "Root workspace for security boundary")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      testCmd: string;
      runId?: string;
      cwd?: string;
      stressLoop?: number;
      concurrency?: number;
      baselineSha?: string;
      workspaceRoot?: string;
      pretty?: boolean;
    }) => {
      try {
        const { runId, workspaceRoot, baselineSha, targetCwd } =
          resolveEvidenceContext(opts);
        // Load the previously captured RED baseline.
        let redEvidence: RedEvidence | undefined;
        if (runId) {
          const run = getRunManager().getRun(runId);
          const evidenceArtifact = run?.artifacts?.evidence as
            | { redEvidence?: RedEvidence }
            | undefined;
          redEvidence = evidenceArtifact?.redEvidence;
        }
        if (!redEvidence || !redEvidence.sourceTreeSha256) {
          throw new Error(
            "No captured RED baseline found for this run. Run 'opencontrib evidence capture-red --test-cmd '<cmd>' --assertion '<pattern>' first.",
          );
        }
        let report: any;
        let persistence: { saved: boolean; error?: string } | undefined;
        if (runId) {
          const evidenceService = new EvidenceService(getRunManager());
          report = await evidenceService.verifyGreen({
            runId,
            cwd: targetCwd,
            testCommand: opts.testCmd,
            workspaceRoot,
            baselineCommitSha: baselineSha,
            stressLoopCount: opts.stressLoop ?? 1,
            concurrencyWorkers: opts.concurrency ?? 1,
          });
          persistence = { saved: report.reproductionVerified === true };
        } else {
          const green = verifyGreenEvidence({
            cwd: targetCwd,
            testCommand: opts.testCmd,
            workspaceRoot,
            redEvidence: redEvidence!,
            stressLoopCount: opts.stressLoop ?? 1,
            concurrencyWorkers: opts.concurrency ?? 1,
          });
          const full = await collectEvidence({
            cwd: targetCwd,
            workspaceRoot,
            baselineCommitSha: baselineSha,
            testCommand: opts.testCmd,
            stressLoopCount: opts.stressLoop ?? 1,
            concurrencyWorkers: opts.concurrency ?? 1,
          });
          report = {
            ...full,
            redEvidence,
            greenEvidence: green.greenEvidence,
            reproductionVerified:
              green.reproductionVerified && Boolean(full.allTestsPassing),
            allTestsPassing: Boolean(full.allTestsPassing),
          };
        }
        const verified = report.reproductionVerified === true;
        printJSON(
          {
            status: verified ? "success" : "PARTIAL_SUCCESS",
            evidence: report,
            persistence,
          },
          opts.pretty,
        );
        printPhaseGuidance({
          currentPhase: verified ? "EVIDENCE_COLLECTED" : "PATCH_DRAFTED",
          runId,
          status: verified ? "SUCCESS" : "WARNING",
          humanCheckpoint: verified
            ? "Checkpoint 2 (RED→GREEN Reproduction Verified)"
            : "Checkpoint 2 (GREEN Not Verified Against RED)",
          nextCommand: verified
            ? (runId ? `opencontrib governance pr-template --run-id ${runId} --issue <id> --issue-title "<title>" --summary "<summary>"` : 'opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>"')
            : "Re-run: opencontrib evidence verify-green --test-cmd '<cmd>' (verify the tree changed and tests pass)",
          invariants: [
            verified
              ? "RED baseline matched, source tree mutated, and GREEN run passes."
              : "GREEN not verified: assert RED was captured, the tree changed, and the test passes.",
            verified
              ? "Next, render the PR description draft using pr-template before auditing governance."
              : "Establish a verified RED→GREEN cycle before the governance audit.",
          ],
        });
      } catch (err: any) {
        printJSON({ status: "error", message: err.message }, opts.pretty);
        process.exit(1);
      }
    },
  );
