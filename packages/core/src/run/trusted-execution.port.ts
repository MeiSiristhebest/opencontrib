import type { RedEvidence, TestIdentity } from "../contracts/schemas.js";

export interface ExecutionWorkspaceRef {
  /** Repository full name, e.g. "owner/repo" */
  repoFullName: string;
  /** Git base commit SHA */
  baseCommitSha: string;
  /** Local workspace filesystem path (or container volume source) */
  workspacePath: string;
}

export interface RedExecutionJob {
  runId: string;
  workspace: ExecutionWorkspaceRef;
  testCommand: string;
  expectedAssertion: string;
  testFiles: string[];
}

export interface RawRedExecutionResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  outputSnippet: string;
  assertionMatched: boolean;
  capturedAt: string;
  sourceTreeSha256: string;
  testIdentity?: TestIdentity;
}

export interface GreenExecutionJob {
  runId: string;
  workspace: ExecutionWorkspaceRef;
  testCommand: string;
  redEvidence: RedEvidence;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
}

export interface RawGreenExecutionResult {
  command: string;
  exitCode: number;
  outputSnippet: string;
  passed: boolean;
  sourceTreeSha256: string;
  capturedAt: string;
  executionCount: number;
  maxConcurrentObserved: number;
  concurrencyWorkers: number;
  concurrencyStampedePassed: boolean;
  raceCollisionsDetected: number;
  latencyJitterMs: number;
  testIdentity?: TestIdentity;
  passedUnitTestsCount: number;
  failedUnitTestsCount: number;
  handleLeakCheckPassed: "PASS" | "FAIL" | "UNAVAILABLE";
  initialDescriptorCount?: number;
  finalDescriptorCount?: number;
}

/**
 * Port representing the boundary between the Trusted Run Host (which holds
 * GitHub credentials, approval keys, and canonical metadata) and the
 * Untrusted Execution Worker/Sandbox where user/repo code is physically executed.
 *
 * Workers receive only the command, target files, and workspace, and return raw
 * execution metrics. They NEVER hold the Host runManager, and they NEVER mint
 * canonical WORM artifacts.
 */
export interface TrustedExecutionPort {
  captureRed(job: RedExecutionJob): Promise<RawRedExecutionResult>;
  verifyGreen(job: GreenExecutionJob): Promise<RawGreenExecutionResult>;
}
