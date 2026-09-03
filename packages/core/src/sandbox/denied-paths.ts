import { homedir } from 'os';
import { join } from 'path';

/**
 * Credential-bearing paths that must NEVER be readable by untrusted sandbox code.
 *
 * Shared by every SandboxProvider so the safety contract is identical across
 * implementations (Local vs Docker). Previously `DockerSandboxProvider`
 * returned `[]`, silently weakening the guarantee — a classic LSP violation.
 */
export function sensitiveDeniedPaths(home: string = homedir()): string[] {
  return [
    join(home, '.ssh'),
    join(home, '.aws'),
    join(home, '.azure'),
    join(home, '.config', 'gh'),
    join(home, '.config', 'opencontrib'),
    join(home, '.opencontrib'),
    join(home, '.git-credentials'),
    join(home, '.netrc'),
    join(home, '.npmrc'),
    join(home, '.pypirc'),
    join(home, '.gnupg'),
  ];
}
