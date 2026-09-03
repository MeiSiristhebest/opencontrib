/**
 * Application (use-case) layer.
 *
 * This is the single, stable entry point for the product's use cases. The CLI
 * and the MCP server BOTH call through here — never the orchestrator internals
 * or the pipeline steps directly — so behavior is identical regardless of entry
 * point (architecture review §16 stage 3: "CLI 与 MCP 共用用例").
 *
 * The layer is intentionally free of infrastructure I/O — those concerns live
 * behind the injected ports. See `tests/architecture.test.ts`.
 */

import { AgentOrchestrator, type AgentOrchestratorOptions } from '../orchestration/agent-orchestrator.js';

/** Input contract for the contribution pipeline use case. */
export type RunContributionInput = Parameters<AgentOrchestrator['runPipeline']>[0];

/**
 * Shared facade for the autonomous contribution pipeline. CLI commands and MCP
 * tools construct this once and call `run` — the orchestrator, its pipeline
 * steps, and all injected ports remain an implementation detail behind it.
 */
export class ContributionPipeline {
  private orchestrator: AgentOrchestrator;

  constructor(options: AgentOrchestratorOptions = {}) {
    this.orchestrator = new AgentOrchestrator(options);
  }

  run(input: RunContributionInput): ReturnType<AgentOrchestrator['runPipeline']> {
    return this.orchestrator.runPipeline(input);
  }
}
