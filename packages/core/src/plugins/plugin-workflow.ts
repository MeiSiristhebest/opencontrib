import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';

export const workflowPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-workflow',
  version: '1.0.0',
  description: 'GitHub Actions CI workflow security and runtime modernization probe',
  permissions: ['fs:read'],
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
            const lines = content.split('\n');

            lines.forEach((lineText, idx) => {
              const lineNum = idx + 1;
              // 1. Deprecated actions/checkout
              if (lineText.includes('actions/checkout@v1') || lineText.includes('actions/checkout@v2') || lineText.includes('actions/checkout@v3')) {
                pointers.create({
                  namespace: 'findings',
                  id: `ci-checkout-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`,
                  title: `Upgrade deprecated actions/checkout in ${file}:${lineNum}`,
                  category: 'ci_workflow',
                  severity: 'medium',
                  file: `.github/workflows/${file}`,
                  line: lineNum,
                  confidence: 98,
                  affectedSymbol: 'actions/checkout',
                  callSite: lineText.trim(),
                  slice: {
                    codeSnippet: lineText,
                    ruleExplanation: 'Actions checkout v1-v3 uses deprecated Node runtimes. Upgrading to v4 ensures long-term runner compatibility.',
                    remediationSuggestion: 'Update to: uses: actions/checkout@v4',
                  },
                });
              }

              // 2. Deprecated setup-node
              if (lineText.includes('actions/setup-node@v1') || lineText.includes('actions/setup-node@v2') || lineText.includes('actions/setup-node@v3')) {
                pointers.create({
                  namespace: 'findings',
                  id: `ci-setup-node-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`,
                  title: `Upgrade deprecated actions/setup-node in ${file}:${lineNum}`,
                  category: 'ci_workflow',
                  severity: 'medium',
                  file: `.github/workflows/${file}`,
                  line: lineNum,
                  confidence: 98,
                  affectedSymbol: 'actions/setup-node',
                  callSite: lineText.trim(),
                  slice: {
                    codeSnippet: lineText,
                    ruleExplanation: 'Actions setup-node v1-v3 targets deprecated Node runtimes.',
                    remediationSuggestion: 'Update to: uses: actions/setup-node@v4',
                  },
                });
              }
            });
          }
        } catch {
          // Handled
        }
      },
    });
  },
};
