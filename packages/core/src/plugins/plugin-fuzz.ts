import * as fs from 'fs';
import * as path from 'path';
import type { OpenContribPlugin, PluginContext } from '../kernel/contract.js';
import { generatePropertyTest } from '../probe/fuzz-generator.js';

export const fuzzPlugin: OpenContribPlugin = {
  name: '@opencontrib/plugin-fuzz',
  version: '2.0.0',
  description: 'Property-based boundary fuzz test generator - discovers real functions via language-aware analysis',
  permissions: ['fs:read'],
  activate: (ctx: PluginContext) => {
    ctx.probes.register({
      id: 'property-fuzz',
      name: 'Property-Based Invariant Fuzzing',
      category: 'numerical_bounds',
      description: 'Discovers real functions via language-specific regex and synthesizes minimal reproducible property tests',
      match: (fp) =>
        fp.languages.some((l) =>
          ['typescript', 'javascript', 'python', 'rust', 'go'].includes(l.language.toLowerCase())
        ),
      scan: async (targetPath, pointers, host) => {
        const extensions: { ext: string; lang: string; funcRegexes: RegExp[]; skipExt: string[] } = [
          { ext: '.ts', lang: 'typescript', funcRegexes: [
            /(?:export\s+)?function\s+(\w+)\s*\(/g,
            /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
          ], skipExt: ['.d.ts'] },
          { ext: '.js', lang: 'javascript', funcRegexes: [
            /(?:export\s+)?function\s+(\w+)\s*\(/g,
            /(?:export\s+)?const\s+(\w+)\s*=\s*(?:async\s*)?\(/g,
          ], skipExt: [] },
          { ext: '.py', lang: 'python', funcRegexes: [/^\s*def\s+(\w+)\s*\(/gm], skipExt: [] },
          { ext: '.go', lang: 'go', funcRegexes: [/func\s+(?:\([^)]*\)\s+)?(\w+)\s*\(/g], skipExt: [] },
          { ext: '.rs', lang: 'rust', funcRegexes: [
            /fn\s+(\w+)\s*\(/g,
            /pub\s+fn\s+(\w+)\s*\(/g,
          ], skipExt: [] },
        ];

        const MAX_PER_FILE = 50;
        const MAX_TOTAL = 10;

        const functions: Array<{ file: string; name: string; lang: string }> = [];
        let totalTestsGenerated = 0;

        const discoverFunctions = (dir: string) => {
          if (!fs.existsSync(dir)) return;
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'build') continue;
              discoverFunctions(fullPath);
              if (functions.length >= MAX_TOTAL) return;
            } else if (entry.isFile()) {
                  for (const extInfo of extensions) {
                    if (fullPath.endsWith(extInfo.ext) && !extInfo.skipExt.some((s) => fullPath.endsWith(s))) {
                      try {
                        const content = fs.readFileSync(fullPath, 'utf8');
                        const lines = content.split(/\r?\n/);
                        const fileCount = functions.filter((f) => f.file === fullPath).length;
                        if (fileCount >= MAX_PER_FILE) continue;

                        for (const line of lines) {
                          const stripped = line.replace(/(\/\/|\/\*|\*|#).*/, '');
                          for (const regex of extInfo.funcRegexes) {
                            regex.lastIndex = 0;
                            for (const match of stripped.matchAll(regex)) {
                              if (match[1] && !['if', 'for', 'while', 'switch', 'catch'].includes(match[1])) {
                                functions.push({ file: fullPath, name: match[1], lang: extInfo.lang });
                                totalTestsGenerated++;
                                if (totalTestsGenerated >= MAX_TOTAL) return;
                              }
                            }
                          }
                        }
                      } catch {
                        // Skip unreadable files
                      }
                    }
                  }
              if (functions.length >= MAX_TOTAL) return;
            }
          }
        };

        discoverFunctions(targetPath);

        if (functions.length === 0) return;

        for (const func of functions) {
          const lang = func.lang === 'go' ? 'go' : func.lang === 'python' ? 'python' : func.lang === 'rust' ? 'rust' : 'typescript';
          const spec = generatePropertyTest('numerical_bounds' as any, lang, func.name);

          const relFile = path.relative(targetPath, func.file);
          pointers.create({
            namespace: 'fuzz',
            id: `fuzz-${func.name}-${relFile.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
            title: `Property-Based Invariant Test for ${func.name} (${spec.framework})`,
            category: 'numerical_bounds',
            severity: 'medium',
            file: relFile,
            confidence: 90,
            slice: {
              codeSnippet: spec.codeSnippet,
              ruleExplanation: `Targeted property-based fuzz attack against ${func.name}`,
              remediationSuggestion: `Review ${func.name} behavior with property-based test harness:\n${spec.codeSnippet}`,
            },
            evidence: {
              pocCode: spec.codeSnippet,
              expectedFailurePattern: spec.reproAssertion,
            },
          });
        }
      },
    });
  },
};
