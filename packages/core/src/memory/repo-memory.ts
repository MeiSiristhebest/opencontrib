import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type { RepoMemoryEntry } from '../contracts/schemas.js';
import { writeAtomic } from '../run/artifact-bundle.js';

export interface ContributionSubmissionInput {
  prUrl: string;
  title: string;
  prNumber?: number;
  issueNumber?: number;
}

export class RepoMemoryLedger {
  private memoryFilePath: string;
  private cache: Map<string, RepoMemoryEntry> = new Map();

  constructor(customDir?: string) {
    const dir = customDir || join(homedir(), '.opencontrib');
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
      writeAtomic(this.memoryFilePath, JSON.stringify(entries, null, 2));
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

  getMemoryReport(): RepoMemoryEntry[] {
    return Array.from(this.cache.values());
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

  /**
   * Record that a PR has been opened/submitted.
   * Does NOT mark as merged.
   */
  recordSubmission(repoFullName: string, contrib: ContributionSubmissionInput): void {
    const entry = this.getMemory(repoFullName);
    const existing = entry.successfulContributions.find(
      (c) => (contrib.prNumber && c.prNumber === contrib.prNumber) || c.prUrl === contrib.prUrl,
    );

    if (existing) {
      existing.status = 'submitted';
      existing.title = contrib.title;
      existing.submittedAt = existing.submittedAt || new Date().toISOString();
    } else {
      entry.successfulContributions.push({
        ...contrib,
        status: 'submitted',
        submittedAt: new Date().toISOString(),
      });
    }

    this.cache.set(repoFullName, entry);
    this.save();
  }

  /**
   * Record that a submitted PR has been genuinely merged into upstream.
   */
  recordMerge(repoFullName: string, prNumberOrUrl: number | string): void {
    const entry = this.getMemory(repoFullName);
    const target = entry.successfulContributions.find(
      (c) => (typeof prNumberOrUrl === 'number' ? c.prNumber === prNumberOrUrl : c.prUrl === prNumberOrUrl),
    );

    const now = new Date().toISOString();
    if (target) {
      target.status = 'merged';
      target.mergedAt = now;
    } else {
      entry.successfulContributions.push({
        prUrl: typeof prNumberOrUrl === 'string' ? prNumberOrUrl : `https://github.com/${repoFullName}/pull/${prNumberOrUrl}`,
        prNumber: typeof prNumberOrUrl === 'number' ? prNumberOrUrl : undefined,
        title: `PR #${prNumberOrUrl}`,
        status: 'merged',
        submittedAt: now,
        mergedAt: now,
      });
    }

    this.cache.set(repoFullName, entry);
    this.save();
  }

  /**
   * Record that a submitted PR was closed without merge.
   */
  recordClose(repoFullName: string, prNumberOrUrl: number | string, reason?: string): void {
    const entry = this.getMemory(repoFullName);
    const target = entry.successfulContributions.find(
      (c) => (typeof prNumberOrUrl === 'number' ? c.prNumber === prNumberOrUrl : c.prUrl === prNumberOrUrl),
    );

    if (target) {
      target.status = 'closed';
      target.closedAt = new Date().toISOString();
    }

    if (reason) {
      this.recordFailure(repoFullName, `PR Closed: ${reason}`, typeof prNumberOrUrl === 'string' ? prNumberOrUrl : `PR #${prNumberOrUrl}`);
    } else {
      this.cache.set(repoFullName, entry);
      this.save();
    }
  }

  /**
   * Record review state (e.g. changes requested or approved).
   */
  recordReview(repoFullName: string, prNumberOrUrl: number | string, state: 'changes_requested' | 'in_review'): void {
    const entry = this.getMemory(repoFullName);
    const target = entry.successfulContributions.find(
      (c) => (typeof prNumberOrUrl === 'number' ? c.prNumber === prNumberOrUrl : c.prUrl === prNumberOrUrl),
    );

    if (target) {
      target.status = state;
      this.cache.set(repoFullName, entry);
      this.save();
    }
  }

  /**
   * Backward-compatible alias for recordSubmission.
   */
  recordSuccess(repoFullName: string, contrib: ContributionSubmissionInput): void {
    this.recordSubmission(repoFullName, contrib);
  }

  getAllEntries(): RepoMemoryEntry[] {
    return Array.from(this.cache.values());
  }
}
