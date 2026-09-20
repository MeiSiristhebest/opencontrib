import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import type { ContributionRunManager } from "../run/run-manager.js";
import { saveCanonicalArtifact } from "../run/canonical-writer.js";
import {
  AuthoritativeRedEvidenceSchema,
  TrustedGreenExecutionResultSchema,
  EvidenceReportSchema,
  TrustedRedExecutionResultSchema,
  ValidatedPatchArtifactSchema,
  type EvidenceReport,
  type RedEvidence,
  type TestIdentity,
  type ValidatedPatchArtifact,
  type ValidatedPatchFile,
} from "../contracts/schemas.js";
import {
  captureRedEvidence,
  collectEvidence,
  computeSourceTreeHash,
  computeTestIdentity,
  computeTestFileDiffSha256,
  computeTestIdentityFingerprint,
  matchExpectedFailure,
  validateExpectedFailurePattern,
} from "./evidence-collector.js";
import { isSafeRepositoryPath } from "../submission/submission-intent-service.js";
import { hashValidatedPatchArtifact } from "./validated-patch.js";
import type { TestCoverageAdapter } from "./coverage-adapter.js";
import type {
  RawRedExecutionResult,
  RedExecutionJob,
} from "../run/trusted-execution.port.js";
import { validateStressDimensions } from "../contracts/stress.js";

export type RedExecutionContract = Pick<
  RedExecutionJob,
  "testCommand" | "expectedAssertion" | "testFiles"
>;

export interface CaptureRedInput {
  runId: string;
  cwd?: string;
  testCommand: string;
  expectedAssertion?: string;
  testFile?: string | string[];
  testFileSha256?: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
}

export interface VerifyGreenInput {
  runId: string;
  cwd?: string;
  testCommand: string;
  workspaceRoot?: string;
  baselineCommitSha?: string;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
  /**
   * Optional generic coverage adapter: resolves a 0-100 coverage percent
   * from a runner-produced artifact after GREEN. Absent => coverage stays
   * explicitly UNAVAILABLE (the governance gate never sees invented data).
   */
  coverageAdapter?: TestCoverageAdapter;
}

export interface PorcelainV1Record {
  status: string;
  path: string;
  originalPath?: string;
}

/** Parse `git status --porcelain=v1 -z` without trimming path/status bytes. */
export function parsePorcelainV1Z(
  output: string | Buffer,
): PorcelainV1Record[] {
  const tokens = output.toString("utf8").split("\0");
  const records: PorcelainV1Record[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    if (token.length < 4 || token[2] !== " ") {
      throw new Error(
        "EvidencePatchProvenanceError: malformed git porcelain status output.",
      );
    }
    const status = token.slice(0, 2);
    const firstPath = token.slice(3);
    if (!firstPath) {
      throw new Error(
        "EvidencePatchProvenanceError: git status returned an empty path.",
      );
    }
    if (status.includes("R") || status.includes("C")) {
      const nextPath = tokens[++index];
      if (!nextPath) {
        throw new Error(
          "EvidencePatchProvenanceError: git rename/copy status is missing its destination path.",
        );
      }
      records.push({ status, path: nextPath, originalPath: firstPath });
    } else {
      records.push({ status, path: firstPath });
    }
  }
  return records;
}

interface DeltaFile {
  path: string;
  operation: "CREATE" | "MODIFY" | "DELETE";
  mode: "100644" | "100755" | "120000";
  contentSha256: string;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function gitOutput(cwd: string, args: string[], operation: string): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err: any) {
    const detail = typeof err?.stderr === "string" ? err.stderr.trim() : "";
    throw new Error(
      `EvidencePatchProvenanceError: unable to ${operation}${detail ? ` (${detail})` : ""}.`,
    );
  }
}

function requireBaseCommitSha(value: unknown, runId: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      `EvidencePatchProvenanceError: run ${runId} has no canonical workspace baseCommitSha.`,
    );
  }
  return value.trim();
}

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

function sameTestIdentity(left: TestIdentity, right: TestIdentity): boolean {
  return (
    left.normalizedCommand === right.normalizedCommand &&
    left.expectedAssertion === right.expectedAssertion &&
    left.identitySha256 === right.identitySha256 &&
    JSON.stringify(left.testFiles) === JSON.stringify(right.testFiles)
  );
}

function schemaIssueSummary(error: {
  issues: Array<{ path: (string | number)[]; message: string }>;
}): string {
  return error.issues
    .map((issue) => `${issue.path.join(".") || "result"}: ${issue.message}`)
    .join("; ");
}

function requireRawRedResult(
  rawResult: RawRedExecutionResult,
  runId: string,
): import("../contracts/schemas.js").TrustedRedExecutionResult {
  const parsed = TrustedRedExecutionResultSchema.safeParse(rawResult);
  if (!parsed.success) {
    throw new Error(
      `RedExecutionValidationError: worker RED result for run ${runId} is invalid: ${schemaIssueSummary(parsed.error)}.`,
    );
  }
  return parsed.data;
}

function requireRedContract(
  contract: RedExecutionContract,
  runId: string,
): RedExecutionContract {
  if (
    !contract ||
    typeof contract.testCommand !== "string" ||
    !contract.testCommand.trim() ||
    typeof contract.expectedAssertion !== "string" ||
    !contract.expectedAssertion.trim() ||
    !Array.isArray(contract.testFiles) ||
    contract.testFiles.length === 0 ||
    contract.testFiles.some(
      (file) => typeof file !== "string" || !isSafeRepositoryPath(file.trim()),
    )
  ) {
    throw new Error(
      `RedExecutionValidationError: trusted RED contract for run ${runId} must bind a command, assertion, and safe concrete test files.`,
    );
  }
  validateExpectedFailurePattern(contract.expectedAssertion);
  return {
    testCommand: contract.testCommand,
    expectedAssertion: contract.expectedAssertion.trim(),
    testFiles: contract.testFiles.map((file) => file.trim()),
  };
}

function requireAuthoritativeSourceHash(
  workspacePath: string,
  rawSourceTreeSha256: string,
  runId: string,
): string {
  const hostSourceTreeSha256 = computeSourceTreeHash(workspacePath);
  if (!/^[0-9a-f]{64}$/i.test(hostSourceTreeSha256)) {
    throw new Error(
      `RedExecutionValidationError: host could not compute a valid workspace tree hash for run ${runId}.`,
    );
  }
  if (
    rawSourceTreeSha256.toLowerCase() !== hostSourceTreeSha256.toLowerCase()
  ) {
    throw new Error(
      `RedExecutionValidationError: worker RED tree hash does not match the host-recomputed workspace hash for run ${runId}.`,
    );
  }
  return hostSourceTreeSha256;
}

function requireAuthoritativeOutput(
  rawResult: import("../contracts/schemas.js").TrustedRedExecutionResult,
  contract: RedExecutionContract,
  runId: string,
): string {
  const fullOutput = `${rawResult.stdout}\n${rawResult.stderr}`.trim();
  const reportedOutput = rawResult.outputSnippet.trim();
  const output = fullOutput || reportedOutput;
  if (!output) {
    throw new Error(
      `RedExecutionValidationError: worker RED result for run ${runId} contains no failure output.`,
    );
  }
  if (fullOutput && reportedOutput !== fullOutput.slice(0, 500).trim()) {
    throw new Error(
      `RedExecutionValidationError: worker RED output snippet does not match its stdout/stderr for run ${runId}.`,
    );
  }
  const assertion = matchExpectedFailure({
    output,
    pattern: contract.expectedAssertion,
  });
  if (!rawResult.assertionMatched || !assertion.matched) {
    throw new Error(
      `RedAssertionMismatchError: trusted host could not verify expected assertion "${contract.expectedAssertion}" in worker RED output. Evidence_red not saved.`,
    );
  }
  return output.slice(0, 500);
}

function requireAuthoritativeTestIdentity(
  workspacePath: string,
  rawResult: import("../contracts/schemas.js").TrustedRedExecutionResult,
  contract: RedExecutionContract,
  runId: string,
): TestIdentity {
  if (!rawResult.testIdentity) {
    throw new Error(
      `RedAssertionMismatchError: worker RED result for run ${runId} is missing a concrete test identity. Evidence_red not saved.`,
    );
  }
  const hostIdentity = computeTestIdentity(
    workspacePath,
    contract.testCommand,
    contract.expectedAssertion,
    contract.testFiles,
  );
  if (!sameTestIdentity(rawResult.testIdentity, hostIdentity)) {
    throw new Error(
      `RedExecutionValidationError: worker RED test identity does not match the host-recomputed command/file identity for run ${runId}.`,
    );
  }
  return hostIdentity;
}

function requireWorkspaceHead(cwd: string, baseCommitSha: string): void {
  if (!baseCommitSha || !/^[0-9a-f]{7,64}$/i.test(baseCommitSha)) {
    throw new Error(
      "EvidencePatchProvenanceError: canonical workspace is missing a valid baseCommitSha.",
    );
  }
  const head = gitOutput(
    cwd,
    ["rev-parse", "--verify", "HEAD"],
    "read workspace HEAD",
  ).trim();
  if (head.toLowerCase() !== baseCommitSha.toLowerCase()) {
    throw new Error(
      `WorkspaceHeadMutationError: workspace HEAD ${head} differs from canonical base commit ${baseCommitSha}. Commits between RED and GREEN are forbidden.`,
    );
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function modeFromStat(path: string): "100644" | "100755" | "120000" {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) return "120000";
  return (stat.mode & 0o111) === 0 ? "100644" : "100755";
}

function contentAtWorkspace(
  path: string,
  mode: "100644" | "100755" | "120000",
): string {
  return mode === "120000" ? readlinkSync(path) : readFileSync(path, "utf8");
}

export function parseRawDiffZ(
  output: string,
): Map<string, { baseMode: string; currentMode: string }> {
  const tokens = output.split("\0");
  const entries = new Map<string, { baseMode: string; currentMode: string }>();
  for (let index = 0; index < tokens.length; index += 1) {
    const headerText = tokens[index];
    if (!headerText) continue;
    const path = tokens[++index];
    const header = headerText.trim().split(/\s+/);
    if (!headerText.startsWith(":") || header.length < 5 || !path) {
      throw new Error(
        "EvidencePatchProvenanceError: malformed git raw diff record.",
      );
    }
    entries.set(path.replace(/\\/g, "/"), {
      baseMode: header[0].slice(1),
      currentMode: header[1],
    });
  }
  return entries;
}

function canonicalDelta(files: DeltaFile[]): string {
  return [...files]
    .sort((a, b) => a.path.localeCompare(b.path))
    .map(
      (file) =>
        `${file.operation}\0${file.path}\0${file.mode}\0${file.contentSha256}`,
    )
    .join("\n");
}

function readPatchDelta(
  patchRaw: unknown,
  runId: string,
): {
  patchSha256: string;
  files: DeltaFile[];
} {
  const patchContent =
    typeof patchRaw === "string" ? patchRaw : JSON.stringify(patchRaw);
  let parsed: any;
  try {
    parsed = typeof patchRaw === "string" ? JSON.parse(patchRaw) : patchRaw;
  } catch {
    throw new Error(
      `EvidencePatchProvenanceError: patch artifact for run ${runId} is not valid JSON.`,
    );
  }
  if (!parsed || !Array.isArray(parsed.files) || parsed.files.length === 0) {
    throw new Error(
      `EvidencePatchProvenanceError: patch artifact for run ${runId} contains no concrete files.`,
    );
  }

  const seen = new Set<string>();
  const files: DeltaFile[] = parsed.files.map((file: any) => {
    const path = typeof file?.path === "string" ? file.path : "";
    if (!isSafeRepositoryPath(path)) {
      throw new Error(
        `EvidencePatchProvenanceError: unsafe patch path '${path}'.`,
      );
    }
    if (seen.has(path)) {
      throw new Error(
        `EvidencePatchProvenanceError: duplicate patch path '${path}'.`,
      );
    }
    seen.add(path);
    const operation = file.operation;
    if (
      operation !== "CREATE" &&
      operation !== "MODIFY" &&
      operation !== "DELETE"
    ) {
      throw new Error(
        `EvidencePatchProvenanceError: invalid operation for '${path}'.`,
      );
    }
    const mode = file.mode === undefined ? "100644" : file.mode;
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      throw new Error(
        `EvidencePatchProvenanceError: invalid mode for '${path}'.`,
      );
    }
    if (typeof file.content !== "string") {
      throw new Error(
        `EvidencePatchProvenanceError: patch content for '${path}' must be a string.`,
      );
    }
    return {
      path,
      operation,
      mode,
      contentSha256: sha256(file.content),
    };
  });
  return { patchSha256: sha256(patchContent), files };
}

function collectActualDelta(cwd: string, baseCommitSha: string): DeltaFile[] {
  const rawDiff = parseRawDiffZ(
    gitOutput(
      cwd,
      ["diff", "--raw", "-z", "--no-renames", baseCommitSha, "--"],
      "read the base-to-workspace diff",
    ),
  );
  const untracked = gitOutput(
    cwd,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    "read untracked workspace files",
  );
  for (const path of untracked.split("\0")) {
    if (path)
      rawDiff.set(path.replace(/\\/g, "/"), {
        baseMode: "000000",
        currentMode: "000000",
      });
  }

  const files: DeltaFile[] = [];
  for (const [path, metadata] of rawDiff) {
    const fullPath = resolve(cwd, path);
    const currentExists = pathExists(fullPath);
    const baseExists = metadata.baseMode !== "000000";
    if (!baseExists && !currentExists) continue;
    let operation: DeltaFile["operation"];
    if (!baseExists) {
      operation = "CREATE";
    } else if (currentExists) {
      operation = "MODIFY";
    } else {
      operation = "DELETE";
    }
    let mode = metadata.baseMode;
    if (currentExists) {
      mode =
        metadata.currentMode === "000000"
          ? modeFromStat(fullPath)
          : metadata.currentMode;
    }
    if (mode !== "100644" && mode !== "100755" && mode !== "120000") {
      throw new Error(
        `EvidencePatchProvenanceError: unsupported Git mode '${mode}' for '${path}'.`,
      );
    }
    files.push({
      path,
      operation,
      mode,
      contentSha256: currentExists
        ? sha256(contentAtWorkspace(fullPath, mode))
        : sha256(""),
    });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function countChangedLinesFromActualDelta(
  cwd: string,
  baseCommitSha: string,
  deltaFiles: DeltaFile[],
): number {
  let total = 0;
  for (const file of deltaFiles) {
    const fullPath = resolve(cwd, file.path);

    if (file.operation === "CREATE") {
      // Use git diff --no-index against an empty temp file for untracked CREATE
      // This uses Git's own diff engine for correct line counting
      if (!pathExists(fullPath)) {
        throw new Error(
          `EvidencePatchProvenanceError: cannot count lines for created file '${file.path}' that is missing on disk.`,
        );
      }
      const { mkdtempSync, writeFileSync, rmSync } = require("node:fs");
      const { join } = require("node:path");
      const { tmpdir } = require("node:os");
      const { execFileSync } = require("node:child_process");
      const tmpDir = mkdtempSync(join(tmpdir(), "oc-diff-"));
      const emptyFile = join(tmpDir, "empty");
      writeFileSync(emptyFile, "");
      try {
        // git diff --no-index returns exit code 1 when there are differences (normal case)
        let stat = "";
        try {
          stat = execFileSync(
            "git",
            ["diff", "--no-index", "--numstat", emptyFile, fullPath],
            { cwd, encoding: "utf-8", timeout: 10000 },
          );
        } catch (err: any) {
          // Exit code 1 means "there are differences" which is expected for CREATE
          if (err && (err.status === 1 || err.code === 1)) {
            stat = err.stdout || "";
          } else {
            throw new Error(
              `EvidencePatchProvenanceError: git numstat failed for created file '${file.path}': ${err.message}`,
            );
          }
        }
        const parts = stat.trim().split(/\s+/);
        if (parts.length >= 2) {
          const added = parseInt(parts[0], 10);
          const deleted = parseInt(parts[1], 10);
          if (Number.isNaN(added) || Number.isNaN(deleted)) {
            throw new Error(
              `EvidencePatchProvenanceError: git numstat returned invalid numbers for created file '${file.path}': ${stat.trim()}`,
            );
          }
          total += added + deleted;
        } else {
          throw new Error(
            `EvidencePatchProvenanceError: git numstat returned unexpected format for created file '${file.path}': ${stat.trim()}`,
          );
        }
      } finally {
        try {
          rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // best-effort
        }
      }
    } else if (file.operation === "DELETE") {
      // Use git diff --numstat against base commit for tracked DELETE
      const stat = gitOutput(
        cwd,
        ["diff", "--numstat", baseCommitSha, "--", file.path],
        `count changed lines for deleted file ${file.path}`,
      );
      const parts = stat.trim().split(/\s+/);
      if (parts.length >= 2) {
        const added = parseInt(parts[0], 10);
        const deleted = parseInt(parts[1], 10);
        if (Number.isNaN(added) || Number.isNaN(deleted)) {
          throw new Error(
            `EvidencePatchProvenanceError: git numstat returned invalid numbers for deleted file '${file.path}': ${stat.trim()}`,
          );
        }
        total += added + deleted;
      } else {
        throw new Error(
          `EvidencePatchProvenanceError: git numstat returned unexpected format for deleted file '${file.path}': ${stat.trim()}`,
        );
      }
    } else if (file.operation === "MODIFY") {
      // Use git diff --numstat for tracked MODIFY - Git handles line semantics
      const stat = gitOutput(
        cwd,
        ["diff", "--numstat", baseCommitSha, "--", file.path],
        `count changed lines for modified file ${file.path}`,
      );
      const parts = stat.trim().split(/\s+/);
      if (parts.length >= 2) {
        const added = parseInt(parts[0], 10);
        const deleted = parseInt(parts[1], 10);
        if (Number.isNaN(added) || Number.isNaN(deleted)) {
          throw new Error(
            `EvidencePatchProvenanceError: git numstat returned invalid numbers for modified file '${file.path}': ${stat.trim()}`,
          );
        }
        total += added + deleted;
      } else {
        throw new Error(
          `EvidencePatchProvenanceError: git numstat returned unexpected format for modified file '${file.path}': ${stat.trim()}`,
        );
      }
    }
  }
  return total;
}

function computeFinalTreeHash(cwd: string): string {
  const treeHash = computeSourceTreeHash(cwd);
  if (!treeHash) {
    throw new Error(
      "EvidencePatchProvenanceError: unable to compute the final GREEN tree hash.",
    );
  }
  return treeHash;
}

function verifyGitWorkspaceDelta(
  cwd: string,
  baseCommitSha: string,
  patchFiles: DeltaFile[],
): { actualDeltaSha256: string; files: DeltaFile[] } {
  const status = parsePorcelainV1Z(
    gitOutput(
      cwd,
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      "read workspace status",
    ),
  );
  for (const record of status) {
    if (record.status.includes("U")) {
      throw new Error(
        `EvidencePatchProvenanceError: workspace has an unresolved merge state for '${record.path}'.`,
      );
    }
  }
  const actualFiles = collectActualDelta(cwd, baseCommitSha);
  const patchCanonical = canonicalDelta(patchFiles);
  const actualCanonical = canonicalDelta(actualFiles);
  if (patchCanonical !== actualCanonical) {
    const patchPaths = new Set(patchFiles.map((file) => file.path));
    const unlisted = actualFiles
      .filter((file) => !patchPaths.has(file.path))
      .map((file) => file.path);
    if (unlisted.length > 0) {
      throw new Error(
        `EvidencePatchProvenanceError: workspace contains unlisted modified/untracked file(s): ${unlisted.join(", ")}.`,
      );
    }
    throw new Error(
      `EvidencePatchProvenanceError: actual delta from canonical baseCommitSha to GREEN workspace does not exactly match PatchArtifact (path, operation, mode, or content differs). Expected ${JSON.stringify(patchFiles)}, actual ${JSON.stringify(actualFiles)}.`,
    );
  }
  return { actualDeltaSha256: sha256(actualCanonical), files: actualFiles };
}

export class EvidenceService {
  constructor(private readonly runManager: ContributionRunManager) {}

  /**
   * Capture authoritative RED baseline.
   * Only EvidenceService can write `evidence_red`.
   */
  captureRed(input: CaptureRedInput): RedEvidence {
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }
    const ws = run.artifacts.workspace;
    if (!ws?.workspacePath) {
      throw new Error(
        `EvidenceWorkspaceRequiredError: run ${input.runId} has no canonical workspace artifact. Prepare workspace first.`,
      );
    }
    // Lock workspaceRoot and targetCwd strictly from the canonical WorkspaceArtifact
    const targetCwd = String(ws.workspacePath);
    const resolvedWorkspaceRoot = String(ws.workspacePath);
    const baselineCommitSha = requireBaseCommitSha(
      ws.baseCommitSha,
      input.runId,
    );
    requireWorkspaceHead(targetCwd, baselineCommitSha);
    const expectedAssertion = input.expectedAssertion?.trim();
    if (!expectedAssertion) {
      throw new Error(
        `RedExecutionValidationError: canonical RED capture for run ${input.runId} requires a concrete expected failure assertion. Use diagnostic-only evidence for assertion-free inspection.`,
      );
    }
    validateExpectedFailurePattern(expectedAssertion);

    const red = captureRedEvidence({
      cwd: targetCwd,
      testCommand: input.testCommand,
      workspaceRoot: resolvedWorkspaceRoot,
      expectedAssertion,
      testFileSha256: input.testFileSha256,
      baselineCommitSha,
      testFile: input.testFile,
    });
    requireWorkspaceHead(targetCwd, baselineCommitSha);

    // Only seal authoritative evidence_red when RED actually reproduced a valid failure (exitCode !== 0)
    // If test passed unexpectedly or assertion failed, do not seal immutable evidence_red.
    if (red.exitCode === 0) {
      throw new Error(
        `RedReproductionFailedError: test command exited with code 0 (expected failure). Evidence_red not saved so run is not permanently bricked. Output snippet: ${red.observedOutputSnippet.slice(0, 200)}`,
      );
    }
    if (!red.assertionMatched) {
      throw new Error(
        `RedAssertionMismatchError: expected assertion "${expectedAssertion}" was not observed in test output. Evidence_red not saved. Output snippet: ${red.observedOutputSnippet.slice(0, 200)}`,
      );
    }

    // Save authoritative evidence_red artifact only after passing verification and advance to RED_CAPTURED.
    // Local host capture retains the broader legacy file-resolution behavior;
    // worker-originated RED is sealed through the stricter recordRedExecution
    // contract above.
    saveCanonicalArtifact(
      this.runManager,
      input.runId,
      "evidence_red",
      red as any,
      "RED_CAPTURED",
    );

    // Also update partial evidence report for convenience (does not advance phase)
    saveCanonicalArtifact(this.runManager, input.runId, "evidence", {
      baselineTestedAt: red.capturedAt,
      baselineFlakyTests: [],
      stressLoopRuns: 0,
      stressLoopPassed: false,
      executionCount: 0,
      maxConcurrentObserved: 0,
      concurrencyWorkers: 0,
      concurrencyStampedePassed: false,
      handleLeakCheckPassed: "UNAVAILABLE",
      passedUnitTestsCount: 0,
      testCoverageStatus: "UNAVAILABLE",
      changedCodeCoverageStatus: "UNAVAILABLE",
      redEvidence: red,
      reproductionVerified: false,
      allTestsPassing: false,
    });

    return red;
  }

  /**
   * Verify GREEN and bind it to the captured RED baseline.
   * Reads RED strictly from the trusted `evidence_red` artifact or `evidence.redEvidence`.
   * Also verifies that the stored patch artifact was actually applied to the workspace.
   * On verified reproduction, advances run phase to EVIDENCE_COLLECTED.
   */
  async verifyGreen(input: VerifyGreenInput): Promise<EvidenceReport> {
    // Reject dimensions before any workspace inspection or execution. This is
    // intentionally strict for explicit values; defaults are applied only for
    // omitted fields by the shared contract.
    const dimensions = validateStressDimensions(
      input.stressLoopCount,
      input.concurrencyWorkers,
    );
    const run = this.runManager.getRun(input.runId);
    if (!run) {
      throw new Error(`Contribution run ${input.runId} does not exist`);
    }

    // Load trusted RED evidence from evidence_red or evidence artifact
    const redEvidence = (run.artifacts?.evidenceRed ||
      run.artifacts?.evidence?.redEvidence) as RedEvidence | undefined;

    if (!redEvidence || !redEvidence.sourceTreeSha256) {
      throw new Error(
        `No authoritative RED baseline found for run ${input.runId}. Call EvidenceService.captureRed() first.`,
      );
    }
    if (
      normalizeCommand(input.testCommand) !==
      normalizeCommand(redEvidence.command)
    ) {
      throw new Error(
        `GreenExecutionValidationError: GREEN test command does not match the authoritative RED command for run ${input.runId}.`,
      );
    }

    const ws = run.artifacts.workspace;
    if (!ws?.workspacePath) {
      throw new Error(
        `EvidenceWorkspaceRequiredError: run ${input.runId} has no canonical workspace artifact. Prepare workspace first.`,
      );
    }
    // Lock workspaceRoot and targetCwd strictly from canonical WorkspaceArtifact
    const targetCwd = String(ws.workspacePath);
    const resolvedWorkspaceRoot = String(ws.workspacePath);
    const baselineCommitSha = requireBaseCommitSha(
      ws.baseCommitSha,
      input.runId,
    );
    requireWorkspaceHead(targetCwd, baselineCommitSha);

    const patchRaw = run.artifacts.patch;
    if (!patchRaw) {
      throw new Error(
        `PatchRequiredForGreenVerificationError: run ${input.runId} has no patch artifact. Draft patch before verifying GREEN.`,
      );
    }
    const parsedPatch = readPatchDelta(patchRaw, input.runId);

    // Validate the declared file content, mode, and symlink target before
    // running GREEN. lstat/readlink are intentional: readFile would follow a
    // symlink and could validate a different tree than the one submitted.
    let rawPatch: any;
    try {
      rawPatch = typeof patchRaw === "string" ? JSON.parse(patchRaw) : patchRaw;
    } catch {
      throw new Error(
        `EvidencePatchProvenanceError: patch artifact for run ${input.runId} is not valid JSON.`,
      );
    }
    const patchFilesWithContent = parsedPatch.files.map((file) => {
      const declared = rawPatch.files.find(
        (candidate: any) => candidate.path === file.path,
      );
      const fullPath = resolve(targetCwd, file.path);
      if (file.operation === "DELETE") {
        if (pathExists(fullPath)) {
          throw new Error(
            `EvidencePatchProvenanceError: patch specifies DELETE for '${file.path}', but file still exists on disk in workspace.`,
          );
        }
        return file;
      }
      try {
        const diskMode = modeFromStat(fullPath);
        const onDiskContent = contentAtWorkspace(fullPath, diskMode);
        if (diskMode !== file.mode) {
          throw new Error(
            `EvidencePatchProvenanceError: workspace mode for '${file.path}' is ${diskMode}, patch declares ${file.mode}.`,
          );
        }
        if (onDiskContent !== declared.content) {
          throw new Error(
            `EvidencePatchProvenanceError: on-disk content for '${file.path}' does not match the patch artifact content.`,
          );
        }
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          throw new Error(
            `EvidencePatchProvenanceError: patch specifies file '${file.path}', but file does not exist on disk in workspace.`,
          );
        }
        throw err;
      }
      return file;
    });

    // This is intentionally fail-closed: both the canonical base HEAD and
    // Git's exact base-to-workspace delta must be available before GREEN.
    verifyGitWorkspaceDelta(
      targetCwd,
      baselineCommitSha,
      patchFilesWithContent,
    );

    const full = await collectEvidence({
      cwd: targetCwd,
      workspaceRoot: resolvedWorkspaceRoot,
      baselineCommitSha,
      testCommand: input.testCommand,
      stressLoopCount: dimensions.rounds,
      concurrencyWorkers: dimensions.workersPerRound,
      coverageAdapter: input.coverageAdapter,
      redEvidence,
    });
    requireWorkspaceHead(targetCwd, baselineCommitSha);

    // Recompute the final tree after every verification run, then seal the
    // exact RED-base -> GREEN delta. This immutable artifact is the later
    // governance/submission binding, not the mutable patch draft.
    const exactDelta = verifyGitWorkspaceDelta(
      targetCwd,
      baselineCommitSha,
      patchFilesWithContent,
    );
    const finalGreenTreeSha256 = computeFinalTreeHash(targetCwd);
    const appliedPatchSha256 = parsedPatch.patchSha256;
    if (!full.greenEvidence || full.reproductionVerified !== true) {
      const report = EvidenceReportSchema.parse({ ...full, redEvidence });
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        report as any,
      );
      return report;
    }
    const greenEvidenceBase = {
      ...full.greenEvidence,
      sourceTreeSha256: finalGreenTreeSha256,
      treeChangedComparedToRed:
        finalGreenTreeSha256 !== redEvidence.sourceTreeSha256,
      treeHashMatchesRed: finalGreenTreeSha256 === redEvidence.sourceTreeSha256,
      appliedPatchSha256,
    };

    let report: EvidenceReport = {
      ...full,
      redEvidence,
      greenEvidence: greenEvidenceBase,
      reproductionVerified: true,
      allTestsPassing: true,
    };

    const changedLines = countChangedLinesFromActualDelta(
      targetCwd,
      baselineCommitSha,
      exactDelta.files,
    );

    if (report.reproductionVerified === true) {
      const validatedPatch: ValidatedPatchArtifact = {
        runId: input.runId,
        patchSha256: appliedPatchSha256,
        actualDeltaSha256: exactDelta.actualDeltaSha256,
        baseCommitSha: baselineCommitSha,
        redTreeSha256: redEvidence.sourceTreeSha256,
        greenTreeSha256: finalGreenTreeSha256,
        artifactSha256: "",
        changedLines,
        files: exactDelta.files.map((file): ValidatedPatchFile => ({
          path: file.path,
          operation: file.operation,
          mode: file.mode,
          contentSha256: file.contentSha256,
        })),
        validatedAt: new Date().toISOString(),
      };
      validatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(validatedPatch);
      ValidatedPatchArtifactSchema.parse(validatedPatch);
      const greenEvidenceWithPatch = {
        ...greenEvidenceBase,
        validatedPatchArtifactSha256: validatedPatch.artifactSha256,
      };
      report = {
        ...report,
        greenEvidence: greenEvidenceWithPatch,
      };
      const validatedReport = EvidenceReportSchema.parse(report);
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "validated_patch",
        validatedPatch as any,
      );
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        validatedReport as any,
        "EVIDENCE_COLLECTED",
      );
      report = validatedReport;
    } else {
      const validatedReport = EvidenceReportSchema.parse(report);
      saveCanonicalArtifact(
        this.runManager,
        input.runId,
        "evidence",
        validatedReport as any,
      );
      report = validatedReport;
    }

    return report;
  }

  /**
   * Authoritatively record raw RED execution result emitted by a worker.
   * Host validates the execution result, matches assertions, seals evidence_red,
   * and advances to RED_CAPTURED.
   */
  recordRedExecution(
    runId: string,
    rawResult: RawRedExecutionResult,
    executionContract: RedExecutionContract,
  ): RedEvidence {
    const run = this.runManager.getRun(runId);
    if (!run) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }
    const ws = run.artifacts.workspace;
    if (!ws?.workspacePath) {
      throw new Error(
        `EvidenceWorkspaceRequiredError: run ${runId} has no canonical workspace artifact. Prepare workspace first.`,
      );
    }

    const contract = requireRedContract(executionContract, runId);
    const trustedRawResult = requireRawRedResult(rawResult, runId);
    if (trustedRawResult.exitCode === 0) {
      throw new Error(
        `RedReproductionFailedError: test command exited with code 0 (expected failure). Evidence_red not saved.`,
      );
    }
    if (
      normalizeCommand(trustedRawResult.command) !==
      normalizeCommand(contract.testCommand)
    ) {
      throw new Error(
        `RedExecutionValidationError: worker RED command does not match the trusted RED contract for run ${runId}.`,
      );
    }

    const targetCwd = String(ws.workspacePath);
    const baselineCommitSha = requireBaseCommitSha(ws.baseCommitSha, runId);
    requireWorkspaceHead(targetCwd, baselineCommitSha);
    const sourceTreeSha256 = requireAuthoritativeSourceHash(
      targetCwd,
      trustedRawResult.sourceTreeSha256,
      runId,
    );
    const testIdentity = requireAuthoritativeTestIdentity(
      targetCwd,
      trustedRawResult,
      contract,
      runId,
    );
    const observedOutputSnippet = requireAuthoritativeOutput(
      trustedRawResult,
      contract,
      runId,
    );
    const assertionMatchedFingerprint = computeTestIdentityFingerprint({
      testCommand: contract.testCommand,
      expectedAssertion: contract.expectedAssertion,
    });
    const redResult = AuthoritativeRedEvidenceSchema.safeParse({
      command: contract.testCommand,
      expectedAssertion: contract.expectedAssertion,
      observedOutputSnippet,
      exitCode: trustedRawResult.exitCode,
      sourceTreeSha256,
      testFileSha256:
        testIdentity.testFiles.length === 1
          ? testIdentity.testFiles[0].sha256
          : undefined,
      baselineCommitSha,
      capturedAt: new Date().toISOString(),
      assertionMatched: true,
      assertionMatchedFingerprint,
      testIdentity,
    });
    if (!redResult.success) {
      throw new Error(
        `RedExecutionValidationError: host-built RED evidence for run ${runId} is invalid: ${schemaIssueSummary(redResult.error)}.`,
      );
    }
    const red = redResult.data;

    saveCanonicalArtifact(
      this.runManager,
      runId,
      "evidence_red",
      red as any,
      "RED_CAPTURED",
    );

    const partialEvidence = EvidenceReportSchema.parse({
      baselineTestedAt: red.capturedAt,
      baselineFlakyTests: [],
      stressLoopRuns: 0,
      stressLoopPassed: false,
      executionCount: 0,
      maxConcurrentObserved: 0,
      concurrencyWorkers: 0,
      concurrencyStampedePassed: false,
      handleLeakCheckPassed: "UNAVAILABLE",
      passedUnitTestsCount: 0,
      testCoverageStatus: "UNAVAILABLE",
      changedCodeCoverageStatus: "UNAVAILABLE",
      redEvidence: red,
      reproductionVerified: false,
      allTestsPassing: false,
    });
    saveCanonicalArtifact(
      this.runManager,
      runId,
      "evidence",
      partialEvidence as any,
    );

    return red;
  }

  /**
   * Authoritatively record raw GREEN execution result emitted by a worker.
   * Host validates workspace delta, binds ValidatedPatchArtifact, seals EvidenceReport,
   * and advances to EVIDENCE_COLLECTED.
   */
  async recordGreenExecution(
    runId: string,
    rawResult: import("../run/trusted-execution.port.js").RawGreenExecutionResult,
  ): Promise<EvidenceReport> {
    const rawValidation =
      TrustedGreenExecutionResultSchema.safeParse(rawResult);
    if (!rawValidation.success) {
      throw new Error(
        `GreenExecutionValidationError: worker GREEN result for run ${runId} is invalid: ${schemaIssueSummary(rawValidation.error)}.`,
      );
    }
    const trustedRawResult = rawValidation.data;
    const run = this.runManager.getRun(runId);
    if (!run) {
      throw new Error(`Contribution run ${runId} does not exist`);
    }
    const redEvidence = (run.artifacts?.evidenceRed ||
      run.artifacts?.evidence?.redEvidence) as RedEvidence | undefined;

    if (!redEvidence || !redEvidence.sourceTreeSha256) {
      throw new Error(
        `No authoritative RED baseline found for run ${runId}. Capture RED first.`,
      );
    }
    const ws = run.artifacts.workspace;
    if (!ws?.workspacePath) {
      throw new Error(
        `EvidenceWorkspaceRequiredError: run ${runId} has no canonical workspace artifact. Prepare workspace first.`,
      );
    }
    const targetCwd = String(ws.workspacePath);
    const baselineCommitSha = requireBaseCommitSha(ws.baseCommitSha, runId);
    requireWorkspaceHead(targetCwd, baselineCommitSha);

    if (
      normalizeCommand(trustedRawResult.command) !==
      normalizeCommand(redEvidence.command)
    ) {
      throw new Error(
        `GreenExecutionValidationError: worker GREEN command does not match the authoritative RED command for run ${runId}.`,
      );
    }

    const patchRaw = run.artifacts.patch;
    if (!patchRaw) {
      throw new Error(
        `PatchRequiredForGreenVerificationError: run ${runId} has no patch artifact. Draft patch before verifying GREEN.`,
      );
    }
    const parsedPatch = readPatchDelta(patchRaw, runId);

    let rawPatch: any;
    try {
      rawPatch = typeof patchRaw === "string" ? JSON.parse(patchRaw) : patchRaw;
    } catch {
      throw new Error(
        `EvidencePatchProvenanceError: patch artifact for run ${runId} is not valid JSON.`,
      );
    }
    const patchFilesWithContent = parsedPatch.files.map((file) => {
      const declared = rawPatch.files.find(
        (candidate: any) => candidate.path === file.path,
      );
      const fullPath = resolve(targetCwd, file.path);
      if (file.operation === "DELETE") {
        if (pathExists(fullPath)) {
          throw new Error(
            `EvidencePatchProvenanceError: patch specifies DELETE for '${file.path}', but file still exists on disk in workspace.`,
          );
        }
        return file;
      }
      try {
        const diskMode = modeFromStat(fullPath);
        const onDiskContent = contentAtWorkspace(fullPath, diskMode);
        if (diskMode !== file.mode) {
          throw new Error(
            `EvidencePatchProvenanceError: workspace mode for '${file.path}' is ${diskMode}, patch declares ${file.mode}.`,
          );
        }
        if (onDiskContent !== declared.content) {
          throw new Error(
            `EvidencePatchProvenanceError: on-disk content for '${file.path}' does not match the patch artifact content.`,
          );
        }
      } catch (err: any) {
        if (err?.code === "ENOENT") {
          throw new Error(
            `EvidencePatchProvenanceError: patch specifies file '${file.path}', but file does not exist on disk in workspace.`,
          );
        }
        throw err;
      }
      return file;
    });

    const exactDelta = verifyGitWorkspaceDelta(
      targetCwd,
      baselineCommitSha,
      patchFilesWithContent,
    );
    const finalGreenTreeSha256 = computeFinalTreeHash(targetCwd);
    if (
      trustedRawResult.sourceTreeSha256.toLowerCase() !==
      finalGreenTreeSha256.toLowerCase()
    ) {
      throw new Error(
        `GreenExecutionValidationError: worker GREEN tree hash does not match the host-recomputed workspace hash for run ${runId} (worker=${trustedRawResult.sourceTreeSha256}, host=${finalGreenTreeSha256}).`,
      );
    }
    const appliedPatchSha256 = parsedPatch.patchSha256;
    const treeChanged = finalGreenTreeSha256 !== redEvidence.sourceTreeSha256;

    // Host-side Test Identity Verification: Never blindly trust worker identity.
    // Recompute the green test identity on the physical workspace and require exact match with RED.
    let testIdentityValid = false;
    let actualTestDiffSha256: string | undefined;
    const explicitTestFiles =
      redEvidence.testIdentity?.testFiles.map((file) => file.path) || [];
    const greenTestIdentity = computeTestIdentity(
      targetCwd,
      redEvidence.command,
      redEvidence.testIdentity?.expectedAssertion ??
        redEvidence.expectedAssertion,
      explicitTestFiles,
    );
    if (redEvidence.testIdentity) {
      const redFiles = redEvidence.testIdentity.testFiles || [];
      const greenFiles = greenTestIdentity.testFiles || [];
      actualTestDiffSha256 = computeTestFileDiffSha256(redFiles, greenFiles);
      testIdentityValid =
        redFiles.length > 0 &&
        greenFiles.length > 0 &&
        greenTestIdentity.identitySha256 ===
          redEvidence.testIdentity.identitySha256;
      if (
        !testIdentityValid &&
        redEvidence.testMutationPolicy?.allowed === true &&
        actualTestDiffSha256 &&
        redEvidence.testMutationPolicy.expectedDiffSha256 ===
          actualTestDiffSha256
      ) {
        testIdentityValid = true;
      }
    } else {
      testIdentityValid = true;
    }

    if (!testIdentityValid) {
      throw new Error(
        "TestIdentityMutationError: GREEN test file content differs from authoritative RED baseline without an explicit permitted testMutationPolicy.",
      );
    }

    const reproductionVerified =
      redEvidence.assertionMatched === true &&
      trustedRawResult.passed &&
      treeChanged &&
      testIdentityValid;

    const greenEvidenceBase = {
      command: trustedRawResult.command,
      exitCode: trustedRawResult.exitCode,
      outputSnippet: trustedRawResult.outputSnippet,
      passed: trustedRawResult.passed,
      sourceTreeSha256: finalGreenTreeSha256,
      capturedAt: trustedRawResult.capturedAt,
      treeChangedComparedToRed: treeChanged,
      treeHashMatchesRed: !treeChanged,
      roundsRequested: trustedRawResult.roundsRequested,
      roundsCompleted: trustedRawResult.roundsCompleted,
      workersPerRound: trustedRawResult.workersPerRound,
      executionsExpected: trustedRawResult.executionsExpected,
      executionCount: trustedRawResult.executionCount,
      passedUnitTestsCount: trustedRawResult.passedUnitTestsCount,
      stressLoopPassed: trustedRawResult.passed,
      allTestsPassing: trustedRawResult.passed,
      assertionMatchedFingerprint: computeTestIdentityFingerprint({
        testCommand: redEvidence.command,
        expectedAssertion:
          redEvidence.testIdentity?.expectedAssertion ??
          redEvidence.expectedAssertion,
      }),
      testIdentity: greenTestIdentity,
      appliedPatchSha256,
    };

    // Worker dimensions are already validated above. Preserve omitted/zero
    // metadata for failed or timed-out results instead of inventing rounds.
    const executionCount = trustedRawResult.executionCount;
    const roundsRequested = trustedRawResult.roundsRequested;
    const roundsCompleted = trustedRawResult.roundsCompleted;
    const workersPerRound = trustedRawResult.workersPerRound;
    const executionsExpected = trustedRawResult.executionsExpected;

    let report: EvidenceReport = {
      baselineTestedAt: trustedRawResult.capturedAt,
      baselineFlakyTests: [],
      stressLoopRuns: roundsRequested ?? 0,
      ...(roundsRequested === undefined ? {} : { roundsRequested }),
      ...(roundsCompleted === undefined ? {} : { roundsCompleted }),
      ...(workersPerRound === undefined ? {} : { workersPerRound }),
      ...(executionsExpected === undefined ? {} : { executionsExpected }),
      stressLoopPassed: trustedRawResult.passed,
      executionCount,
      maxConcurrentObserved: trustedRawResult.maxConcurrentObserved,
      concurrencyWorkers: trustedRawResult.concurrencyWorkers,
      concurrencyStampedePassed: trustedRawResult.concurrencyStampedePassed,
      raceCollisionsDetected: trustedRawResult.raceCollisionsDetected,
      latencyJitterMs: trustedRawResult.latencyJitterMs,
      handleLeakCheckPassed: trustedRawResult.handleLeakCheckPassed,
      initialDescriptorCount: trustedRawResult.initialDescriptorCount,
      finalDescriptorCount: trustedRawResult.finalDescriptorCount,
      passedUnitTestsCount: trustedRawResult.passedUnitTestsCount,
      failedUnitTestsCount: trustedRawResult.failedUnitTestsCount,
      testCoverageStatus: "UNAVAILABLE",
      changedCodeCoverageStatus: "UNAVAILABLE",
      allTestsPassing: trustedRawResult.passed,
      redEvidence,
      greenEvidence: greenEvidenceBase,
      reproductionVerified,
    };

    const changedLines = countChangedLinesFromActualDelta(
      targetCwd,
      baselineCommitSha,
      exactDelta.files,
    );

    if (report.reproductionVerified === true) {
      const validatedPatch: ValidatedPatchArtifact = {
        runId,
        patchSha256: appliedPatchSha256,
        actualDeltaSha256: exactDelta.actualDeltaSha256,
        baseCommitSha: baselineCommitSha,
        redTreeSha256: redEvidence.sourceTreeSha256,
        greenTreeSha256: finalGreenTreeSha256,
        artifactSha256: "",
        changedLines,
        files: exactDelta.files.map((file): ValidatedPatchFile => ({
          path: file.path,
          operation: file.operation,
          mode: file.mode,
          contentSha256: file.contentSha256,
        })),
        validatedAt: new Date().toISOString(),
      };
      validatedPatch.artifactSha256 =
        hashValidatedPatchArtifact(validatedPatch);
      ValidatedPatchArtifactSchema.parse(validatedPatch);
      const greenEvidenceWithPatch = {
        ...greenEvidenceBase,
        validatedPatchArtifactSha256: validatedPatch.artifactSha256,
      };
      report = {
        ...report,
        greenEvidence: greenEvidenceWithPatch,
      };
      const validatedReport = EvidenceReportSchema.parse(report);
      saveCanonicalArtifact(
        this.runManager,
        runId,
        "validated_patch",
        validatedPatch as any,
      );
      saveCanonicalArtifact(
        this.runManager,
        runId,
        "evidence",
        validatedReport as any,
        "EVIDENCE_COLLECTED",
      );
      report = validatedReport;
    } else {
      const validatedReport = EvidenceReportSchema.parse(report);
      saveCanonicalArtifact(
        this.runManager,
        runId,
        "evidence",
        validatedReport as any,
      );
      report = validatedReport;
    }

    return report;
  }
}
