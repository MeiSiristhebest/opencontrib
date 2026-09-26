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
          const hasLlmEnv = !!(
            process.env.OPENAI_API_KEY ||
            process.env.OCR_LLM_URL ||
            process.env.OCR_LLM_TOKEN ||
            process.env.ANTHROPIC_AUTH_TOKEN
          );

          if (hasLlmEnv) {
            try {
              const { stdout } = await host.exec(`ocr scan --path "${targetPath}" -f json`, {
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
              return;
            } catch {
              // Fallback to delegation mode
            }
          }

          // Host-Agent Delegation Mode: No external LLM key required!
          try {
            const preview = await host.exec('ocr delegate preview', { cwd: targetPath });
            const fileMatches = (preview.stdout || '').matchAll(/`([^`]+)`\s+\[(modified|added)\]/g);
            const changedFiles = Array.from(fileMatches).map((m) => m[1]);

            if (changedFiles.length > 0) {
              const quoted = changedFiles.map((f) => `"${f}"`).join(' ');
              const ruleRes = await host.exec(`ocr delegate rule -f json ${quoted}`, { cwd: targetPath });
              const ruleData = JSON.parse(ruleRes.stdout);
              for (const g of ruleData.groups || []) {
                for (const f of g.files || []) {
                  pointers.create({
                    namespace: 'findings',
                    id: `ocr-delegate-${f.replace(/[^a-zA-Z0-9]/g, '_')}`,
                    title: `OCR Delegated Review Spec: ${f}`,
                    category: 'protocol_drift',
                    severity: 'medium',
                    file: f,
                    line: 1,
                    confidence: 90,
                    slice: {
                      codeSnippet: `// File delegated for host-agent review: ${f}`,
                      ruleExplanation: g.rule?.slice(0, 500) || 'Alibaba OCR Host-Agent Delegation Rule',
                      remediationSuggestion: 'Host agent to review against OCR domain rules without requiring external LLM API key.',
                    },
                    evidence: {
                      rawPayload: { file: f, ruleGroup: g.group_id, pattern: g.pattern },
                    },
                  });
                }
              }
            }
          } catch {
            // Handled
          }
        }
      },
    });
  },
};
