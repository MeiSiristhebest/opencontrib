/** `opencontrib discovery <sub>` — Opportunity scoring, qualification, context assembly. */

import { Command } from 'commander';
import {
  assessFeasibility,
  detectSystemCapabilities,
  qualifyIssue,
  rankOpportunitySignals,
} from '@opencontrib/core';
import { printJSON, parseJSON, readStdin } from '../utils/output.js';

// ─── Sub-commands (defined before discoveryCommand to avoid TDZ) ───────────────

const rankCommand = new Command('rank')
  .description('Rank an opportunity by multi-dimensional probability signals')
  .option('--input <json>', 'JSON object with issue, repository, developerProfile (or pipe via stdin)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { pretty?: boolean }, cmd: Command) => {
    const input = (opts as any).input ?? await readStdin();
    const parsed = parseJSON(input, 'stdin') as any;
    if (!parsed?.issue) {
      console.error('❌ Missing required "issue" field in input JSON');
      process.exit(1);
    }
    const repoObj = parsed.repository || parsed.repo;
    const normalizedRepo = {
      fullName: repoObj?.fullName || 'unknown/unknown',
      stars: repoObj?.stars ?? repoObj?.starsCount ?? 0,
      primaryLanguage: repoObj?.primaryLanguage,
    };
    const signals = rankOpportunitySignals({
      issue: parsed.issue,
      repository: normalizedRepo,
      developerProfile: parsed.developerProfile,
    });
    printJSON({ status: 'success', signals }, opts.pretty);
  });

const qualifyCommand = new Command('qualify')
  .description('Check author-first-right, anti-bandwagoning, and blocking labels')
  .option('--input <json>', 'JSON object with issue data (or pipe via stdin)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { pretty?: boolean }, cmd: Command) => {
    const input = (opts as any).input ?? await readStdin();
    const parsed = parseJSON(input, 'stdin') as any;
    if (!parsed?.issueNumber || !parsed.issueTitle) {
      console.error('❌ Missing required "issueNumber" and "issueTitle" in input JSON');
      process.exit(1);
    }
    const qualification = qualifyIssue(parsed);
    printJSON({
      status: qualification.isQualified ? 'qualified' : 'disqualified',
      qualification,
    }, opts.pretty);
  });

const feasibilityCommand = new Command('feasibility')
  .description('Assess OS and toolchain execution feasibility for an issue')
  .requiredOption('--title <text>', 'Issue title')
  .option('--body <text>', 'Issue body text', '')
  .option('--labels <list>', 'Issue labels, comma-separated', (v) => v.split(','))
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { title: string; body?: string; labels?: string[]; pretty?: boolean }) => {
    const capabilities = detectSystemCapabilities();
    const assessment = assessFeasibility(
      opts.title,
      opts.body || '',
      opts.labels || [],
      capabilities,
    );
    printJSON({
      status: 'success',
      assessment,
      localCapabilities: {
        os: capabilities.os,
        hasWsl: capabilities.hasWsl,
        hasDocker: capabilities.hasDocker,
      },
    }, opts.pretty);
  });

const contextCommand = new Command('context')
  .description('Assemble multi-dimensional context for an issue (problem, repo skeleton, test targets)')
  .option('--input <json>', 'JSON with issue, repoDetails, repoTree (or pipe via stdin)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { pretty?: boolean }, cmd: Command) => {
    const input = (opts as any).input ?? await readStdin();
    const parsed = parseJSON(input, 'stdin') as any;
    if (!parsed?.issue || !parsed.repoDetails) {
      console.error('❌ Missing required "issue" and "repoDetails" in input JSON');
      process.exit(1);
    }
    const { ContextAssembler } = await import('@opencontrib/core');
    const assembler = new ContextAssembler();
    const repoTree = (parsed.repoTree || []).map((item: any) => ({
      path: item.path,
      mode: '100644',
      type: item.type as any,
      sha: item.sha || 'placeholder',
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
        fullName: parsed.repoDetails.fullName || `${parsed.repoDetails.owner}/${parsed.repoDetails.repo}`,
      },
      repoTree,
    });
    printJSON({ status: 'success', context }, opts.pretty);
  });

const manifestsCommand = new Command('manifests')
  .description('Diagnose repo manifests (workflows, package.json, pyproject, etc.) for ≤100-line PR improvements')
  .option('--input <json>', 'JSON with workflows, readmeContent, packageJsonContent, etc. (or pipe via stdin)')
  .option('--pretty', 'Pretty-print', false)
  .action(async (opts: { pretty?: boolean }, cmd: Command) => {
    const input = (opts as any).input ?? await readStdin();
    const parsed = parseJSON(input, 'stdin') as any;
    const suggestions: any[] = [];
    for (const wf of parsed.workflows || []) {
      const content = wf.content || '';
      if (content.includes('actions/checkout@v2') || content.includes('actions/checkout@v3')) {
        suggestions.push({
          id: `ci-upgrade-checkout-${(wf.path || '').replace(/[^a-zA-Z0-9]/g, '_')}`,
          title: `Upgrade deprecated actions/checkout to v4 in ${wf.path}`,
          category: 'ci_workflow',
          prPotentialScore: 92,
        });
      }
    }
    if (parsed.pyprojectContent && !parsed.pyprojectContent.includes('[tool.ruff]')) {
      suggestions.push({
        id: 'python-add-ruff-linter',
        title: 'Configure Ruff linter in pyproject.toml',
        category: 'code_hygiene',
        prPotentialScore: 85,
      });
    }
    if (!parsed.dependabotContent) {
      suggestions.push({
        id: 'security-enable-dependabot',
        title: 'Add automated Dependabot config',
        category: 'security',
        prPotentialScore: 91,
      });
    }
    printJSON({
      status: 'success',
      suggestionsCount: suggestions.length,
      suggestions: suggestions.sort((a, b) => b.prPotentialScore - a.prPotentialScore),
    }, opts.pretty);
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const discoveryCommand = new Command('discovery')
  .description('Opportunity scoring, qualification, and context assembly')
  .addCommand(rankCommand)
  .addCommand(qualifyCommand)
  .addCommand(feasibilityCommand)
  .addCommand(contextCommand)
  .addCommand(manifestsCommand);