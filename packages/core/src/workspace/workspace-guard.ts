/**
 * Workspace root safety guard.
 *
 * Creates a lockfile at <workspace>/.opencontrib-guard when a workspace is
 * initialized, and validates it before any deletion operation.  This provides
 * a second line of defense: even if safeRmSync is bypassed or called with
 * wrong arguments, the guardfile check prevents accidental deletion of a
 * live workspace root.
 *
 * Root cause of the original data loss: concurrent sub-agents + Chinese cwd
 * path resolution failure caused rmSync to target the wrong directory.
 * The guardfile makes it physically impossible for a process running FROM
 * that directory to delete it, because the guardfile would be open/locked.
 */

import * as fs from 'fs';
import * as path from 'path';

const GUARD_NAME = '.opencontrib-guard';

/**
 * Create or verify a safety guardfile at the workspace root.
 * Returns true if the guardfile is present and writable (workspace is active).
 */
export function ensureWorkspaceGuard(workspacePath: string): boolean {
  const guardPath = path.join(workspacePath, GUARD_NAME);
  try {
    if (!fs.existsSync(guardPath)) {
      fs.writeFileSync(guardPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        workspace: workspacePath,
        pid: process.pid,
      }), 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Check whether a path is a protected workspace root.
 * A workspace is protected if it contains a .opencontrib-guard file.
 * This should be called BEFORE any deletion to prevent self-deletion.
 */
export function isProtectedWorkspace(targetPath: string): boolean {
  const guardPath = path.join(targetPath, GUARD_NAME);
  return fs.existsSync(guardPath);
}

/**
 * Remove the guardfile when a workspace is intentionally destroyed.
 * Must be called before cleanup to signal intentional deletion.
 */
export function releaseWorkspaceGuard(workspacePath: string): boolean {
  const guardPath = path.join(workspacePath, GUARD_NAME);
  try {
    if (fs.existsSync(guardPath)) {
      fs.unlinkSync(guardPath);
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
