/** `opencontrib evidence` — Dual-stage empirical verification. */

import { Command } from 'commander';
import {
  capturePreFixAssertion,
  collectEvidence,
  buildContributionRunManager,
  verifyDualStageReproduction,
  type ContributionRunManager,
} from '@opencontrib/core';
import { printJSON, printPhaseGuidance } from '../utils/output.js';

// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
const getRunManager = (): ContributionRunManager =>
  (_runManager ??= buildContributionRunManager());

export const evidenceCommand = new Command('evidence')
  .description('Execute dual-stage empirical verification (pre-fix baseline + post-fix stress loop)')
  .option('--cwd <path>', 'Workspace directory to run tests in (defaults to active session workspace)')
  .requiredOption('--test-cmd <cmd>', 'Test command, e.g. "npm test" or "pytest"')
  .option('--pre-fix-cmd <cmd>', 'Separate command to trigger pre-fix failure baseline')
  .option('--assertion <regex>', 'Expected failure assertion regex before fix')
  .option('--stress-loop <n>', 'Stress loop iterations (use >1 for concurrency/race tests)', (v) => Number(v), 1)
  .option('--concurrency <n>', 'Concurrent stampede worker threads', (v) => Number(v), 1)
  .option('--workspace-root <path>', 'Root workspace for security boundary')
  .option('--baseline-sha <sha>', 'Baseline commit SHA before changes')
  .option('--run-id <id>', 'Auto-resolve workspace from run and save evidence artifact (defaults to active session)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
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
            if (!workspaceRoot) workspaceRoot = String(run.artifacts.workspace.workspacePath);
            if (!targetCwd) targetCwd = String(run.artifacts.workspace.workspacePath);
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

      let dualStage: any;
      if (opts.assertion) {
        const preFixCheck = capturePreFixAssertion(
          targetCwd,
          opts.preFixCmd || opts.testCmd,
          workspaceRoot,
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

      const fullReport = { ...evidence, dualStage };

      let persistence: { saved: boolean; error?: string } | undefined;
      if (runId) {
        try {
          getRunManager().saveArtifact(runId, 'evidence', fullReport, 'EVIDENCE_COLLECTED');
          persistence = { saved: true };
        } catch (err: any) {
          persistence = { saved: false, error: err.message };
        }
      }

      printJSON({
        status: persistence?.error ? 'PARTIAL_SUCCESS' : 'success',
        evidence: fullReport,
        persistence,
      }, opts.pretty);

      printPhaseGuidance({
        currentPhase: 'EVIDENCE_COLLECTED',
        runId,
        status: 'SUCCESS',
        humanCheckpoint: 'Checkpoint 2 (Empirical Reproduction Verified)',
        nextCommand: 'opencontrib governance audit --patch <file> --pr-title "<title>"',
        invariants: [
          'Ensure unit test passed cleanly with 0 regressions before proceeding.',
          'Next, execute Phase 7 Governance Audit to verify RFC-100 line limit and anti-AI rubric.',
        ],
      });
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });