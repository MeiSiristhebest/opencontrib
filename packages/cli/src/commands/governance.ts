/** `opencontrib governance <sub>` — Audit, impact, CI diagnosis, PR template. */

import { Command } from 'commander';
import {
  auditGovernance,
  analyzePatchImpactAndConsistency,
  parseCiRawLogs,
  renderMasterPrTemplate,
  validateMarkdownIntegrity,
} from '@opencontrib/core';
import { printJSON, parseJSON, readStdin } from '../utils/output.js';

import fs from 'node:fs';

// ─── governance audit ─────────────────────────────────────────────────────────
const auditCommand = new Command('audit')
  .description('Audit patch for anti-AI patterns, diff size, markdown integrity, and quality confidence rubric')
  .requiredOption('--patch <file-or-text>', 'Git unified diff content or path to .diff/.patch file')
  .requiredOption('--pr-title <text>', 'Proposed PR title')
  .option('--pr-body <text>', 'Proposed PR body text')
  .option('--pr-body-file <path>', 'Path to markdown file containing proposed PR body')
  .option('--evidence <json>', 'Evidence JSON from collect_evidence')
  .option('--subagent-score <n>', 'External subagent quality score (0-100)', (v) => Number(v))
  .option('--is-autonomous', 'Whether preparing for autonomous PR submission', false)
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: {
    patch: string;
    prTitle: string;
    prBody?: string;
    prBodyFile?: string;
    evidence?: string;
    subagentScore?: number;
    isAutonomous?: boolean;
    pretty?: boolean;
  }) => {
    try {
      let patchContent = opts.patch;
      if (fs.existsSync(opts.patch)) {
        try {
          patchContent = fs.readFileSync(opts.patch, 'utf-8');
        } catch (err: any) {
          console.error(`Failed to read patch file "${opts.patch}": ${err.message}`);
          process.exit(1);
        }
      }

      let prBodyContent = opts.prBody || '';
      if (opts.prBodyFile && fs.existsSync(opts.prBodyFile)) {
        try {
          prBodyContent = fs.readFileSync(opts.prBodyFile, 'utf-8');
        } catch (err: any) {
          console.error(`Failed to read PR body file "${opts.prBodyFile}": ${err.message}`);
          process.exit(1);
        }
      }

      const evidence = opts.evidence
        ? (parseJSON(opts.evidence, '--evidence') as any) || undefined
        : undefined;
      const audit = auditGovernance({
        patchContent,
        prTitle: opts.prTitle,
        prBody: prBodyContent,
        evidence,
        subagentQualityScore: opts.subagentScore,
        isAutonomousPrSubmission: opts.isAutonomous ?? false,
      });
      printJSON({
        status: audit.overallConfidence.isPassed ? 'passed' : 'failed',
        audit,
      }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
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
    try {
      const analysis = analyzePatchImpactAndConsistency({
        modifiedFiles: opts.modifiedFiles,
        patchContent: opts.patch,
        repoContextFiles: opts.repoContext,
      });
      printJSON({
        status: analysis.isCompliant ? 'compliant' : 'warnings_found',
        analysis,
      }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── governance ci-diagnose ───────────────────────────────────────────────────
const ciDiagnoseCommand = new Command('ci-diagnose')
  .description('Parse CI logs to extract failing test names, line numbers, and root causes')
  .option('--log-file <path>', 'Path to raw CI/terminal log file (or pipe via stdin)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { pretty?: boolean }, cmd: Command) => {
    try {
      const logFile = (opts as any)['log-file'];
      let rawLog: string;
      if (logFile) {
        const fsLib = await import('fs');
        rawLog = fsLib.readFileSync(logFile, 'utf-8');
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
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── governance pr-template ───────────────────────────────────────────────────
const prTemplateCommand = new Command('pr-template')
  .description('Render a clean PR description following target repo template or Master 6-Tier standard')
  .requiredOption('--issue <num>', 'Fixed issue number')
  .requiredOption('--issue-title <text>', 'Title of the issue')
  .requiredOption('--summary <text>', 'Concise fix summary')
  .option('--validation-cmd <cmd>', 'Command used to verify the fix', 'bun test')
  .option('--validation-output <text>', 'Test passing log excerpt', 'All unit tests pass cleanly.')
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
    validationCmd?: string;
    validationOutput?: string;
    nativeTemplate?: string;
    confidence?: number;
    risk?: 'LOW' | 'MEDIUM' | 'HIGH';
    isDocsOnly?: boolean;
    aiDisclosure?: boolean;
    pretty?: boolean;
  }) => {
    try {
      const prBody = renderMasterPrTemplate({
        keyChanges: ['Fixed the issue'],
        nativeTemplateContent: opts.nativeTemplate,
        issueNumber: parseInt(opts.issue, 10) || 1,
        issueTitle: opts.issueTitle,
        summary: opts.summary,
        validationCommand: opts.validationCmd || 'bun test',
        validationOutputSnippet: opts.validationOutput || 'All unit tests pass cleanly.',
        confidenceScore: opts.confidence,
        riskLevel: opts.risk,
        isDocumentationOnly: opts.isDocsOnly ?? false,
        aiDisclosureRequired: opts.aiDisclosure ?? false,
      });
      printJSON({ status: 'success', prBody }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── governance claim / render-issue ─────────────────────────────────────────
const claimCommand = new Command('claim')
  .alias('render-issue')
  .description('Generate an authoritative Issue-First Claim statement or 0-day issue proposal')
  .requiredOption('--issue <num>', 'Target issue number (or temporary ID for 0-day)', '0')
  .requiredOption('--title <text>', 'Title of the issue')
  .option('--finding <summary>', 'Summary of root cause and file/line location')
  .option('--test-snippet <snippet>', 'Reproduction test code snippet')
  .option('--pretty', 'Pretty-print JSON output', false)
  .action(async (opts: {
    issue: string;
    title: string;
    finding?: string;
    testSnippet?: string;
    pretty?: boolean;
  }) => {
    try {
      const { ClaimProtocol } = await import('@opencontrib/core');
      const num = parseInt(opts.issue, 10) || 0;
      const payload = ClaimProtocol.generateClaimPayload(num, opts.title);
      if (opts.finding) {
        payload.findingSummary = opts.finding;
      }
      if (opts.testSnippet) {
        payload.claimComment += `\n\n\`\`\`\n${opts.testSnippet}\n\`\`\``;
      }
      printJSON({ status: 'success', payload }, opts.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts.pretty);
      process.exit(1);
    }
  });

// ─── governance lint-md ───────────────────────────────────────────────────────
const lintMdCommand = new Command('lint-md')
  .description('Run 5-layer industrial static validation on Markdown file or stdin')
  .argument('[file]', 'Path to markdown file to validate (reads from stdin if omitted)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (file?: string, opts?: { pretty?: boolean }) => {
    try {
      let content = '';
      if (file && fs.existsSync(file)) {
        content = fs.readFileSync(file, 'utf-8');
      } else {
        content = await readStdin();
      }
      const report = validateMarkdownIntegrity(content);
      printJSON({
        status: report.isValid ? 'passed' : 'failed',
        report,
      }, opts?.pretty);
    } catch (err: any) {
      printJSON({ status: 'error', message: err.message }, opts?.pretty);
      process.exit(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const governanceCommand = new Command('governance')
  .description('Governance audit, impact analysis, CI diagnosis, PR template rendering, Issue Claim generation, and Markdown linting')
  .addCommand(auditCommand)
  .addCommand(impactCommand)
  .addCommand(ciDiagnoseCommand)
  .addCommand(prTemplateCommand)
  .addCommand(claimCommand)
  .addCommand(lintMdCommand);