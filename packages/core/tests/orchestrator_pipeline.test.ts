import { describe, expect, it } from 'bun:test';
import { LLMService, MockOrDirectLLMProvider } from '../src/llm/llm-service.js';
import { PatchDraftSchema } from '../src/contracts/llm-schemas.js';
import { AgentOrchestrator } from '../src/orchestration/agent-orchestrator.js';

describe('Agent Orchestrator Pipeline & Schema-First LLM Service', () => {
  it('parses structured LLM output and validates against Zod schema', async () => {
    const validJson = JSON.stringify({
      title: 'fix(utils): prevent memory leak',
      summary: 'Clean up listener handles on component unmount',
      rationale: 'Avoid retain cycles in long lived views',
      targetFiles: [{ path: 'packages/utils/src/index.ts', reason: 'Primary fix' }],
      implementationSteps: ['Add dispose method', 'Clear timers'],
      regressionTestPlan: ['Run unit tests'],
      estimatedDiffLines: 15,
    });

    const llm = new LLMService(new MockOrDirectLLMProvider(async () => `\`\`\`json\n${validJson}\n\`\`\``));
    const result = await llm.generateStructured({
      prompt: 'Generate patch',
      schema: PatchDraftSchema,
    });

    expect(result.data.title).toBe('fix(utils): prevent memory leak');
    expect(result.data.estimatedDiffLines).toBe(15);
    expect(result.data.targetFiles.length).toBe(1);
  });

  it('runs full AgentOrchestrator contribution pipeline in dry_run mode', async () => {
    const orchestrator = new AgentOrchestrator({
      policy: {
        mode: 'dry_run',
        allowRealPr: false,
        autoPurgeSandboxOnFinish: true,
      },
    });

    const result = await orchestrator.runPipeline({
      profile: {
        techStack: ['typescript', 'react'],
        proficiency: 'intermediate',
        focusAreas: ['tooling', 'dx'],
        minMatchScore: 50,
      },
      targetRepo: 'bytedance/flowgram.ai',
      humanApproved: true,
    });

    expect(result.status).toBe('DRY_RUN_COMPLETED');
    expect(result.stage).toBe('COMPLETED');
    expect(result.selectedOpportunity).toBeDefined();
    expect(result.confidenceScore).toBeGreaterThanOrEqual(90);
    expect(result.patchDraft).toBeDefined();
    expect(result.appliedFiles).toBeDefined();
    expect(result.subagentReview).toBeDefined();
    expect(result.reportSummary).toContain('Dry run completed');
  }, 60000);

  it('pauses at HUMAN_GATE when humanApproved is false in interactive mode', async () => {
    const orchestrator = new AgentOrchestrator({
      policy: {
        mode: 'interactive',
        allowRealPr: false,
      },
    });

    const result = await orchestrator.runPipeline({
      profile: {
        techStack: ['typescript', 'react'],
        proficiency: 'intermediate',
        focusAreas: ['tooling', 'dx'],
        minMatchScore: 50,
      },
      targetRepo: 'bytedance/flowgram.ai',
      humanApproved: false,
    });

    expect(result.status).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(result.stage).toBe('HUMAN_GATE');
    expect(result.confidenceScore).toBeGreaterThanOrEqual(90);
    expect(result.reportSummary).toContain('Awaiting human');
  }, 60000);
});
