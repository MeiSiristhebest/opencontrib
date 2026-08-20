import * as fs from 'fs';
import * as path from 'path';
import type {
  SmartPointer,
  PointerStoreApi,
  PointerView,
  DefectCategory,
  FindingSeverity,
  PointerSlice,
  PointerEvidence,
} from './contract.js';

export class SmartPointerStore implements PointerStoreApi {
  private memoryMap = new Map<string, SmartPointer>();
  private storageDir?: string;

  constructor(storageDir?: string) {
    this.storageDir = storageDir;
    if (this.storageDir && !fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true });
    }
  }

  public create(params: {
    namespace?: string;
    id: string;
    title: string;
    category: DefectCategory;
    severity: FindingSeverity;
    file: string;
    line: number;
    confidence?: number;
    slice?: PointerSlice;
    evidence?: PointerEvidence;
  }): SmartPointer {
    const namespace = params.namespace || 'findings';
    const cleanId = params.id.replace(/[^a-zA-Z0-9_-]/g, '_');
    const uri = `ptr://${namespace}/${cleanId}`;

    const pointer: SmartPointer = {
      uri,
      namespace,
      id: cleanId,
      createdAt: new Date().toISOString(),
      stub: {
        id: cleanId,
        uri,
        title: params.title,
        category: params.category,
        severity: params.severity,
        file: params.file,
        line: params.line,
        confidence: params.confidence ?? 90,
      },
      slice: params.slice,
      evidence: params.evidence,
    };

    this.memoryMap.set(uri, pointer);
    this.persistToDisk(pointer);
    return pointer;
  }

  public get(uri: string): SmartPointer | undefined {
    const parsedUri = this.normalizeUri(uri);
    return this.memoryMap.get(parsedUri);
  }

  /**
   * 3-Level Progressive Dereferencing
   * Level 1 (stub): ~25 tokens
   * Level 2 (slice): ~150 tokens
   * Level 3 (evidence): full trace and PoC
   */
  public resolve(rawUri: string, defaultView: PointerView = 'slice'): unknown {
    const { uri, view } = this.parseUriWithView(rawUri, defaultView);
    const pointer = this.get(uri);

    if (!pointer) {
      return {
        error: 'POINTER_NOT_FOUND',
        message: `No resource found at pointer URI: ${uri}`,
      };
    }

    switch (view) {
      case 'stub':
        return pointer.stub;
      case 'slice':
        return {
          ...pointer.stub,
          slice: pointer.slice || {
            codeSnippet: `// Source: ${pointer.stub.file}:${pointer.stub.line}`,
            remediationSuggestion: 'Inspect line and surrounding scope.',
          },
        };
      case 'evidence':
        return {
          ...pointer.stub,
          evidence: pointer.evidence || {
            pocCode: '// No explicit PoC code recorded for this finding.',
          },
        };
      case 'all':
      default:
        return pointer;
    }
  }

  public list(namespace?: string): SmartPointer[] {
    const all = Array.from(this.memoryMap.values());
    if (!namespace) return all;
    return all.filter((p) => p.namespace === namespace);
  }

  public clear(): void {
    this.memoryMap.clear();
  }

  private normalizeUri(uri: string): string {
    return uri.split('?')[0].trim();
  }

  private parseUriWithView(rawUri: string, defaultView: PointerView): { uri: string; view: PointerView } {
    const parts = rawUri.split('?');
    const uri = parts[0].trim();
    let view = defaultView;

    if (parts.length > 1) {
      const params = new URLSearchParams(parts[1]);
      const requestedView = params.get('view') as PointerView;
      if (requestedView && ['stub', 'slice', 'evidence', 'all'].includes(requestedView)) {
        view = requestedView;
      }
    }
    return { uri, view };
  }

  private persistToDisk(pointer: SmartPointer): void {
    if (!this.storageDir) return;
    try {
      const filePath = path.join(this.storageDir, `${pointer.namespace}_${pointer.id}.json`);
      fs.writeFileSync(filePath, JSON.stringify(pointer, null, 2), 'utf8');
    } catch {
      // Ignore disk write errors in ephemeral runs
    }
  }
}
