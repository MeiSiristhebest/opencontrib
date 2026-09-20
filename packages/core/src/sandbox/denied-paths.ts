import { homedir } from "node:os";
import { join } from "node:path";
import { resolveOpenContribPaths } from "../kernel/home.js";

/**
 * Credential-bearing paths that must NEVER be readable by untrusted sandbox
 * code. Both the OS home and the configured OpenContrib base/data directories
 * are denied so OPENCONTRIB_HOME cannot create a credential escape hatch.
 */
export function sensitiveDeniedPaths(home: string = homedir()): string[] {
  const configured = resolveOpenContribPaths();
  return Array.from(
    new Set([
      join(home, ".ssh"),
      join(home, ".aws"),
      join(home, ".azure"),
      join(home, ".config", "gh"),
      join(home, ".config", "opencontrib"),
      join(home, ".opencontrib"),
      join(home, ".git-credentials"),
      join(home, ".netrc"),
      join(home, ".npmrc"),
      join(home, ".pypirc"),
      join(home, ".gnupg"),
      configured.baseDir,
      configured.dataDir,
    ]),
  );
}
