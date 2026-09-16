/**
 * Canonical run-owned git branch naming helper.
 */
export function runBranchName(runId: string): string {
  return `opencontrib/run-${runId.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
}
