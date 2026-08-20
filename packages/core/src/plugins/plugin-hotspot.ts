import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { analyzeGitHotspots } from '../probe/forensics.js';

export const hotspotPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-hotspot',
  version: '1.0.0',
  description: 'Code as a Crime Scene Git churn and cyclomatic complexity hotspot forensics',
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'git-hotspot',
      name: 'Git Hotspot Forensics',
      category: 'lifecycle_leak',
      description: 'Pinpoints the top vulnerable files using Churn × Complexity ranking',
      match: (fp) => fp.totalFiles > 0,
      scan: async (targetPath, pointers) => {
        const result = analyzeGitHotspots(targetPath, { limit: 5 });
        for (const h of result.topHotspots) {
          pointers.create({
            namespace: 'hotspots',
            id: `hotspot-${h.file.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            title: `High-Risk Code Hotspot: ${h.file} (Score: ${h.hotspotScore})`,
            category: 'lifecycle_leak',
            severity: h.riskLevel === 'critical' ? 'high' : 'medium',
            file: h.file,
            line: 1,
            confidence: h.riskScore,
            slice: {
              codeSnippet: `// File: ${h.file} (LOC: ${h.linesOfCode}, Complexity: ${h.cyclomaticComplexity})`,
              ruleExplanation: `File modified ${h.commitsCount} times recently with cyclomatic complexity ${h.cyclomaticComplexity}. High probability of race conditions or state desynchronization.`,
              remediationSuggestion: `Inspect recent commit diffs by top contributors: ${h.topContributors.join(', ')}`,
            },
            evidence: {
              rawPayload: h as any,
            },
          });
        }
      },
    });
  },
};
