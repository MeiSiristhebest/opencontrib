import * as fs from "fs";
import * as path from "path";
import type {
  SmartPointer,
  PointerStoreApi,
  PointerView,
  PointerCreateOptions,
} from "./contract.js";
import { getOpenContribDataDir } from "./home.js";
import { ActiveSessionManager } from "../run/active-session.js";

export interface PointerStoreLocationOptions {
  runId?: string;
  workspacePath?: string;
  cwd?: string;
  storageDir?: string;
}

/**
 * Resolves the authoritative pointer storage directory.
 * Priority:
 * 1. Explicit storageDir if provided
 * 2. workspacePath/.opencontrib/pointers (if workspacePath provided or active in session)
 * 3. cwd/.opencontrib/pointers (if cwd/.opencontrib exists)
 * 4. global store: <opencontrib_data_dir>/pointers
 */
export function resolvePointerStoreLocation(
  opts: PointerStoreLocationOptions = {},
): string {
  if (opts.storageDir) {
    return opts.storageDir;
  }

  // Check explicit or active session workspace
  let ws = opts.workspacePath;
  if (!ws) {
    try {
      const active = ActiveSessionManager.getActiveSession();
      if (active?.workspacePath && fs.existsSync(active.workspacePath)) {
        ws = active.workspacePath;
      }
    } catch {}
  }

  if (ws && fs.existsSync(ws)) {
    return path.join(ws, ".opencontrib", "pointers");
  }

  // Check local project cwd
  const targetCwd = opts.cwd || process.cwd();
  const localProjectOpenContrib = path.join(targetCwd, ".opencontrib");
  if (fs.existsSync(localProjectOpenContrib)) {
    return path.join(localProjectOpenContrib, "pointers");
  }

  return path.join(getOpenContribDataDir(), "pointers");
}

export type PointerResolveResult =
  | SmartPointer["stub"]
  | (SmartPointer["stub"] & { slice: NonNullable<SmartPointer["slice"]> })
  | (SmartPointer["stub"] & { evidence: NonNullable<SmartPointer["evidence"]> })
  | SmartPointer
  | { error: string; message: string };

export class SmartPointerStore implements PointerStoreApi {
  private memoryMap = new Map<string, SmartPointer>();
  private storageDir: string;
  private idCounters = new Map<string, number>();

  constructor(storageDirOrOpts?: string | PointerStoreLocationOptions) {
    if (typeof storageDirOrOpts === "string") {
      this.storageDir = storageDirOrOpts;
    } else {
      this.storageDir = resolvePointerStoreLocation(storageDirOrOpts || {});
    }
    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch {}
    } else {
      this.hydrateFromDisk();
    }
  }

  public hydrateFromDisk(): void {
    if (!this.storageDir || !fs.existsSync(this.storageDir)) return;
    try {
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (file.endsWith(".json")) {
          const filePath = path.join(this.storageDir, file);
          try {
            const content = fs.readFileSync(filePath, "utf8");
            const pointer = JSON.parse(content) as SmartPointer;
            if (pointer && pointer.uri) {
              this.memoryMap.set(pointer.uri, pointer);
            }
          } catch {}
        }
      }
    } catch {}
  }

  public create(params: PointerCreateOptions): SmartPointer {
    const rawNamespace = params.namespace || "findings";
    const namespace = rawNamespace.replace(/[^a-zA-Z0-9_-]/g, "_");
    const rawId = params.id.replace(/[^a-zA-Z0-9_-]/g, "_");

    // Prevent same-id overwrite: append counter only when duplicate id occurs in same session or file
    const counterKey = `${namespace}:${rawId}`;
    const existingCount = this.idCounters.get(counterKey);
    const counter = existingCount !== undefined && existingCount > 0 ? `_${existingCount}` : "";
    this.idCounters.set(counterKey, (existingCount || 0) + 1);

    const cleanId = `${rawId}${counter}`;
    const uri = `ptr://${namespace}/${cleanId}`;

    const pointer: SmartPointer = {
      uri,
      namespace,
      id: cleanId,
      createdAt: new Date().toISOString(),
      stub: {
        id: cleanId,
        uri,
        title: params.title || "",
        category: params.category || "",
        severity: params.severity || "",
        file: params.file || "",
        line: params.line,
        confidence: params.confidence ?? 90,
        affectedSymbol: params.affectedSymbol,
        callSite: params.callSite,
        dataFlow: params.dataFlow,
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
    if (!this.memoryMap.has(parsedUri)) {
      this.hydrateFromDisk();
    }
    return this.memoryMap.get(parsedUri);
  }

  /**
   * 3-Level Progressive Dereferencing
   * Level 1 (stub): ~25 tokens
   * Level 2 (slice): ~150 tokens
   * Level 3 (evidence): full trace and PoC
   */
  public resolve(
    rawUri: string,
    defaultView: PointerView = "slice",
  ): PointerResolveResult {
    const { uri, view } = this.parseUriWithView(rawUri, defaultView);
    const pointer = this.get(uri);

    if (!pointer) {
      return {
        error: "POINTER_NOT_FOUND",
        message: `No resource found at pointer URI: ${uri}`,
      };
    }

    switch (view) {
      case "stub":
        return pointer.stub;
      case "slice":
        return {
          ...pointer.stub,
          slice: pointer.slice || {
            codeSnippet: `// Source: ${pointer.stub.file}:${pointer.stub.line}`,
            remediationSuggestion: "Inspect line and surrounding scope.",
          },
        };
      case "evidence":
        return {
          ...pointer.stub,
          evidence: pointer.evidence || {
            pocCode: "// No explicit PoC code recorded for this finding.",
          },
        };
      case "all":
      default:
        return pointer;
    }
  }

  public list(namespace?: string): SmartPointer[] {
    this.hydrateFromDisk();
    const all = Array.from(this.memoryMap.values());
    if (!namespace) return all;
    return all.filter((p) => p.namespace === namespace);
  }

  public clear(): void {
    this.memoryMap.clear();
  }

  private normalizeUri(uri: string): string {
    return uri.split("?")[0].trim();
  }

  private parseUriWithView(
    rawUri: string,
    defaultView: PointerView,
  ): { uri: string; view: PointerView } {
    const parts = rawUri.split("?");
    const uri = parts[0].trim();
    let view = defaultView;

    if (parts.length > 1) {
      const params = new URLSearchParams(parts[1]);
      const requestedView = params.get("view") as PointerView;
      if (
        requestedView &&
        ["stub", "slice", "evidence", "all"].includes(requestedView)
      ) {
        view = requestedView;
      }
    }
    return { uri, view };
  }

  private persistToDisk(pointer: SmartPointer): void {
    if (!this.storageDir) return;
    try {
      const filePath = path.join(
        this.storageDir,
        `${pointer.namespace}_${pointer.id}.json`,
      );
      fs.writeFileSync(filePath, JSON.stringify(pointer, null, 2), "utf8");
    } catch {
      // Ignore disk write errors in ephemeral runs
    }
  }
}
