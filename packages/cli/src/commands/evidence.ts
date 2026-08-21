/** `opencontrib evidence` — Dual-stage empirical verification. */

import { Command } from 'commander';
import {
  capturePreFixAssertion,
  collectEvidence,
  ContributionRunManager,
  verifyDualStageReproduction,
} from '@opencontrib/core';
import { printJSON } from '../utils/output.js';

const runManager = new ContributionRunManager();

export const evidenceCommand = new Command('evidence')
  .description('Execute dual-stage empirical verification (pre-fix baseline + post-fix stress loop)')
  .requiredOption('--cwd <path>', 'Workspace directory to run tests in')
  .requiredOption('--test-cmd <cmd>', 'Test command, e.g. "npm test" or "pytest"')
  .option('--pre-fix-cmd <cmd>', 'Separate command to trigger pre-fix failure baseline')
  .option('--assertion <regex>', 'Expected failure assertion regex before fix')
  .option('--stress-loop <n>', 'Stress loop iterations', (v) => Number(v), 20)
  .option('--concurrency <n>', 'Concurrent stampede worker threads', (v) => Number(v), 1)
  .option('--workspace-root <path>', 'Root workspace for security boundary')
  .option('--baseline-sha <sha>', 'Baseline commit SHA before changes')
  .option('--run-id <id>', 'Auto-resolve workspace from run and save evidence artifact')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    cwd: string;
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
    let workspaceRoot = opts.workspaceRoot;
    let baselineSha = opts.baselineSha;

    if (opts.runId) {
      try {
        const run = runManager.getRun(opts.runId);
        if (run?.artifacts?.workspace?.workspacePath && !workspaceRoot) {
          workspaceRoot = String(run.artifacts.workspace.workspacePath);
        }
        if (run?.artifacts?.workspace?.baseCommitSha && !baselineSha) {
          baselineSha = String(run.artifacts.workspace.baseCommitSha);
        }
      } catch {}
    }

    let dualStage: any;
    if (opts.assertion) {
      const preFixCheck = capturePreFixAssertion(
        opts.cwd,
        opts.preFixCmd || opts.testCmd,
        workspaceRoot,
      );
      dualStage = await verifyDualStageReproduction({
        cwd: opts.cwd,
        workspaceRoot,
        testCommand: opts.testCmd,
        preFixBaselineCaptured: preFixCheck.assertionCaptured,
        preFixFailureOutput: preFixCheck.baselineOutput,
        stressLoopCount: opts.stressLoop ?? 5,
      });
    }

    const evidence = await collectEvidence({
      cwd: opts.cwd,
      workspaceRoot,
      baselineCommitSha: baselineSha,
      testCommand: opts.testCmd,
      stressLoopCount: opts.stressLoop ?? 20,
      concurrencyWorkers: opts.concurrency ?? 1,
    });

    const fullReport = { ...evidence, dualStage };

    let persistence: { saved: boolean; error?: string } | undefined;
    if (opts.runId) {
      try {
        runManager.saveArtifact(opts.runId, 'evidence', fullReport, 'EVIDENCE_COLLECTED');
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
  });