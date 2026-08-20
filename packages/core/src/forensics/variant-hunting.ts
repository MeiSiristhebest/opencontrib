import * as fs from 'fs';
import * as path from 'path';
import type { PointerStub, PluginHostContract } from '../kernel/contract.js';

export interface DiscoveredVariant {
  sourceFindingId: string;
  variantFile: string;
  variantLine: number;
  snippet: string;
  confidence: number;
}

/**
 * Variant Hunter (Inspired by Vigolium Piolium P12)
 * Clean domain semantic naming replacing fuzzy 'Engine' suffixes.
 * Scans the entire repository for parallel duplicated bugs or anti-pattern variants.
 */
export class VariantHunter {
  /**
   * Hunts for variants of a given finding across the entire repository
   */
  public static async huntVariants(
    repoPath: string,
    finding: PointerStub,
    host: PluginHostContract,
  ): Promise<DiscoveredVariant[]> {
    const variants: DiscoveredVariant[] = [];
    const callSite = finding.callSite || finding.slice?.codeSnippet;
    if (!callSite) return variants;

    // 1. Try ast-grep structural query if binary is available
    const hasAstGrep = typeof (host as any).isBinaryAvailable === 'function'
      ? ((host as any).isBinaryAvailable('ast-grep') || (host as any).isBinaryAvailable('sg'))
      : false;
    if (hasAstGrep && finding.affectedSymbol && typeof (host as any).exec === 'function') {
      const bin = (host as any).isBinaryAvailable('ast-grep') ? 'ast-grep' : 'sg';
      try {
        const lang = finding.file.endsWith('.go')
          ? 'go'
          : finding.file.endsWith('.py')
          ? 'python'
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

            // Exclude the original finding itself
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

    // 2. Fallback: Structural symbol line matching across target directory
    if (variants.length === 0 && finding.affectedSymbol) {
      const targetExt = path.extname(finding.file);
      const targetFileNorm = finding.file.replace(/\\/g, '/');
      this.scanDirectoryRecursive(repoPath, repoPath, targetExt, (file, lines) => {
        const rel = path.relative(repoPath, file).replace(/\\/g, '/');
        lines.forEach((lineText, idx) => {
          const lineNum = idx + 1;
          if (rel === targetFileNorm && lineNum === finding.line) return;

          if (lineText.includes(finding.affectedSymbol!)) {
            variants.push({
              sourceFindingId: finding.id,
              variantFile: rel,
              variantLine: lineNum,
              snippet: lineText.trim(),
              confidence: 80,
            });
          }
        });
      });
    }

    return variants;
  }

  private static scanDirectoryRecursive(
    root: string,
    current: string,
    ext: string,
    onFile: (filePath: string, lines: string[]) => void,
  ): void {
    if (!fs.existsSync(current)) return;
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist') continue;
      const full = path.join(current, e.name);
      if (e.isDirectory()) {
        this.scanDirectoryRecursive(root, full, ext, onFile);
      } else if (e.name.endsWith(ext)) {
        try {
          const content = fs.readFileSync(full, 'utf8');
          onFile(full, content.split('\n'));
        } catch {
          // Ignored
        }
      }
    }
  }
}

// Backward Compatibility Alias
export const VariantHuntingEngine = VariantHunter;
