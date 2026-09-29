/**
 * Canonical run-owned git branch naming helper.
 */
const RUN_BRANCH_PREFIX = "opencontrib";

export function runBranchName(
  runId: string,
  prefix = RUN_BRANCH_PREFIX,
): string {
  const cleanPrefix = (prefix || RUN_BRANCH_PREFIX).replace(/\/+$/, "");
  if (cleanPrefix !== RUN_BRANCH_PREFIX) {
    throw new Error(
      `RunBranchPrefixError: run-owned branches must use the ${RUN_BRANCH_PREFIX}/ prefix.`,
    );
  }
  const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${RUN_BRANCH_PREFIX}/run-${sanitizedRunId}`;
}
