/**
 * ResponseCache port.
 *
 * A minimal key/value cache for GitHub API responses. Extracted as a port so
 * the file-backed implementation can be swapped for an in-memory or
 * remote-cache double in tests (architecture review §6 DIP, §16 stage 5).
 */
export interface ResponseCache {
  get<T>(key: string): T | null;
  set<T>(key: string, payload: T): void;
}
