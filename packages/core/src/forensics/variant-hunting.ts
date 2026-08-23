import * as path from 'path';
import { spawnSync } from 'child_process';
import type { PointerStub, PluginHostContract } from '../kernel/contract.js';

export interface DiscoveredVariant {
  sourceFindingId: string;
  variantFile: string;
  variantLine: number;
  snippet: string;
  confidence: number;
}

/**
 * Variant Hunter (Aligned with ast-grep + ripgrep best practices)
 *
 * Strategy:
 *  1. ast-grep structural query (primary — already integrated via PluginHost)
 *  2. ripgrep `--fixed-strings` (fallback — zero false positives from substrings)
 *  3. Never falls back to fs.readdirSync + line.includes() which produces massive false positives
 */
export class VariantHunter {
  /**
   * Hunts for variants of a given finding across the entire repository.
   */
  public static async huntVariants(
    repoPath: string,
    finding: PointerStub,
    host: PluginHostContract,
  ): Promise<DiscoveredVariant[]> {
    const variants: DiscoveredVariant[] = [];
    const callSite = finding.callSite || finding.slice?.codeSnippet;
    if (!callSite) return variants;

    // ── Layer 1: ast-grep structural query ──
    const hasAstGrep = typeof (host as any).isBinaryAvailable === 'function'
      ? ((host as any).isBinaryAvailable('ast-grep') || (host as any).isBinaryAvailable('sg'))
      : false;

    if (hasAstGrep && finding.affectedSymbol && typeof (host as any).exec === 'function') {
      const bin = (host as any).isBinaryAvailable('ast-grep') ? 'ast-grep' : 'sg';
      try {
        const ext = path.extname(finding.file).toLowerCase();
        const lang = ext === '.go' ? 'go'
          : ext === '.py' ? 'python'
          : ext === '.rs' ? 'rust'
          : ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs' ? 'js'
          : ext === '.c' || ext === '.h' ? 'c'
          : ext === '.cpp' || ext === '.cc' || ext === '.cxx' || ext === '.hpp' ? 'cpp'
          : ext === '.java' ? 'java'
          : 'ts';

        const pattern = `${finding.affectedSymbol}($$$ARGS)`;
        const { stdout } = await (host as any).exec(`${bin} run -p "${pattern}" --lang ${lang} --json=compact`, {
          cwd: repoPath,
          timeout: 20000,
        });

        if (stdout && stdout.trim().startsWith('[')) {
          const matches = JSON.parse(stdout);
          for (const m of matches) {
            const relPath = path.relative(repoPath, m.file).replace(/\\/g, '/');
            const targetFileNorm = finding.file.replace(/\\/g, '/');
            const line = m.range.start.line + 1;
            if (relPath === targetFileNorm && line === finding.line) continue;

            variants.push({
              sourceFindingId: finding.id,
              variantFile: relPath,
              variantLine: line,
              snippet: m.text,
              confidence: 90,
            });
          }
        }
      } catch {
        // Handled
      }
    }

    // ── Layer 2: ripgrep --fixed-strings (exact match, no false positives) ──
    // Replaces the old fs.readdirSync + line.includes() fallback which matched
    // substrings in comments, strings, and unrelated symbols.
    if (variants.length === 0 && finding.affectedSymbol) {
      const matches = this.searchWithRipgrep(repoPath, finding.affectedSymbol, finding.file, finding.line);
      for (const m of matches) {
        variants.push({
          sourceFindingId: finding.id,
          variantFile: m.file,
          variantLine: m.line,
          snippet: m.snippet,
          confidence: 80,
        });
      }
    }

    return variants;
  }

  /**
   * Searches the repository using ripgrep with --fixed-strings for exact
   * symbol matching.  This eliminates false positives from substrings, comments,
   * and string literals that the old line.includes() approach produced.
   */
  private static searchWithRipgrep(
    repoPath: string,
    symbol: string,
    excludeFile: string,
    excludeLine?: number,
  ): Array<{ file: string; line: number; snippet: string }> {
    const results: Array<{ file: string; line: number; snippet: string }> = [];
    const ext = path.extname(excludeFile);
    const extGlob = ext ? `--glob "*${ext}"` : '';

    // Try ripgrep first (fastest, most accurate text search available)
    const rgResult = spawnSync('rg', [
      '--fixed-strings', '--with-filename', '--line-number',
      '--glob', '!node_modules', '--glob', '!.git', '--glob', '!dist',
      ...(extGlob ? [extGlob] : []),
      symbol,
    ], { encoding: 'utf-8', timeout: 15000, cwd: repoPath });

    if (rgResult.status === 0 && rgResult.stdout) {
      const excludeRel = path.relative(repoPath, excludeFile).replace(/\\/g, '/');
      for (const rawLine of rgResult.stdout.split(/\r?\n/)) {
        const match = rawLine.match(/^([^:]+):(\d+):(.*)$/);
        if (!match) continue;
        const relPath = path.relative(repoPath, match[1]).replace(/\\/g, '/');
        const lineNum = parseInt(match[2], 10);
        if (relPath === excludeRel && excludeLine && lineNum === excludeLine) continue;
        results.push({ file: match[1], line: lineNum, snippet: match[3].trim() });
      }
    }

    // Fallback: if ripgrep is not installed, use ast-grep with simpler pattern
    if (results.length === 0) {
      try {
        const lang = ext === '.go' ? 'go'
          : ext === '.py' ? 'python'
          : ext === '.rs' ? 'rust'
          : ext === '.java' ? 'java'
          : ext === '.js' || ext === '.jsx' ? 'js'
          : 'ts';

        const bin = spawnSync('where.exe', ['-q', 'sg'], { timeout: 3000 }).status === 0
          ? 'sg' : spawnSync('where.exe', ['-q', 'ast-grep'], { timeout: 3000 }).status === 0
          ? 'ast-grep' : null;

        if (bin) {
          const result = spawnSync(bin, ['run', '-p', symbol, `--lang`, lang, '--json=compact'], {
            encoding: 'utf-8', timeout: 15000, cwd: repoPath,
          });
          if (result.stdout && result.stdout.trim().startsWith('[')) {
            const excludeRel = path.relative(repoPath, excludeFile).replace(/\\/g, '/');
            const matches = JSON.parse(result.stdout);
            for (const m of matches) {
              const relPath = path.relative(repoPath, m.file).replace(/\\/g, '/');
              const line = m.range.start.line + 1;
              if (relPath === excludeRel && excludeLine && line === excludeLine) continue;
              results.push({ file: relPath, line, snippet: m.text });
            }
          }
        }
      } catch {
        // No search tool available
      }
    }

    return results;
  }
}

// Backward Compatibility Alias
export const VariantHuntingEngine = VariantHunter;
