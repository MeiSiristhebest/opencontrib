import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';

export const ocrPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-ocr',
  version: '1.0.0',
  description: 'Alibaba OpenCodeReview hybrid rule matcher for NPE, concurrency, and SQL injection',
  permissions: ['exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'ocr',
      name: 'Alibaba OpenCodeReview',
      category: 'lifecycle_leak',
      description: 'Finds NPEs, concurrency traps, and SQL injection via OCR rule matcher',
      match: (fp) => {
        const langs = fp.languages.map((l) => l.language.toLowerCase());
        return (
          langs.includes('go') ||
          langs.includes('java') ||
          langs.includes('typescript') ||
          langs.includes('python') ||
          langs.includes('c++')
        );
      },
      scan: async (targetPath, pointers, host) => {
        // If ocr binary is installed on host, execute it
        if (host.isBinaryAvailable('ocr')) {
          try {
            const { stdout } = await host.exec(`ocr scan --path "${targetPath}" --json`, {
              cwd: targetPath,
            });
            const data = JSON.parse(stdout);
            for (const c of data.comments || []) {
              pointers.create({
                namespace: 'findings',
                id: `ocr-${c.file}-${c.line}`,
                title: c.title || c.ruleName || 'Potential Null Pointer / Concurrency Defect',
                category: c.ruleType?.includes('concurrency') ? 'lifecycle_leak' : 'protocol_drift',
                severity: c.severity === 'critical' ? 'critical' : 'high',
                file: c.file,
                line: c.line || 1,
                confidence: 94,
                slice: {
                  codeSnippet: c.snippet || `// File: ${c.file}:${c.line}`,
                  ruleExplanation: c.explanation || c.content,
                  remediationSuggestion: c.suggestion,
                },
                evidence: {
                  rawPayload: c,
                },
              });
            }
          } catch {
            // Handled
          }
        }
      },
    });
  },
};
