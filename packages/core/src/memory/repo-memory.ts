import { existsSync, mkdirSync, readFileSync } from 'fs';
import { homedir as osHomedir } from 'os';
import { join } from 'path';

function getOpenContribHome(): string {
  return process.env.OPENCONTRIB_HOME || osHomedir();
}

import type { RepoMemoryEntry } from '../contracts/schemas.js';
import { writeAtomic } from '../run/artifact-bundle.js';

export interface ContributionSubmissionInput {
  prUrl: string;
  title: string;
  prNumber?: number;
  issueNumber?: number;
  provenance?: {
    source: 'agent_claim' | 'github_verified' | 'system_recorded';
    verified: boolean;
    verifiedAt?: string;
  };
}

export class RepoMemoryLedger {
  private memoryFilePath: string;
  private cache: Map<string, RepoMemoryEntry> = new Map();

  constructor(customDir?: string) {
    const dir = customDir || join(getOpenContribHome(), '.opencontrib');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.memoryFilePath = join(dir, 'repo-memory.json');
    this.load();
  }

  private load(): void {
    if (!existsSync(this.memoryFilePath)) return;
    try {
      const data = JSON.parse(readFileSync(this.memoryFilePath, 'utf-8'));
      if (!Array.isArray(data)) {
        console.warn('[RepoMemory] Cache file is not an array, resetting');
        this.cache.clear();
        return;
      }
      for (const entry of data) {
        if (entry && typeof entry.repoFullName === 'string') {
          this.cache.set(entry.repoFullName, entry);
        } else {
          console.warn('[RepoMemory] Skipping entry with invalid repoFullName');
        }
      }
    } catch (err: any) {
      console.warn(`[RepoMemory] Failed to load cache: ${err.message}, resetting`);
      this.cache.clear();
    }
  }

  save(): void {
    const entries = Array.from(this.cache.values());
    try {
      writeAtomic(this.memoryFilePath, JSON.stringify(entries, null, 2));
    } catch (err: any) {
      console.error(`[RepoMemory] CRITICAL: Failed to persist memory to ${this.memoryFilePath}: ${err.message}`);
      throw err;
    }
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

  recordReflexionInsight(repoFullName: string, insight: { failureMode: string; rootCause: string; lessonsLearned: string[] }): void {
    const entry = this.getMemory(repoFullName);
    entry.pastFailures.push({
      date: new Date().toISOString(),
      reason: insight.failureMode,
      context: `${insight.rootCause} | Lessons: ${insight.lessonsLearned.join('; ')}`,
    });
    this.cache.set(repoFullName, entry);
    this.save();
  }


  /**
   * Record that a PR has been opened/submitted.
   * Differentiates unverified agent claim vs verified fact.
   */
  recordSubmission(repoFullName: string, contrib: ContributionSubmissionInput): void {
    const entry = this.getMemory(repoFullName);
    const existing = entry.successfulContributions.find(
      (c) => (contrib.prNumber && c.prNumber === contrib.prNumber) || c.prUrl === contrib.prUrl,
    );

    const prov = contrib.provenance || {
      source: 'agent_claim' as const,
      verified: false,
    };

    if (existing) {
      existing.status = 'submitted';
      existing.title = contrib.title;
      existing.provenance = prov;
      existing.submittedAt = existing.submittedAt || new Date().toISOString();
    } else {
      entry.successfulContributions.push({
        ...contrib,
        status: 'submitted',
        provenance: prov,
        submittedAt: new Date().toISOString(),
      });
    }

    this.cache.set(repoFullName, entry);
    this.save();
  }

  /**
   * Mark a contribution as verified through authoritative platform check.
   */
  verifyContribution(repoFullName: string, prNumberOrUrl: number | string): boolean {
    const entry = this.getMemory(repoFullName);
    const target = entry.successfulContributions.find(
      (c) => (typeof prNumberOrUrl === 'number' ? c.prNumber === prNumberOrUrl : c.prUrl === prNumberOrUrl),
    );

    if (target) {
      target.provenance = {
        source: 'github_verified',
        verified: true,
        verifiedAt: new Date().toISOString(),
      };
      this.cache.set(repoFullName, entry);
      this.save();
      return true;
    }
    return false;
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
      target.provenance = {
        source: 'github_verified',
        verified: true,
        verifiedAt: now,
      };
    } else {
      entry.successfulContributions.push({
        prUrl: typeof prNumberOrUrl === 'string' ? prNumberOrUrl : `https://github.com/${repoFullName}/pull/${prNumberOrUrl}`,
        prNumber: typeof prNumberOrUrl === 'number' ? prNumberOrUrl : undefined,
        title: `PR #${prNumberOrUrl}`,
        status: 'merged',
        provenance: {
          source: 'github_verified',
          verified: true,
          verifiedAt: now,
        },
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
   * Record review state (e.g. changes requested or in_review).
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
