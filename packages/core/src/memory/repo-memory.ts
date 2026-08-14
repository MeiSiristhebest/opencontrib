import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RepoMemoryEntry } from '../contracts/schemas.js';

export class RepoMemoryLedger {
  private memoryFilePath: string;
  private cache: Map<string, RepoMemoryEntry> = new Map();

  constructor() {
    const dir = join(homedir(), '.opencontrib');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.memoryFilePath = join(dir, 'repo-memory.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.memoryFilePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.memoryFilePath, 'utf-8'));
      if (Array.isArray(data)) {
        for (const entry of data) {
          this.cache.set(entry.repoFullName, entry);
        }
      }
    } catch {}
  }

  save(): void {
    const entries = Array.from(this.cache.values());
    try {
      writeFileSync(this.memoryFilePath, JSON.stringify(entries, null, 2), 'utf-8');
    } catch {}
  }

  getMemory(repoFullName: string): RepoMemoryEntry {
    return (
      this.cache.get(repoFullName) || {
        repoFullName,
        lastAnalyzedAt: new Date().toISOString(),
        conventions: {
          requiresDco: false,
          requiresAiDisclosure: false,
        },
        pastFailures: [],
        successfulContributions: [],
      }
    );
  }

  recordFailure(repoFullName: string, reason: string, context: string): void {
    const entry = this.getMemory(repoFullName);
    entry.pastFailures.push({
      date: new Date().toISOString(),
      reason,
      context,
    });
    this.cache.set(repoFullName, entry);
    this.save();
  }

  recordSuccess(repoFullName: string, contrib: { prUrl: string; title: string; prNumber?: number; issueNumber?: number }): void {
    const entry = this.getMemory(repoFullName);
    entry.successfulContributions.push({
      ...contrib,
      mergedAt: new Date().toISOString(),
    });
    this.cache.set(repoFullName, entry);
    this.save();
  }

  getAllEntries(): RepoMemoryEntry[] {
    return Array.from(this.cache.values());
  }
}
