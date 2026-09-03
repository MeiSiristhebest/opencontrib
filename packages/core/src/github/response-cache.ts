import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';
import { getOpenContribHome } from '../kernel/home.js';
import type { ResponseCache } from '../ports/response-cache.port.js';

const SCHEMA_VERSION = 'v4';

export interface FileResponseCacheOptions {
  host: string;
  apiVersion: string;
  tokenScope: string;
  ttlMs?: number;
}

/**
 * File-backed implementation of {@link ResponseCache}.
 *
 * Preserves the exact cache-identity and TTL semantics the monolithic
 * `GitHubClient` had: the key identity is
 * `<schema>_<host>_<apiVersion>_<tokenScope>_<key>` (so different tokens are
 * never cross-cached), entries expire after `ttlMs` (default 10 min), and
 * corrupt/empty files are silently evicted.
 */
export class FileResponseCache implements ResponseCache {
  private readonly cacheDir: string;
  private readonly ttlMs: number;
  private readonly identity: string;

  constructor(opts: FileResponseCacheOptions) {
    this.ttlMs = opts.ttlMs ?? 10 * 60 * 1000;
    this.identity = `${SCHEMA_VERSION}_${opts.host}_${opts.apiVersion}_${opts.tokenScope}`;

    const home = getOpenContribHome();
    const opencontribDir = home.endsWith('.opencontrib') ? home : join(home, '.opencontrib');
    this.cacheDir = join(opencontribDir, 'cache');
    if (!existsSync(this.cacheDir)) {
      mkdirSync(this.cacheDir, { recursive: true });
    }
  }

  private getCachePath(key: string): string {
    const identity = `${this.identity}_${key}`;
    const hash = createHash('sha256').update(identity).digest('hex');
    return join(this.cacheDir, `${hash}.json`);
  }

  get<T>(key: string): T | null {
    const filePath = this.getCachePath(key);
    if (!existsSync(filePath)) return null;

    try {
      const data = JSON.parse(readFileSync(filePath, 'utf-8'));
      if (!data || typeof data !== 'object' || typeof data.timestamp !== 'number') {
        try {
          unlinkSync(filePath);
        } catch {}
        return null;
      }
      if (Date.now() - data.timestamp < this.ttlMs) {
        return data.payload as T;
      }
    } catch {
      try {
        unlinkSync(filePath);
      } catch {}
    }
    return null;
  }

  set<T>(key: string, payload: T): void {
    const filePath = this.getCachePath(key);
    try {
      writeFileSync(filePath, JSON.stringify({ timestamp: Date.now(), payload }), 'utf-8');
    } catch {}
  }
}
