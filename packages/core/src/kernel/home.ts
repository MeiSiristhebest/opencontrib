import { homedir } from 'os';

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
