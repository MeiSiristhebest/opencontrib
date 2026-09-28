/**
 * Canonical run-owned git branch naming helper.
 */
export function runBranchName(runId: string, prefix = "opencontrib"): string {
  const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cleanPrefix = (prefix || "opencontrib").replace(/\/+$/, "");
  return `${cleanPrefix}/run-${sanitizedRunId}`;
}
