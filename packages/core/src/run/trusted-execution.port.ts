import type { RedEvidence, EvidenceReport } from "../contracts/schemas.js";

export interface RedExecutionJob {
  runId: string;
  cwd: string;
  testCommand: string;
  expectedAssertion: string;
  testFiles: string[];
}

export interface GreenExecutionJob {
  runId: string;
  cwd: string;
  testCommand: string;
  stressLoopCount?: number;
  concurrencyWorkers?: number;
}

/**
 * Port representing the boundary between the Trusted Run Host (which holds
 * GitHub credentials, approval keys, and canonical metadata) and the
 * Untrusted Execution Worker/Sandbox where user/repo code is physically executed.
 */
export interface TrustedExecutionPort {
  captureRed(job: RedExecutionJob): Promise<RedEvidence>;
  verifyGreen(job: GreenExecutionJob): Promise<EvidenceReport>;
}
