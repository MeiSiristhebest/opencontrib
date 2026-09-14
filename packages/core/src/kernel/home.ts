import { homedir } from "os";
import * as path from "path";

/**
 * Single source of truth for the OpenContrib home directory.
 *
 * Replaces 13 duplicated `getOpenContribHome()` definitions that were scattered
 * across the codebase, each re-reading `process.env.OPENCONTRIB_HOME` directly
 * (a DIP violation — high-level policy depended on a global mutable env var).
 * Centralizing it also makes the value trivially mockable/injectable later.
 */
export function getOpenContribHome(): string {
 return process.env.OPENCONTRIB_HOME || homedir();
}

/**
 * Single canonical data directory for OpenContrib persistent state.
 * If OPENCONTRIB_HOME is set:
 *   - If it already points to a directory named '.opencontrib', use it as-is.
 *   - Otherwise, treat it as the root/parent and append '.opencontrib' or use it directly if configured.
 * Default: path.join(homedir(), '.opencontrib')
 */
export function getOpenContribDataDir(): string {
 const env = process.env.OPENCONTRIB_HOME;
 if (!env) {
  return path.join(homedir(), ".opencontrib");
 }
 return env.endsWith(".opencontrib") ? env : path.join(env, ".opencontrib");
}
