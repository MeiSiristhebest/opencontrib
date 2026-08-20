/** `opencontrib governance <sub>` — Audit, impact, CI diagnosis, PR template. */

import { Command } from 'commander';
import {
  auditGovernance,
  analyzePatchImpactAndConsistency,
  parseCiRawLogs,
  renderMasterPrTemplate,
} from '@opencontrib/core';
import { printJSON, parseJSON, readStdin } from '../utils/output.js';

// ─── governance audit ─────────────────────────────────────────────────────────
const auditCommand = new Command('audit')
  .description('Audit patch for anti-AI patterns, diff size, and quality confidence rubric')
  .requiredOption('--patch <file-or-text>', 'Git unified diff content')
  .requiredOption('--pr-title <text>', 'Proposed PR title')
  .requiredOption('--pr-body <text>', 'Proposed PR body text')
  .option('--evidence <json>', 'Evidence JSON from collect_evidence')
  .option('--subagent-score <n>', 'External subagent quality score (0-100)', (v) => Number(v))
  .option('--is-autonomous', 'Whether preparing for autonomous PR submission', false)
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    patch: string;
    prTitle: string;
    prBody: string;
    evidence?: string;
    subagentScore?: number;
    isAutonomous?: boolean;
    pretty?: boolean;
  }) => {
    const evidence = opts.evidence
      ? (parseJSON(opts.evidence, '--evidence') as any) || undefined
      : undefined;
    const audit = auditGovernance({
      patchContent: opts.patch,
      prTitle: opts.prTitle,
      prBody: opts.prBody,
      evidence,
      subagentQualityScore: opts.subagentScore,
      isAutonomousPrSubmission: opts.isAutonomous ?? false,
    });
    printJSON({
      status: audit.overallConfidence.isPassed ? 'passed' : 'failed',
      audit,
    }, opts.pretty);
  });

// ─── governance impact ────────────────────────────────────────────────────────
const impactCommand = new Command('impact')
  .description('Analyze patch for cross-platform anti-patterns and overlooked sibling files')
  .requiredOption('--patch <file-or-text>', 'Git unified diff content')
  .requiredOption('--modified-files <list>', 'Comma-separated list of modified files', (v) => v.split(','))
  .option('--repo-context <list>', 'Comma-separated repo file paths for sibling detection', (v) => v.split(','))
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    patch: string;
    modifiedFiles: string[];
    repoContext?: string[];
    pretty?: boolean;
  }) => {
    const analysis = analyzePatchImpactAndConsistency({
      modifiedFiles: opts.modifiedFiles,
      patchContent: opts.patch,
      repoContextFiles: opts.repoContext,
    });
    printJSON({
      status: analysis.isCompliant ? 'compliant' : 'warnings_found',
      analysis,
    }, opts.pretty);
  });

// ─── governance ci-diagnose ───────────────────────────────────────────────────
const ciDiagnoseCommand = new Command('ci-diagnose')
  .description('Parse CI logs to extract failing test names, line numbers, and root causes')
  .option('--log-file <path>', 'Path to raw CI/terminal log file (or pipe via stdin)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { pretty?: boolean }, cmd: Command) => {
    const logFile = (opts as any)['log-file'];
    let rawLog: string;
    if (logFile) {
      const fs = await import('fs');
      rawLog = fs.readFileSync(logFile, 'utf-8');
    } else {
      rawLog = await readStdin();
    }
    if (!rawLog) {
      console.error('❌ No log input. Use --log-file <path> or pipe via stdin');
      process.exit(1);
    }
    const report = parseCiRawLogs(rawLog);
    printJSON({
      status: report.hasFailure ? 'failure_detected' : 'healthy',
      report,
    }, opts.pretty);
  });

// ─── governance pr-template ───────────────────────────────────────────────────
const prTemplateCommand = new Command('pr-template')
  .description('Render a clean PR description following target repo template or Master 6-Tier standard')
  .requiredOption('--issue <num>', 'Fixed issue number')
  .requiredOption('--issue-title <text>', 'Title of the issue')
  .requiredOption('--summary <text>', 'Concise fix summary')
  .requiredOption('--validation-cmd <cmd>', 'Command used to verify the fix')
  .requiredOption('--validation-output <text>', 'Test passing log excerpt')
  .option('--native-template <text>', 'Raw markdown of target repo PULL_REQUEST_TEMPLATE.md')
  .option('--key-changes <list>', 'Comma-separated list of key changes made', (v) => v.split(','))
  .option('--confidence <n>', 'Quality confidence score (0-100)', (v) => Number(v))
  .option('--risk <level>', 'Risk tier', (v) => (['LOW', 'MEDIUM', 'HIGH'] as const).includes(v as any) ? v as 'LOW' | 'MEDIUM' | 'HIGH' : 'MEDIUM')
  .option('--is-docs-only', 'Documentation-only change', false)
  .option('--ai-disclosure', 'AI disclosure required by repo', false)
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    issue: string;
    issueTitle: string;
    summary: string;
    validationCmd: string;
    validationOutput: string;
    nativeTemplate?: string;
    confidence?: number;
    risk?: 'LOW' | 'MEDIUM' | 'HIGH';
    isDocsOnly?: boolean;
    aiDisclosure?: boolean;
    pretty?: boolean;
  }) => {
    const prBody = renderMasterPrTemplate({
      keyChanges: ['Fixed the issue'],
      nativeTemplateContent: opts.nativeTemplate,
      issueNumber: parseInt(opts.issue, 10) || 1,
      issueTitle: opts.issueTitle,
      summary: opts.summary,
      validationCommand: opts.validationCmd,
      validationOutputSnippet: opts.validationOutput,
      confidenceScore: opts.confidence,
      riskLevel: opts.risk,
      isDocumentationOnly: opts.isDocsOnly ?? false,
      aiDisclosureRequired: opts.aiDisclosure ?? false,
    });
    printJSON({ status: 'success', prBody }, opts.pretty);
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const governanceCommand = new Command('governance')
  .description('Governance audit, impact analysis, CI diagnosis, and PR template rendering')
  .addCommand(auditCommand)
  .addCommand(impactCommand)
  .addCommand(ciDiagnoseCommand)
  .addCommand(prTemplateCommand);