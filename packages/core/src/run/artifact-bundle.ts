import { randomUUID } from "crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join, resolve, sep } from "path";

import type {
  ArtifactType,
  ContributionRunManifest,
  ContributionRunPhase,
  ContributionRunSummary,
  RunEvent,
  SavedArtifactResult,
} from "./types.js";
import { getOpenContribDataDir } from "../kernel/home.js";

const WRITE_ONCE_ARTIFACT_TYPES = new Set<ArtifactType>([
  "workspace",
  "validated_patch",
  "evidence_red",
  "evidence",
  "issue_binding",
  "security_disclosure",
  "governance",
  "submission_intent",
  "approval",
  "submission",
  "result",
]);

export function writeAtomic(filePath: string, content: string): void {
  const dir = dirname(filePath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tempPath = join(
    dir,
    `.${basename(filePath)}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`,
  );
  writeFileSync(tempPath, content, "utf-8");
  renameSync(tempPath, filePath);
}

export function sanitizeRunId(runId: string): string {
  if (!runId || typeof runId !== "string") return "";
  return runId.replace(/[^a-zA-Z0-9_-]/g, "");
}

export function validateRunId(runId: string, baseDir: string): string {
  if (!runId || typeof runId !== "string") {
    throw new Error("Invalid runId: must be a non-empty string.");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(runId)) {
    throw new Error(
      `Security error: Invalid runId "${runId}". Only alphanumeric characters, hyphens, and underscores are allowed (path traversal protection).`,
    );
  }
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(join(baseDir, runId));
  if (
    !resolvedTarget.startsWith(resolvedBase + sep) &&
    resolvedTarget !== resolvedBase
  ) {
    throw new Error(
      `Security error: Run ID "${runId}" traverses outside base directory boundary.`,
    );
  }
  return runId;
}

export class ArtifactBundleManager {
  private baseDir: string;

  constructor(customBaseDir?: string) {
    this.baseDir = customBaseDir || join(getOpenContribDataDir(), "runs");
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }
  }

  getBaseDir(): string {
    return this.baseDir;
  }

  getRunDir(runId: string): string {
    validateRunId(runId, this.baseDir);
    return join(this.baseDir, runId);
  }

  ensureRunDir(runId: string): string {
    const dir = this.getRunDir(runId);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getArtifactFilename(type: ArtifactType): string {
    switch (type) {
      case "opportunity":
        return "opportunity.json";
      case "context":
        return "context.json";
      case "workspace":
        return "workspace.json";
      case "patch":
        return "patch.diff";
      case "validated_patch":
        return "validated_patch.json";
      case "evidence_red":
        return "evidence_red.json";
      case "evidence":
        return "evidence.json";
      case "governance":
        return "governance.json";
      case "submission_intent":
        return "submission_intent.json";
      case "approval":
        return "approval.json";
      case "submission":
        return "submission.json";
      case "security_disclosure_event":
        return "security_disclosure_event.json";
      case "pr_draft":
        return "pr_draft.md";
      case "result":
        return "result.json";
      default:
        return `${type}.json`;
    }
  }

  saveArtifact(
    runId: string,
    type: ArtifactType,
    content: string | Record<string, unknown>,
  ): SavedArtifactResult {
    const runDir = this.ensureRunDir(runId);
    if (type === "patch_attempt" || type === "security_disclosure_event") {
      const pattern =
        type === "patch_attempt"
          ? /^patch_attempt_(\d+)\.json$/
          : /^security_disclosure_event_(\d+)\.json$/;
      const nextIndex =
        readdirSync(runDir)
          .map((name) => pattern.exec(name)?.[1])
          .filter((value): value is string => value !== undefined)
          .reduce((max, value) => Math.max(max, Number(value)), 0) + 1;
      const prefix =
        type === "patch_attempt" ? "patch_attempt" : "security_disclosure_event";
      const filename = `${prefix}_${String(nextIndex).padStart(4, "0")}.json`;
      const filePath = join(runDir, filename);
      const stringContent =
        typeof content === "string" ? content : JSON.stringify(content, null, 2);
      writeAtomic(filePath, stringContent);
      return {
        runId,
        artifactType: type,
        filePath,
        savedAt: new Date().toISOString(),
        byteSize: Buffer.byteLength(stringContent, "utf-8"),
      };
    }

    const filename = this.getArtifactFilename(type);
    const filePath = join(runDir, filename);

    const stringContent =
      typeof content === "string" ? content : JSON.stringify(content, null, 2);

    // Authoritative artifacts are write-once. Evidence is the one exception:
    // its RED portion is immutable while the canonical service may attach the
    // later GREEN/report fields. Raw patch and PR draft artifacts remain drafts;
    // the immutable validated_patch artifact seals what GREEN actually verified.
    if (
      existsSync(filePath) &&
      (type === "evidence" || WRITE_ONCE_ARTIFACT_TYPES.has(type))
    ) {
      const existingRaw = readFileSync(filePath, "utf-8");
      let existingValue: unknown;
      let nextValue: unknown;
      let isJson = true;
      try {
        existingValue = JSON.parse(existingRaw);
        nextValue = JSON.parse(stringContent);
      } catch {
        isJson = false;
      }

      if (type === "evidence" && isJson) {
        const existingRed = (existingValue as any)?.redEvidence;
        const nextRed = (nextValue as any)?.redEvidence;
        if (
          existingRed &&
          (!nextRed || JSON.stringify(existingRed) !== JSON.stringify(nextRed))
        ) {
          throw new Error(
            `ImmutableArtifactViolationError: RED baseline in evidence is write-once and cannot be mutated or deleted.`,
          );
        }
      } else if (WRITE_ONCE_ARTIFACT_TYPES.has(type)) {
        const hasMutated = isJson
          ? JSON.stringify(existingValue) !== JSON.stringify(nextValue)
          : existingRaw !== stringContent;
        if (hasMutated) {
          throw new Error(
            `ImmutableArtifactViolationError: Authoritative artifact '${type}' is write-once and cannot be mutated.`,
          );
        }
      }
    }

    writeAtomic(filePath, stringContent);

    return {
      runId,
      artifactType: type,
      filePath,
      savedAt: new Date().toISOString(),
      byteSize: Buffer.byteLength(stringContent, "utf-8"),
    };
  }

  readArtifact<T = unknown>(runId: string, type: ArtifactType): T | null {
    const runDir = this.getRunDir(runId);
    let filePath: string;
    if (type === "patch_attempt" || type === "security_disclosure_event") {
      const pattern =
        type === "patch_attempt"
          ? /^patch_attempt_\d+\.json$/
          : /^security_disclosure_event_\d+\.json$/;
      const latest = readdirSync(runDir)
        .filter((name) => pattern.test(name))
        .sort()
        .pop();
      if (!latest) return null;
      filePath = join(runDir, latest);
    } else {
      const filename = this.getArtifactFilename(type);
      filePath = join(runDir, filename);
    }

    if (!existsSync(filePath)) {
      return null;
    }

    const content = readFileSync(filePath, "utf-8");
    if (type === "patch" || type === "pr_draft") {
      // SAFETY: Raw patch and pr_draft artifacts are stored as plain UTF-8
      // text strings; caller requested string-compatible T.
      return content as unknown as T;
    }

    try {
      return JSON.parse(content) as T;
    } catch (err: any) {
      console.warn(
        `[ArtifactBundle] Failed to parse artifact ${type} for run ${runId}: ${err.message}`,
      );
      // SAFETY: Fallback returns raw string content when JSON parse fails.
      return content as unknown as T;
    }
  }

  saveManifest(manifest: ContributionRunManifest): void {
    const runDir = this.ensureRunDir(manifest.runId);
    const manifestPath = join(runDir, "manifest.json");
    writeAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  }

  readManifest(runId: string): ContributionRunManifest | null {
    const runDir = this.getRunDir(runId);
    const manifestPath = join(runDir, "manifest.json");
    if (!existsSync(manifestPath)) {
      return null;
    }
    try {
      return JSON.parse(
        readFileSync(manifestPath, "utf-8"),
      ) as ContributionRunManifest;
    } catch {
      return null;
    }
  }

  appendEvent(
    runId: string,
    event: Omit<RunEvent, "runId" | "timestamp" | "eventId">,
  ): RunEvent {
    const runDir = this.ensureRunDir(runId);
    const eventsPath = join(runDir, "events.jsonl");
    const timelogPath = join(runDir, "timelog.md");
    const now = new Date().toISOString();

    const fullEvent: RunEvent = {
      eventId: randomUUID(),
      runId,
      timestamp: now,
      ...event,
    };
    const eventLine = JSON.stringify(fullEvent) + "\n";
    const tmpEventsPath = eventsPath + ".tmp";
    try {
      writeFileSync(tmpEventsPath, eventLine, "utf-8");
      if (existsSync(eventsPath)) {
        appendFileSync(eventsPath, readFileSync(tmpEventsPath, "utf-8"));
      } else {
        renameSync(tmpEventsPath, eventsPath);
      }
    } catch {
      try {
        unlinkSync(tmpEventsPath);
      } catch {}
      throw new Error(`Failed to append event to ${eventsPath}`);
    }

    // Automatically maintain human-readable timelog.md
    if (!existsSync(timelogPath)) {
      writeFileSync(
        timelogPath,
        `# Contribution Run Timelog: ${runId}\n\n| Timestamp | Phase | Event Type | Details |\n| :--- | :--- | :--- | :--- |\n`,
        "utf-8",
      );
    }
    const details = event.payload
      ? JSON.stringify(event.payload).replace(/\|/g, "\\|")
      : "-";
    appendFileSync(
      timelogPath,
      `| \`${now}\` | **${event.phase}** | \`${event.eventType}\` | ${details} |\n`,
      "utf-8",
    );

    return fullEvent;
  }

  readEvents(runId: string): RunEvent[] {
    const runDir = this.getRunDir(runId);
    const eventsPath = join(runDir, "events.jsonl");
    if (!existsSync(eventsPath)) {
      return [];
    }
    try {
      const lines = readFileSync(eventsPath, "utf-8")
        .trim()
        .split("\n")
        .filter(Boolean);
      const events: RunEvent[] = [];
      const errors: string[] = [];
      for (const [idx, l] of lines.entries()) {
        try {
          events.push(JSON.parse(l) as RunEvent);
        } catch (err: any) {
          errors.push(`Line ${idx + 1}: ${err.message}`);
        }
      }
      if (errors.length > 0) {
        console.warn(
          `[ArtifactBundle] Warning: ${errors.length} corrupted event line(s) skipped: ${errors.join("; ")}`,
        );
      }
      return events;
    } catch {
      return [];
    }
  }

  listArtifactFiles(runId: string): string[] {
    const runDir = this.getRunDir(runId);
    if (!existsSync(runDir)) {
      return [];
    }
    return readdirSync(runDir);
  }

  getRunSummary(runId: string): ContributionRunSummary | null {
    const manifest = this.readManifest(runId);
    if (!manifest) {
      return null;
    }

    return {
      manifest,
      artifacts: {
        opportunity: this.readArtifact(runId, "opportunity") ?? undefined,
        probe: this.readArtifact(runId, "probe") ?? undefined,
        context: this.readArtifact(runId, "context") ?? undefined,
        workspace: this.readArtifact(runId, "workspace") ?? undefined,
        poc: this.readArtifact(runId, "poc") ?? undefined,
        patch: this.readArtifact(runId, "patch") ?? undefined,
        validatedPatch:
          this.readArtifact(runId, "validated_patch") ?? undefined,
        patchAttempt: this.readArtifact(runId, "patch_attempt") ?? undefined,
        patchAttempts: this.readPatchAttempts(runId),
        issueBinding: this.readArtifact(runId, "issue_binding") ?? undefined,
        securityDisclosure:
          this.readArtifact(runId, "security_disclosure") ?? undefined,
        securityDisclosureEvents: this.readSecurityDisclosureEvents(runId),
        evidenceRed: this.readArtifact(runId, "evidence_red") ?? undefined,
        evidence: this.readArtifact(runId, "evidence") ?? undefined,
        governance: this.readArtifact(runId, "governance") ?? undefined,
        submissionIntent:
          this.readArtifact(runId, "submission_intent") ?? undefined,
        approval: this.readArtifact(runId, "approval") ?? undefined,
        submission: this.readArtifact(runId, "submission") ?? undefined,
        prDraft: this.readArtifact(runId, "pr_draft") ?? undefined,
        result: this.readArtifact(runId, "result") ?? undefined,
      },
      events: this.readEvents(runId),
      availableArtifactFiles: this.listArtifactFiles(runId),
    };
  }

  private readPatchAttempts(runId: string): Record<string, unknown>[] {
    const runDir = this.getRunDir(runId);
    return readdirSync(runDir)
      .filter((name) => /^patch_attempt_\d+\.json$/.test(name))
      .sort()
      .flatMap((name) => {
        try {
          const value = JSON.parse(readFileSync(join(runDir, name), "utf-8"));
          return value && typeof value === "object"
            ? [value as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  }

  private readSecurityDisclosureEvents(runId: string): Record<string, unknown>[] {
    const runDir = this.getRunDir(runId);
    if (!existsSync(runDir)) return [];
    return readdirSync(runDir)
      .filter((name) => /^security_disclosure_event_\d+\.json$/.test(name))
      .sort()
      .flatMap((name) => {
        try {
          const value = JSON.parse(readFileSync(join(runDir, name), "utf-8"));
          return value && typeof value === "object"
            ? [value as Record<string, unknown>]
            : [];
        } catch {
          return [];
        }
      });
  }
}
