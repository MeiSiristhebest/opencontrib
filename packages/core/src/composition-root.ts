/**
 * Composition Root — the single place where the production object graph is wired.
 *
 * Per architecture review §16 stage 5, every concrete adapter (GitHub client,
 * LLM service, clocks, caches, state machines) is assembled HERE, behind the
 * ports defined in `./ports`. The orchestrator, CLI, and MCP server never
 * `new` up their own collaborators directly — they ask the composition root for
 * a fully-built, production-wired instance. This keeps the dependency graph
 * explicit, avoids scattered `new GitHubClient({ token: process.env.X })` calls,
 * and makes the system trivially testable (tests inject fakes via `PipelineDeps`).
 *
 * This module is the ONLY place that imports every concrete implementation
 * together; everything else depends on the abstract ports.
 */

import { GitHubClient } from './discovery/github-client.js';
import { ContributionPipeline } from './application/index.js';
import { SystemClock } from './ports/clock.port.js';
import { LLMService } from './llm/llm-service.js';
import { ContributionRunManager } from './run/run-manager.js';
import type { GitHubClientOptions } from './github/types.js';

/** Production GitHub client with env-based credentials, file cache, and retry. */
export function buildProductionGitHubClient(options: GitHubClientOptions = {}): GitHubClient {
  return new GitHubClient(options);
}

/**
 * Production ContributionRunManager. CLI commands call this inside their
 * action callbacks (never at module load time) so the manager is constructed
 * lazily and its injected Clock/IdGenerator/ActiveSession defaults resolve
 * correctly. Tests inject fakes via the constructor directly.
 */
export function buildContributionRunManager(): ContributionRunManager {
  return new ContributionRunManager();
}

/**
 * Production contribution-pipeline use case. Wires the GitHub client, the
 * system clock, and the resolved LLM service through the orchestrator's
 * dependency-injection seam (`PipelineDeps`). Callers may override any piece
 * via `deps` for tests or alternative environments.
 */
export function buildContributionPipeline(options: {
  githubToken?: string;
  githubHost?: string;
  llmService?: LLMService;
} = {}): ContributionPipeline {
  const client = buildProductionGitHubClient({
    token: options.githubToken,
    host: options.githubHost,
  });
  return new ContributionPipeline({
    githubToken: options.githubToken,
    llmService: options.llmService,
    deps: { client, clock: new SystemClock() },
  });
}

export interface ProductionCompositionRoot {
  githubClient: GitHubClient;
  contributionPipeline: ContributionPipeline;
}

/** Build the entire production object graph in one call. */
export function buildProductionCompositionRoot(options: {
  githubToken?: string;
  githubHost?: string;
  llmService?: LLMService;
} = {}): ProductionCompositionRoot {
  const githubClient = buildProductionGitHubClient({
    token: options.githubToken,
    host: options.githubHost,
  });
  const contributionPipeline = new ContributionPipeline({
    githubToken: options.githubToken,
    llmService: options.llmService,
    deps: { client: githubClient, clock: new SystemClock() },
  });
  return { githubClient, contributionPipeline };
}
