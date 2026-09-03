import { existsSync, readFileSync } from 'fs';
import { spawnSync } from 'child_process';
import { join } from 'path';
import { createHash } from 'crypto';
import { getOpenContribHome } from '../kernel/home.js';
import type { CredentialsProvider } from '../ports/credentials-provider.port.js';

/**
 * Resolves a GitHub token using the same precedence the monolith used:
 *   1. explicit token (constructor arg / env)
 *   2. `~/.config/opencontrib/config.json` → github.pat
 *   3. `gh auth token` (GitHub CLI)
 *
 * Extracted from `GitHubClient` so the resolution strategy is a swappable
 * adapter (the architecture review's DIP requirement, §6 / §16 stage 4).
 */
export class EnvConfigGhCliCredentialsProvider implements CredentialsProvider {
  private readonly token: string;
  private readonly scope: string;

  constructor(explicitToken?: string) {
    const token = EnvConfigGhCliCredentialsProvider.resolve(explicitToken);
    this.token = token;
    this.scope = token
      ? createHash('sha256').update(token).digest('hex').slice(0, 8)
      : 'anon';
  }

  getToken(): string {
    return this.token;
  }

  getTokenScope(): string {
    return this.scope;
  }

  private static resolve(explicit?: string): string {
    let token = explicit || process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';

    // Fallback 1: Read from ~/.config/opencontrib/config.json
    if (!token) {
      try {
        const configPath = join(getOpenContribHome(), '.config', 'opencontrib', 'config.json');
        if (existsSync(configPath)) {
          const cfg = JSON.parse(readFileSync(configPath, 'utf-8'));
          token = cfg?.github?.pat || '';
        }
      } catch {}
    }

    // Fallback 2: Read from GitHub CLI (gh auth token)
    if (!token) {
      try {
        const res = spawnSync('gh', ['auth', 'token'], {
          encoding: 'utf-8',
          timeout: 2000,
          stdio: ['ignore', 'pipe', 'ignore'],
        });
        token = res.stdout ? res.stdout.trim() : '';
      } catch {}
    }

    return token;
  }
}
