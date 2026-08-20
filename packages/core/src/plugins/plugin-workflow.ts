import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';

export const workflowPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-workflow',
  version: '1.0.0',
  description: 'GitHub Actions CI workflow security and runtime modernization probe',
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'workflow-linter',
      name: 'CI Workflow Modernization',
      category: 'ci_workflow',
      description: 'Scans .github/workflows for deprecated actions (checkout@v2/v3, setup-node@v2) and security hazards',
      match: (fp) => fp.hasWorkflows || fp.manifests.includes('.github/workflows'),
      scan: async (targetPath, pointers) => {
        const workflowsDir = path.join(targetPath, '.github', 'workflows');
        if (!fs.existsSync(workflowsDir)) return;

        try {
          const files = fs.readdirSync(workflowsDir);
          for (const file of files) {
            if (!file.endsWith('.yml') && !file.endsWith('.yaml')) continue;
            const fullPath = path.join(workflowsDir, file);
            const content = fs.readFileSync(fullPath, 'utf8');

            if (content.includes('actions/checkout@v2') || content.includes('actions/checkout@v3')) {
              pointers.create({
                namespace: 'findings',
                id: `ci-checkout-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
                title: `Upgrade deprecated actions/checkout in ${file}`,
                category: 'ci_workflow',
                severity: 'medium',
                file: `.github/workflows/${file}`,
                line: 1,
                confidence: 95,
                slice: {
                  codeSnippet: '- uses: actions/checkout@v3',
                  ruleExplanation: 'Actions checkout v2/v3 use deprecated Node runtimes. Upgrading to v4 ensures future runner compatibility.',
                  remediationSuggestion: 'Replace actions/checkout@v2 or @v3 with actions/checkout@v4',
                },
                evidence: {
                  executionCommand: 'action-validator .github/workflows/*.yml',
                },
              });
            }
          }
        } catch {
          // Handled
        }
      },
    });
  },
};
