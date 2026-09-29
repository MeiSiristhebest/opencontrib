import { describe, expect, it } from 'bun:test';
import { ContributionPipeline } from '../src/application/index.js';
import type { AgentOrchestrator } from '../src/orchestration/agent-orchestrator.js';

describe('application/ ContributionPipeline (shared use-case facade)', () => {
  it('is constructable and exposes a run() method (the single CLI/MCP entry point)', () => {
    const pipeline = new ContributionPipeline();
    expect(typeof pipeline.run).toBe('function');
  });

  it('run() returns the orchestrator Promise and forwards the input (the shared seam)', () => {
    const input: Parameters<AgentOrchestrator['runPipeline']>[0] = {
      profile: { techStack: ['typescript'], proficiency: 'intermediate', focusAreas: [], minMatchScore: 50 },
      targetRepo: 'example/repo',
    };
    const runPromise = Promise.resolve(undefined as never);
    let receivedInput: typeof input | undefined;
    const orchestrator: Pick<AgentOrchestrator, 'runPipeline'> = {
      runPipeline(received) {
        receivedInput = received;
        return runPromise;
      },
    };
    const pipeline = new ContributionPipeline({}, orchestrator);

    expect(pipeline.run(input)).toBe(runPromise);
    expect(receivedInput).toBe(input);
  });
});
