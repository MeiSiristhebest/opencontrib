import * as fs from 'fs';
import * as path from 'path';
import type { PointerStub } from '../kernel/contract.js';

export interface FileSystemPort {
  readFile(relPath: string): string;
  readDir(relPath: string): string[];
  exists(relPath: string): boolean;
}

export class DefaultNodeFileSystemAdapter implements FileSystemPort {
  constructor(private basePath: string) {}

  public readFile(relPath: string): string {
    return fs.readFileSync(path.join(this.basePath, relPath), 'utf8');
  }

  public readDir(relPath: string): string[] {
    const target = path.join(this.basePath, relPath);
    if (!fs.existsSync(target)) return [];
    return fs.readdirSync(target);
  }

  public exists(relPath: string): boolean {
    return fs.existsSync(path.join(this.basePath, relPath));
  }
}

export interface ContextSnippet {
  filePath: string;
  role: 'target' | 'caller' | 'type_definition' | 'dependency';
  startLine: number;
  endLine: number;
  content: string;
}

export interface ContextBundle {
  bundleId: string;
  findingId: string;
  targetFile: string;
  targetLine: number;
  totalTokensEstimate: number;
  snippets: ContextSnippet[];
  matchedRuleTemplates: string[];
}

/**
 * Context Bundler (Inspired by Alibaba OpenCodeReview)
 * Adheres strictly to DIP (Dependency Inversion Principle) and Ports & Adapters Architecture.
 * Relies on abstract FileSystemPort rather than concrete disk I/O.
 */
export class ContextBundler {
  /**
   * Bundles minimal deterministic context for a specific finding
   */
  public static createBundle(
    fsOrPath: FileSystemPort | string,
    finding: PointerStub,
    options: { radiusLines?: number } = {},
  ): ContextBundle {
    const fsPort: FileSystemPort =
      typeof fsOrPath === 'string' ? new DefaultNodeFileSystemAdapter(fsOrPath) : fsOrPath;

    const radius = options.radiusLines || 15;
    const snippets: ContextSnippet[] = [];
    let totalChars = 0;

    if (fsPort.exists(finding.file)) {
      const fileContent = fsPort.readFile(finding.file);
      const lines = fileContent.split('\n');
      const startLine = Math.max(1, finding.line - radius);
      const endLine = Math.min(lines.length, finding.line + radius);
      const snippetLines = lines.slice(startLine - 1, endLine);
      const content = snippetLines.join('\n');

      totalChars += content.length;
      snippets.push({
        filePath: finding.file,
        role: 'target',
        startLine,
        endLine,
        content,
      });

      // Search for imported types or struct definitions in nearby directory
      if (finding.affectedSymbol) {
        const typeSnippet = this.extractRelatedTypeSnippet(fsPort, finding.file, finding.affectedSymbol);
        if (typeSnippet) {
          totalChars += typeSnippet.content.length;
          snippets.push(typeSnippet);
        }
      }
    }

    const matchedRules: string[] = [];
    if (finding.category === 'lifecycle_leak') {
      matchedRules.push('RULE_NPE_DEFER_CLOSE_ORDER');
      matchedRules.push('RULE_RESOURCE_FINALIZATION');
    } else if (finding.category === 'security_cwe') {
      matchedRules.push('RULE_TAINT_SINK_ESCAPE');
      matchedRules.push('RULE_COMMAND_INJECTION_PARAMETRIZATION');
    }

    return {
      bundleId: `bundle-${finding.id}`,
      findingId: finding.id,
      targetFile: finding.file,
      targetLine: finding.line,
      totalTokensEstimate: Math.ceil(totalChars / 4),
      snippets,
      matchedRuleTemplates: matchedRules,
    };
  }

  private static extractRelatedTypeSnippet(
    fsPort: FileSystemPort,
    currentFile: string,
    symbol: string,
  ): ContextSnippet | null {
    try {
      const dir = path.dirname(currentFile);
      const files = fsPort.readDir(dir);
      for (const f of files) {
        if (f.endsWith('.ts') || f.endsWith('.go') || f.endsWith('.py')) {
          const relCandidate = path.join(dir, f).replace(/\\/g, '/');
          if (relCandidate === currentFile.replace(/\\/g, '/')) continue;

          if (fsPort.exists(relCandidate)) {
            const content = fsPort.readFile(relCandidate);
            if (content.includes(`interface ${symbol}`) || content.includes(`type ${symbol} struct`)) {
              const lines = content.split('\n');
              return {
                filePath: relCandidate,
                role: 'type_definition',
                startLine: 1,
                endLine: Math.min(30, lines.length),
                content: lines.slice(0, 30).join('\n'),
              };
            }
          }
        }
      }
    } catch {
      // Ignored
    }
    return null;
  }
}
