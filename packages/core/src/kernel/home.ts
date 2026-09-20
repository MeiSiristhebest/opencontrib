import { homedir } from "node:os";
import * as path from "node:path";

export interface OpenContribPaths {
  /** The configured parent/home boundary used for security checks. */
  baseDir: string;
  /** The single canonical directory for OpenContrib persistent state. */
  dataDir: string;
}

export interface OpenContribPathOptions {
  /** Explicit home value; useful for tests and CLI bootstrap. */
  home?: string;
}

/**
 * Resolve OpenContrib storage paths from one semantic contract.
 *
 * OPENCONTRIB_HOME names either the parent directory (`/tmp/oc`) or the final
 * data directory (`/tmp/oc/.opencontrib`).  Both forms resolve to exactly one
 * canonical data directory and are normalized before any caller uses them.
 */
export function resolveOpenContribPaths(
  options: OpenContribPathOptions = {},
): OpenContribPaths {
  const configured = (options.home ?? process.env.OPENCONTRIB_HOME)?.trim();
  if (!configured) {
    const baseDir = path.resolve(homedir());
    return { baseDir, dataDir: path.join(baseDir, ".opencontrib") };
  }

  const configuredPath = path.resolve(configured);
  const isDataDir =
    path.basename(configuredPath).toLowerCase() === ".opencontrib";
  const baseDir = isDataDir ? path.dirname(configuredPath) : configuredPath;
  // Normalize case variants of the marker to the one canonical spelling. This
  // prevents `/tmp/oc/.OPENCONTRIB` and `/tmp/oc` from becoming two logical
  // stores on case-sensitive hosts while still handling Windows paths.
  const dataDir = path.join(baseDir, ".opencontrib");
  return {
    baseDir: path.resolve(baseDir),
    dataDir: path.resolve(dataDir),
  };
}

/** Compatibility wrapper: returns the configured parent/home boundary. */
export function getOpenContribHome(): string {
  return resolveOpenContribPaths().baseDir;
}

/** Compatibility wrapper: returns the canonical persistent data directory. */
export function getOpenContribDataDir(): string {
  return resolveOpenContribPaths().dataDir;
}
