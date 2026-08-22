import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';

export const DEPRECATED_ACTIONS = [
  { pattern: 'actions/checkout@v1', replacement: 'actions/checkout@v4', reason: 'Deprecated Node runtime' },
  { pattern: 'actions/checkout@v2', replacement: 'actions/checkout@v4', reason: 'Deprecated Node runtime' },
  { pattern: 'actions/checkout@v3', replacement: 'actions/checkout@v4', reason: 'Deprecated Node runtime' },
  { pattern: 'actions/setup-node@v1', replacement: 'actions/setup-node@v4', reason: 'Deprecated Node runtime' },
  { pattern: 'actions/setup-node@v2', replacement: 'actions/setup-node@v4', reason: 'Deprecated Node runtime' },
  { pattern: 'actions/setup-node@v3', replacement: 'actions/setup-node@v4', reason: 'Deprecated Node runtime' },
  { pattern: 'actions/cache@v2', replacement: 'actions/cache@v4', reason: 'Deprecated cache API' },
  { pattern: 'actions/upload-artifact@v1', replacement: 'actions/upload-artifact@v4', reason: 'Deprecated artifact API' },
  { pattern: 'actions/upload-artifact@v2', replacement: 'actions/upload-artifact@v4', reason: 'Deprecated artifact API' },
  { pattern: 'actions/upload-artifact@v3', replacement: 'actions/upload-artifact@v4', reason: 'Deprecated artifact API' },
  { pattern: 'actions/download-artifact@v1', replacement: 'actions/download-artifact@v4', reason: 'Deprecated artifact API' },
  { pattern: 'actions/download-artifact@v2', replacement: 'actions/download-artifact@v4', reason: 'Deprecated artifact API' },
  { pattern: 'actions/download-artifact@v3', replacement: 'actions/download-artifact@v4', reason: 'Deprecated artifact API' },
  { pattern: 'actions/stale@v3', replacement: 'actions/stale@v9', reason: 'Deprecated stale action' },
  { pattern: 'azure/webapps-deploy@v2', replacement: 'azure/webapps-deploy@v3', reason: 'Deprecated Azure deploy' },
] as const;

export const workflowPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-workflow',
  version: '2.0.0',
  description: 'GitHub Actions CI workflow security, deprecation, and modernization probe',
  permissions: ['fs:read'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'workflow-linter',
      name: 'CI Workflow Modernization',
      category: 'ci_workflow',
      description: 'Scans .github/workflows for deprecated actions and security hazards',
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

              // 1. Deprecated action patterns
              for (const action of DEPRECATED_ACTIONS) {
                if (lineText.includes(action.pattern)) {
                  pointers.create({
                    namespace: 'findings',
                    id: `ci-deprecated-${action.pattern.replace(/[^a-zA-Z0-9_-]/g, '_')}-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`,
                    title: `Upgrade deprecated ${action.pattern} in ${file}:${lineNum}`,
                    category: 'ci_workflow',
                    severity: 'medium',
                    file: `.github/workflows/${file}`,
                    line: lineNum,
                    confidence: 98,
                    affectedSymbol: action.pattern,
                    callSite: lineText.trim(),
                    slice: {
                      codeSnippet: lineText,
                      ruleExplanation: `${action.pattern}: ${action.reason}`,
                      remediationSuggestion: `Update to: uses: ${action.replacement}`,
                    },
                  });
                }
              }

              // 2. Hardcoded secrets
              const secretMatch = lineText.match(/\b(API_KEY|SECRET_KEY|PASSWORD|TOKEN)\s*[=:]\s*["']([^"']+)["']/i);
              if (secretMatch) {
                pointers.create({
                  namespace: 'findings',
                  id: `ci-secret-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`,
                  title: `Hardcoded secret in workflow ${file}:${lineNum}`,
                  category: 'security_cwe',
                  severity: 'high',
                  file: `.github/workflows/${file}`,
                  line: lineNum,
                  confidence: 99,
                  affectedSymbol: secretMatch[1],
                  callSite: lineText.trim(),
                  slice: {
                    codeSnippet: lineText,
                    ruleExplanation: `Hardcoded ${secretMatch[1]} in workflow file`,
                    remediationSuggestion: 'Use ${{ secrets.SECRET_NAME }} instead of hardcoded values',
                  },
                });
              }

              // 3. pull_request_target security hazard
              if (lineText.includes('pull_request_target')) {
                pointers.create({
                  namespace: 'findings',
                  id: `ci-pr-target-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`,
                  title: `pull_request_target can expose secrets to untrusted code in ${file}:${lineNum}`,
                  category: 'security_cwe',
                  severity: 'high',
                  file: `.github/workflows/${file}`,
                  line: lineNum,
                  confidence: 95,
                  affectedSymbol: 'pull_request_target',
                  callSite: lineText.trim(),
                  slice: {
                    codeSnippet: lineText,
                    ruleExplanation: 'pull_request_target triggers in a context that merges untrusted PR code with repository secrets',
                    remediationSuggestion: 'Use pull_request with fork pull request checks, or restrict to trusted contributors',
                  },
                });
              }

              // 4. permissions: write-all
              if (lineText.includes('permissions:') && lineText.includes('write-all')) {
                pointers.create({
                  namespace: 'findings',
                  id: `ci-perms-writeall-${file.replace(/[^a-zA-Z0-9_-]/g, '_')}-${lineNum}`,
                  title: `Overly permissive write-all GITHUB_TOKEN in ${file}:${lineNum}`,
                  category: 'security_cwe',
                  severity: 'high',
                  file: `.github/workflows/${file}`,
                  line: lineNum,
                  confidence: 95,
                  affectedSymbol: 'GITHUB_TOKEN',
                  callSite: lineText.trim(),
                  slice: {
                    codeSnippet: lineText,
                    ruleExplanation: 'write-all grants all permissions; least-privilege principle violated',
                    remediationSuggestion: 'Grant only required permissions explicitly (contents: read, issues: write, etc.)',
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
