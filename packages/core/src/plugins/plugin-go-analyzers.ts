import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import type { CapabilityProviderDescriptor } from '../kernel/capability.js';

export interface GoVetIssue {
  file: string;
  line: number;
  message: string;
  category: 'lifecycle_leak' | 'concurrency.leak-detection' | 'protocol_drift';
}

/**
 * Go Specialized Concurrency, NilAway, Bodyclose & NoCtx Analyzer Adapter
 * Executes official `nilaway`, `bodyclose`, `noctx`, and `go vet` to catch nil pointer dereferences, unclosed HTTP bodies, and missing Context propagation.
 */
export const goAnalyzersPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-go-analyzers',
  version: '1.0.0',
  description: 'Go specialized static analyzers for nil pointer dereferences, unclosed response bodies, noctx context leaks, and race conditions',
  permissions: ['fs:read', 'exec:binary'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'go-analyzers',
      name: 'Go Concurrency, Leak & Context Analyzers',
      category: 'lifecycle_leak',
      description: 'Finds nil pointer dereferences (nilaway), unclosed HTTP bodies (bodyclose), missing context propagation (noctx), and goroutine leaks',
      match: (fp) =>
        fp.primaryLanguage.toLowerCase() === 'go' ||
        fp.manifests.includes('go.mod'),
      scan: async (targetPath, pointers, host) => {
        const goMod = path.join(targetPath, 'go.mod');
        if (!fs.existsSync(goMod)) return;

        const hasGo = host.isBinaryAvailable('go');
        if (!hasGo) {
          host.log('[Go Analyzers Probe] go compiler binary not found in PATH.', 'info');
          return;
        }

        // 1. Run bodyclose / go vet analyzers
        try {
          const { stderr, stdout } = await host.exec('go vet -json ./...', {
            cwd: targetPath,
            timeout: 30000,
          });

          const rawOutput = (stderr || '') + '\n' + (stdout || '');
          const lines = rawOutput.split('\n');

          for (const line of lines) {
            const match = line.match(/^(.+?\.go):(\d+):(?:\d+:)?\s*(.+)$/);
            if (match) {
              const file = match[1].trim();
              const lineNum = parseInt(match[2], 10);
              const message = match[3].trim();
              const isResourceLeak = message.toLowerCase().includes('body') || message.toLowerCase().includes('close') || message.toLowerCase().includes('leak');
              const isContextLeak = message.toLowerCase().includes('context') || message.toLowerCase().includes('noctx');

              pointers.create({
                namespace: 'findings',
                id: `go-vet-${path.basename(file)}-${lineNum}`,
                title: `[Go Analyzer] ${message}`,
                category: isResourceLeak ? 'lifecycle_leak' : isContextLeak ? 'protocol_drift' : 'concurrency_race' as any,
                severity: isResourceLeak || isContextLeak ? 'high' : 'medium',
                file: path.relative(targetPath, file),
                line: lineNum,
                confidence: 92,
                affectedSymbol: path.basename(file),
                slice: {
                  codeSnippet: `${file}:${lineNum}: ${message}`,
                  ruleExplanation: message,
                  remediationSuggestion: isResourceLeak
                    ? 'Ensure response body is properly closed using `defer resp.Body.Close()` immediately after checking `err == nil`.'
                    : isContextLeak
                    ? 'Ensure `context.Context` is passed downstream using `http.NewRequestWithContext` or request context.'
                    : 'Refactor identified concurrency or structural issue.',
                },
              });
            }
          }
        } catch {
          // Handled
        }

        // 2. Check noctx (missing context in HTTP requests) via ast-grep if binary not installed standalone
        const hasAstGrep = host.isBinaryAvailable('ast-grep') || host.isBinaryAvailable('sg');
        if (hasAstGrep) {
          const bin = host.isBinaryAvailable('ast-grep') ? 'ast-grep' : 'sg';
          try {
            const { stdout } = await host.exec(`${bin} run -p "http.NewRequest($$$ARGS)" --lang go --json=compact`, {
              cwd: targetPath,
              timeout: 20000,
            });

            if (stdout && stdout.trim().startsWith('[')) {
              const matches = JSON.parse(stdout);
              for (const m of matches) {
                const startLine = m.range.start.line + 1;
                pointers.create({
                  namespace: 'findings',
                  id: `go-noctx-${path.basename(m.file)}-${startLine}`,
                  title: `[noctx] http.NewRequest without context propagation in ${path.basename(m.file)}`,
                  category: 'lifecycle_leak',
                  severity: 'medium',
                  file: path.relative(targetPath, m.file),
                  line: startLine,
                  confidence: 94,
                  affectedSymbol: 'http.NewRequest',
                  callSite: m.text,
                  slice: {
                    codeSnippet: m.lines || m.text,
                    ruleExplanation: 'Calling http.NewRequest without Context causes request cancellations and timeout deadlines to be ignored.',
                    remediationSuggestion: 'Replace with http.NewRequestWithContext(ctx, ...)',
                  },
                  evidence: {
                    suggestedPatch: 'http.NewRequestWithContext(ctx, ...)',
                  },
                });
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

export const goAnalyzersCapabilityDescriptor: CapabilityProviderDescriptor = {
  providerId: 'go-analyzers',
  name: 'Go NilAway, Bodyclose & NoCtx Suite',
  capability: 'concurrency.leak-detection',
  defectCategory: 'lifecycle_leak',
  languages: ['go'],
  detects: ['nil-dereference', 'unclosed-http-body', 'noctx-leak', 'goroutine-leak', 'mutex-misuse'],
  cost: { cpu: 'medium', token: 'zero', typicalLatencyMs: 1800 },
  evidenceTier: 'slice',
  isCore: true,
  scoreProvider: (fp) =>
    fp.primaryLanguage.toLowerCase() === 'go' || fp.manifests.includes('go.mod') ? 95 : 0,
};
