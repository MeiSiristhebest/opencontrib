import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
  /** Stable repository/workspace scope used by content-addressed IDs. */
  scope?: string;
}

/**
 * Resolve the one pointer store used by CLI, MCP, and core callers.
 * Explicit storage wins, followed by a run-owned store, an explicit workspace,
 * an existing project-local store, and finally the canonical global data dir.
 */
export function resolvePointerStoreLocation(
  opts: PointerStoreLocationOptions = {},
): string {
  if (opts.storageDir) return path.resolve(opts.storageDir);

  if (opts.runId && /^[a-zA-Z0-9_-]+$/.test(opts.runId)) {
    return path.join(getOpenContribDataDir(), "runs", opts.runId, "pointers");
  }

  let ws = opts.workspacePath;
  if (!ws) {
    try {
      const active = ActiveSessionManager.getActiveSession();
      if (active?.workspacePath && fs.existsSync(active.workspacePath)) {
        ws = active.workspacePath;
      }
    } catch {
      // A missing/corrupt active session must not prevent global pointer use.
    }
  }

  if (ws) return path.join(path.resolve(ws), ".opencontrib", "pointers");

  const targetCwd = path.resolve(opts.cwd || process.cwd());
  const localProjectOpenContrib = path.join(targetCwd, ".opencontrib");
  if (fs.existsSync(localProjectOpenContrib)) {
    return path.join(localProjectOpenContrib, "pointers");
  }

  return path.join(getOpenContribDataDir(), "pointers");
}

export type PointerResolveResult =
  | SmartPointer["stub"]
  | (SmartPointer["stub"] & { slice: NonNullable<SmartPointer["slice"]> })
  | (SmartPointer["stub"] & {
      evidence: NonNullable<SmartPointer["evidence"]>;
    })
  | SmartPointer
  | { error: string; message: string };

const POINTER_VERSION = "v2";

function sanitizeNamespace(namespace: string): string {
  return namespace.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function sanitizeLegacyId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeFilePath(file: string, scope: string): string {
  const normalized = file.replace(/\\/g, "/").trim();
  if (!normalized) return "";
  const absolute = path.resolve(scope, normalized);
  const relative = path.relative(scope, absolute).replace(/\\/g, "/");
  return relative && !relative.startsWith("../") && relative !== ".."
    ? relative
    : path.posix.normalize(normalized).replace(/^\.\//, "");
}

/** Deterministic recursively key-sorted JSON used for pointer identity. */
type CanonicalJsonValue =
  | string
  | number
  | boolean
  | null
  | CanonicalJsonValue[]
  | { [key: string]: CanonicalJsonValue };

function canonicalize(value: unknown): CanonicalJsonValue | undefined {
  if (value === undefined) return undefined;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalize(entry) ?? null);
  }
  const record = value as Record<string, unknown>;
  const sorted: { [key: string]: CanonicalJsonValue } = {};
  for (const key of Object.keys(record).sort()) {
    const entry = canonicalize(record[key]);
    if (entry !== undefined) sorted[key] = entry;
  }
  return sorted;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value)) ?? "";
}

function pointerIntegrityError(message: string): Error {
  return new Error(`PointerStoreIntegrityError: ${message}`);
}

function looksLikeV2Pointer(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const pointer = value as Record<string, unknown>;
  return (
    (typeof pointer.id === "string" &&
      pointer.id.startsWith(`${POINTER_VERSION}-`)) ||
    (typeof pointer.uri === "string" &&
      pointer.uri.includes(`/${POINTER_VERSION}-`))
  );
}

/**
 * Recompute a v2 pointer identity from the persisted semantic fields.  The
 * storage filename and URI are not trusted as an identity: both are checked
 * against the recomputed digest so a cross-process hydrator cannot accept a
 * colliding, renamed, or partially tampered pointer.
 */
function validateV2Pointer(
  value: unknown,
  expectedNamespace?: string,
  expectedId?: string,
  expectedScope?: string,
): SmartPointer {
  if (!value || typeof value !== "object") {
    throw pointerIntegrityError("persisted pointer is not an object.");
  }
  const pointer = value as Partial<SmartPointer>;
  const stub = pointer.stub as Partial<SmartPointer["stub"]> | undefined;
  if (
    typeof pointer.id !== "string" ||
    !/^v2-[0-9a-f]{64}$/.test(pointer.id) ||
    typeof pointer.namespace !== "string" ||
    pointer.namespace !== sanitizeNamespace(pointer.namespace) ||
    typeof pointer.uri !== "string" ||
    typeof pointer.legacyId !== "string" ||
    typeof pointer.scope !== "string" ||
    !pointer.scope.trim() ||
    pointer.scope !== path.resolve(pointer.scope) ||
    typeof pointer.createdAt !== "string" ||
    !stub
  ) {
    throw pointerIntegrityError("persisted v2 pointer has an invalid shape.");
  }
  if (
    expectedNamespace !== undefined &&
    pointer.namespace !== expectedNamespace
  ) {
    throw pointerIntegrityError(
      `pointer namespace '${pointer.namespace}' does not match storage namespace '${expectedNamespace}'.`,
    );
  }
  if (expectedId !== undefined && pointer.id !== expectedId) {
    throw pointerIntegrityError(
      `pointer id '${pointer.id}' does not match storage id '${expectedId}'.`,
    );
  }
  if (
    expectedScope !== undefined &&
    pointer.scope !== path.resolve(expectedScope)
  ) {
    throw pointerIntegrityError(
      `pointer scope '${pointer.scope}' does not match store scope '${path.resolve(expectedScope)}'.`,
    );
  }

  const expectedUri = `ptr://${pointer.namespace}/${pointer.id}`;
  if (pointer.uri !== expectedUri || stub.uri !== expectedUri) {
    throw pointerIntegrityError(
      "persisted pointer URI does not match its v2 identity.",
    );
  }
  if (
    stub.id !== pointer.id ||
    stub.legacyId !== pointer.legacyId ||
    stub.namespace !== pointer.namespace ||
    stub.file !== normalizeFilePath(String(stub.file ?? ""), pointer.scope)
  ) {
    throw pointerIntegrityError(
      "persisted pointer stub is inconsistent with its identity.",
    );
  }
  const expectedLegacyUri = `ptr://${pointer.namespace}/${sanitizeLegacyId(
    pointer.legacyId,
  )}`;
  if (pointer.legacyUri !== expectedLegacyUri) {
    throw pointerIntegrityError(
      "persisted pointer legacy URI is inconsistent.",
    );
  }

  const identity = {
    version: POINTER_VERSION,
    namespace: pointer.namespace,
    producerId: pointer.legacyId,
    scope: path.resolve(pointer.scope),
    file: normalizeFilePath(String(stub.file ?? ""), pointer.scope),
    line: stub.line,
    title: stub.title || "",
    category: stub.category || "",
    severity: stub.severity || "",
    confidence: stub.confidence ?? 90,
    affectedSymbol: stub.affectedSymbol,
    callSite: stub.callSite,
    dataFlow: stub.dataFlow,
    slice: pointer.slice,
    evidence: pointer.evidence,
  };
  const expectedDigest = createHash("sha256")
    .update(canonicalJson(identity), "utf8")
    .digest("hex");
  const expectedContentId = `${POINTER_VERSION}-${expectedDigest}`;
  if (pointer.id !== expectedContentId) {
    throw pointerIntegrityError(
      `persisted pointer content does not match id '${pointer.id}'.`,
    );
  }
  return pointer as SmartPointer;
}

function validatePersistedPointer(
  value: unknown,
  expectedNamespace?: string,
  expectedId?: string,
  expectedScope?: string,
): SmartPointer {
  if (
    expectedId?.startsWith(`${POINTER_VERSION}-`) &&
    !looksLikeV2Pointer(value)
  ) {
    throw pointerIntegrityError(
      `storage entry for v2 id '${expectedId}' is not a v2 pointer.`,
    );
  }
  if (looksLikeV2Pointer(value)) {
    return validateV2Pointer(
      value,
      expectedNamespace,
      expectedId,
      expectedScope,
    );
  }
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as Partial<SmartPointer>).uri !== "string"
  ) {
    throw pointerIntegrityError("persisted pointer is missing a URI.");
  }
  // Pre-v2 files remain readable for migration. They are not content-addressed
  // and therefore cannot be validated against the v2 identity contract.
  return value as SmartPointer;
}

export class SmartPointerStore implements PointerStoreApi {
  private readonly memoryMap = new Map<string, SmartPointer>();
  private readonly aliases = new Map<string, SmartPointer>();
  private readonly storageDir: string;
  private readonly scope: string;

  constructor(storageDirOrOpts?: string | PointerStoreLocationOptions) {
    const options =
      typeof storageDirOrOpts === "string"
        ? { storageDir: storageDirOrOpts }
        : storageDirOrOpts || {};
    this.storageDir = resolvePointerStoreLocation(options);
    this.scope = path.resolve(
      options.scope || options.workspacePath || path.dirname(this.storageDir),
    );
    if (!fs.existsSync(this.storageDir)) {
      try {
        fs.mkdirSync(this.storageDir, { recursive: true });
      } catch {
        // Ephemeral callers can still use the in-memory portion of the store.
      }
    } else {
      this.hydrateFromDisk();
    }
  }

  public hydrateFromDisk(): void {
    if (!this.storageDir || !fs.existsSync(this.storageDir)) return;
    try {
      const files = fs.readdirSync(this.storageDir);
      for (const file of files) {
        if (!file.endsWith(".json") || file.startsWith(".")) continue;
        const filePath = path.join(this.storageDir, file);
        try {
          const content = fs.readFileSync(filePath, "utf8");
          const parsed = JSON.parse(content);
          let expectedNamespace: string | undefined;
          let expectedId: string | undefined;
          if (looksLikeV2Pointer(parsed)) {
            const match = /^(.*)_(v2-[0-9a-f]{64})$/.exec(
              file.slice(0, -5),
            );
            if (!match) {
              throw pointerIntegrityError(
                `v2 pointer file '${file}' does not use the canonical namespace_id filename.`,
              );
            }
            expectedNamespace = match[1];
            expectedId = match[2];
          }
          const pointer = validatePersistedPointer(
            parsed,
            expectedNamespace,
            expectedId,
            this.scope,
          );
          this.registerPointer(pointer);
        } catch (error) {
          if (
            error instanceof Error &&
            error.message.startsWith("PointerStoreIntegrityError:")
          ) {
            throw error;
          }
          // Ignore unrelated/corrupt legacy files during discovery; a direct
          // lookup of a corrupt pointer remains a not-found result.
        }
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message.startsWith("PointerStoreIntegrityError:")
      ) {
        throw error;
      }
      // Best effort hydration for an ephemeral store.
    }
  }

  public create(params: PointerCreateOptions): SmartPointer {
    const rawNamespace = params.namespace || "findings";
    const namespace = sanitizeNamespace(rawNamespace);
    const identity = {
      version: POINTER_VERSION,
      namespace,
      producerId: params.id,
      scope: this.scope,
      file: normalizeFilePath(params.file, this.scope),
      line: params.line,
      title: params.title || "",
      category: params.category || "",
      severity: params.severity || "",
      confidence: params.confidence ?? 90,
      affectedSymbol: params.affectedSymbol,
      callSite: params.callSite,
      dataFlow: params.dataFlow,
      slice: params.slice,
      evidence: params.evidence,
    };
    const digest = createHash("sha256")
      .update(canonicalJson(identity), "utf8")
      .digest("hex");
    const cleanId = `${POINTER_VERSION}-${digest}`;
    const uri = `ptr://${namespace}/${cleanId}`;

    const inMemory = this.memoryMap.get(uri);
    if (inMemory) return inMemory;
    const onDisk = this.readPointerFile(namespace, cleanId);
    if (onDisk) {
      this.registerPointer(onDisk);
      return onDisk;
    }

    const legacyUri = `ptr://${namespace}/${sanitizeLegacyId(params.id)}`;
    const pointer: SmartPointer = {
      uri,
      legacyUri,
      namespace,
      id: cleanId,
      legacyId: params.id,
      scope: this.scope,
      createdAt: new Date().toISOString(),
      stub: {
        id: cleanId,
        legacyId: params.id,
        uri,
        namespace,
        title: params.title || "",
        category: params.category || "",
        severity: params.severity || "",
        file: normalizeFilePath(params.file, this.scope),
        line: params.line,
        confidence: params.confidence ?? 90,
        affectedSymbol: params.affectedSymbol,
        callSite: params.callSite,
        dataFlow: params.dataFlow,
        slice: undefined,
        evidence: undefined,
      },
      slice: params.slice,
      evidence: params.evidence,
    };

    const persisted = this.persistToDisk(pointer);
    this.registerPointer(persisted);
    return persisted;
  }

  public get(uri: string): SmartPointer | undefined {
    const parsedUri = this.normalizeUri(uri);
    const inMemory =
      this.memoryMap.get(parsedUri) || this.aliases.get(parsedUri);
    if (inMemory) return inMemory;
    this.hydrateFromDisk();
    return this.memoryMap.get(parsedUri) || this.aliases.get(parsedUri);
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
    return all.filter((pointer) => pointer.namespace === namespace);
  }

  public clear(): void {
    this.memoryMap.clear();
    this.aliases.clear();
  }

  private registerPointer(pointer: SmartPointer): void {
    const trustedPointer = looksLikeV2Pointer(pointer)
      ? validateV2Pointer(pointer, undefined, undefined, this.scope)
      : pointer;
    this.memoryMap.set(trustedPointer.uri, trustedPointer);
    if (trustedPointer.legacyUri)
      this.aliases.set(trustedPointer.legacyUri, trustedPointer);
    if (trustedPointer.legacyId) {
      this.aliases.set(
        `ptr://${trustedPointer.namespace}/${sanitizeLegacyId(trustedPointer.legacyId)}`,
        trustedPointer,
      );
      this.aliases.set(
        `ptr://${trustedPointer.namespace}/${trustedPointer.legacyId}`,
        trustedPointer,
      );
    }
    // Pre-v2 files have no legacyId but their primary URI is itself the alias.
    if (!trustedPointer.id.startsWith(`${POINTER_VERSION}-`)) {
      this.aliases.set(trustedPointer.uri, trustedPointer);
    }
  }

  private readPointerFile(
    namespace: string,
    id: string,
  ): SmartPointer | undefined {
    const filePath = path.join(this.storageDir, `${namespace}_${id}.json`);
    try {
      if (!fs.existsSync(filePath)) return undefined;
      const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
      return validatePersistedPointer(parsed, namespace, id, this.scope);
    } catch (error) {
      throw new Error(
        `PointerStoreReadError: unable to read content-addressed pointer ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
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

  /**
   * Exclusive, complete-file publication makes same-content creates
   * idempotent across independent processes.  A temporary file is fully
   * written and fsynced before an exclusive hard-link publishes it; no
   * hydrator can observe a partially written pointer at the canonical path.
   */
  private persistToDisk(pointer: SmartPointer): SmartPointer {
    if (!this.storageDir) return pointer;
    const filePath = path.join(
      this.storageDir,
      `${pointer.namespace}_${pointer.id}.json`,
    );
    const tempPath = `${filePath}.${process.pid}.${Math.random()
      .toString(36)
      .slice(2, 10)}.tmp`;
    try {
      fs.mkdirSync(this.storageDir, { recursive: true });
      const fd = fs.openSync(tempPath, "wx");
      try {
        fs.writeFileSync(fd, JSON.stringify(pointer, null, 2), "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        fs.linkSync(tempPath, filePath);
      } catch (error: any) {
        if (error?.code !== "EEXIST") throw error;
        const existing = this.readPointerFile(pointer.namespace, pointer.id);
        if (!existing) {
          throw new Error(
            `PointerStoreWriteError: pointer file ${filePath} exists but cannot be read.`,
          );
        }
        return existing;
      } finally {
        try {
          fs.unlinkSync(tempPath);
        } catch {
          // The canonical file is already published; stale temp cleanup is
          // best effort and never changes the returned pointer.
        }
      }
      return pointer;
    } catch (error: any) {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch {
        // Best effort cleanup only.
      }
      if (
        error instanceof Error &&
        error.message.startsWith("PointerStoreWriteError:")
      ) {
        throw error;
      }
      throw new Error(
        `PointerStoreWriteError: unable to persist ${pointer.uri}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
