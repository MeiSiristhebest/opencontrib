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

import { GitHubClient } from "./discovery/github-client.js";
import { ContributionPipeline } from "./application/index.js";
import { SystemClock } from "./ports/clock.port.js";
import { LLMService } from "./llm/llm-service.js";
import { ContributionRunManager } from "./run/run-manager.js";
import { TrustedRunMaterializer } from "./run/trusted-run-host.js";
import { WorktreeManager } from "./workspace/worktree-manager.js";
import {
 ContributionPrService,
 GitHubSubmissionService,
 RemoteSubmissionBrokerClient,
 TrustedSubmissionBroker,
 type SubmissionPort,
} from "./github/index.js";
import type { GitHubClientOptions } from "./github/types.js";
import type {
 ApprovalArtifactVerifier,
 TrustedApprovalAuthority,
} from "./governance/approval-authority.js";

/** Production GitHub client with env-based credentials, file cache, and retry. */
export function buildProductionGitHubClient(
 options: GitHubClientOptions = {},
): GitHubClient {
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
class DeferredRemoteSubmissionPort implements SubmissionPort {
 private client?: RemoteSubmissionBrokerClient;
 constructor(
  private readonly runManager: ContributionRunManager,
  private readonly endpoint?: string,
 ) {}
 async submit(runId: string, expectedIntentSha256?: string) {
  this.client ??= new RemoteSubmissionBrokerClient({
   endpoint: this.endpoint,
   runManager: this.runManager,
  });
  return this.client.submit(runId, expectedIntentSha256);
 }
}

export function buildContributionPipeline(
 options: {
  /** Read-only GitHub credential for discovery; never used for provider writes. */
  githubReadToken?: string;
  /** @deprecated Use githubReadToken; this alias is read-only by construction. */
  githubToken?: string;
  githubHost?: string;
  submissionBrokerEndpoint?: string;
  llmService?: LLMService;
  approvalAuthority?: TrustedApprovalAuthority;
 } = {},
): ContributionPipeline {
 const client = buildProductionGitHubClient({
  token: options.githubReadToken ?? options.githubToken,
  host: options.githubHost,
 });
 const runManager = buildContributionRunManager();
 return new ContributionPipeline({
  githubReadToken: options.githubReadToken ?? options.githubToken,
  llmService: options.llmService,
  deps: {
   client,
   clock: new SystemClock(),
   runManager,
   submissionPort: new DeferredRemoteSubmissionPort(
    runManager,
    options.submissionBrokerEndpoint,
   ),
   approvalAuthority: options.approvalAuthority,
  },
 });
}

export interface ProductionCompositionRoot {
 githubClient: GitHubClient;
 contributionPipeline: ContributionPipeline;
 approvalAuthority?: TrustedApprovalAuthority;
}

/**
 * Build the provider-writing side of the trust boundary. This function belongs
 * in a separately deployed host process; agent-facing CLI/MCP code must use
 * RemoteSubmissionBrokerClient instead and must not receive its token.
 */
export function buildTrustedSubmissionBroker(options: {
 githubToken: string;
 githubHost?: string;
 approvalVerifier: ApprovalArtifactVerifier;
}): {
 githubClient: GitHubClient;
 runManager: ContributionRunManager;
 broker: TrustedSubmissionBroker;
} {
 const githubClient = buildProductionGitHubClient({
  token: options.githubToken,
  host: options.githubHost,
 });
 const runManager = buildContributionRunManager();
 const submissionService = new GitHubSubmissionService(
  new ContributionPrService(githubClient),
  githubClient,
  runManager,
  options.approvalVerifier,
 );
 const materializer = new TrustedRunMaterializer(
  runManager,
  new WorktreeManager(),
 );
 return {
  githubClient,
  runManager,
  broker: new TrustedSubmissionBroker(
   runManager,
   submissionService,
   materializer,
  ),
 };
}

/** Build the entire production object graph in one call. */
export function buildProductionCompositionRoot(
 options: {
  /** Read-only GitHub credential used by discovery adapters. */
  githubReadToken?: string;
  /** @deprecated read-only compatibility alias. */
  githubToken?: string;
  githubHost?: string;
  submissionBrokerEndpoint?: string;
  llmService?: LLMService;
  approvalAuthority?: TrustedApprovalAuthority;
 } = {},
): ProductionCompositionRoot {
 const githubClient = buildProductionGitHubClient({
  token: options.githubReadToken ?? options.githubToken,
  host: options.githubHost,
 });
 const runManager = buildContributionRunManager();
 const contributionPipeline = new ContributionPipeline({
  githubReadToken: options.githubReadToken ?? options.githubToken,
  llmService: options.llmService,
  deps: {
   client: githubClient,
   clock: new SystemClock(),
   runManager,
   submissionPort: new DeferredRemoteSubmissionPort(
    runManager,
    options.submissionBrokerEndpoint,
   ),
   approvalAuthority: options.approvalAuthority,
  },
 });
 return {
  githubClient,
  contributionPipeline,
  approvalAuthority: options.approvalAuthority,
 };
}
