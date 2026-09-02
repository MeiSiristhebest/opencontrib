import { beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { LLMService, MockLLMProvider, MockOrDirectLLMProvider } from '../src/llm/llm-service.js';
import { PatchDraftSchema } from '../src/contracts/llm-schemas.js';
import { AgentOrchestrator } from '../src/orchestration/agent-orchestrator.js';
import { OpenContribStorage } from '../src/storage/storage-layout.js';

describe('Agent Orchestrator Pipeline & Schema-First LLM Service', () => {
  beforeAll(() => {
    // Seed cached repo for bytedance/flowgram.ai so tests run completely offline and network-resilient
    const storage = OpenContribStorage.getInstance();
    const dirs = [
      join(storage.getHomeDir(), 'repos', 'bytedance__flowgram.ai'),
      join(storage.getHomeDir(), 'repos', 'bytedance/flowgram.ai'),
    ];
    for (const cachedDir of dirs) {
      if (!existsSync(join(cachedDir, '.git')) && !existsSync(join(cachedDir, 'HEAD'))) {
        mkdirSync(cachedDir, { recursive: true });
        spawnSync('git', ['init', '-b', 'main'], { cwd: cachedDir });
        spawnSync('git', ['config', 'user.name', 'Tester'], { cwd: cachedDir });
        spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: cachedDir });
        writeFileSync(join(cachedDir, 'package.json'), JSON.stringify({ name: 'flowgram.ai', version: '1.0.0' }));
        spawnSync('git', ['add', '.'], { cwd: cachedDir });
        spawnSync('git', ['commit', '-m', 'Initial commit'], { cwd: cachedDir });
      }
    }
  });

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

  const mockOpportunity = {
    repoFullName: 'bytedance/flowgram.ai',
    repoStars: 1200,
    issueNumber: 42,
    title: 'fix(tooling): clean up listeners on unmount',
    url: 'https://github.com/bytedance/flowgram.ai/issues/42',
    body: 'Fix memory leak by cleaning up event listeners on unmount',
    labels: ['good first issue', 'typescript'],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    matchScore: 85,
    rawScore: 85,
    adjustedScore: 85,
    rankScore: 85,
    diversityPenalty: 0,
    feasibility: {
      level: 'fully_feasible' as const,
      scorePenalty: 0,
      scope: 'small_code_change' as const,
      detectedRisks: [],
      missingCapabilities: [],
      mitigations: [],
      rationale: 'Self-contained code fix',
    },
    qualification: {
      isQualified: true,
      track: 'fast_track' as const,
      hasExistingPr: false,
      hasClaimant: false,
      authorFirstRightActive: false,
      inspectedCommentsCount: 0,
      botRules: [],
    },
    estimatedWorkload: '30m-1h',
    coreDemand: 'Fix memory leak in listeners',
    discoveryMode: 'targeted_repo' as const,
    matchedSignals: ['typescript', 'tooling'],
  };

  it('runs full AgentOrchestrator contribution pipeline with explicit MockLLMProvider in dry_run mode', async () => {
    const mockLlm = new LLMService(new MockLLMProvider());
    const orchestrator = new AgentOrchestrator({
      policy: {
        mode: 'dry_run',
        allowRealPr: false,
        autoPurgeSandboxOnFinish: true,
      },
      llmService: mockLlm,
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
      seedOpportunities: [mockOpportunity],
    });

    expect(result.status).toBe('DRY_RUN_COMPLETED');
    expect(result.stage).toBe('COMPLETED');
    expect(result.selectedOpportunity).toBeDefined();
    expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(result.patchDraft).toBeDefined();

    expect(result.appliedFiles).toBeDefined();
    expect(result.subagentReview).toBeDefined();
    expect(result.reportSummary).toContain('Dry run completed');
  }, { timeout: 60000 });

  it('pauses at HUMAN_GATE when humanApproved is false in interactive mode', async () => {
    const mockLlm = new LLMService(new MockLLMProvider());
    const orchestrator = new AgentOrchestrator({
      policy: {
        mode: 'interactive',
        allowRealPr: false,
      },
      llmService: mockLlm,
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
      seedOpportunities: [mockOpportunity],
    });

    expect(result.status).toBe('HUMAN_APPROVAL_REQUIRED');
    expect(result.stage).toBe('HUMAN_GATE');
    expect(result.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(result.reportSummary).toContain('Awaiting human');

  }, { timeout: 60000 });

  it('strictly blocks execution when no LLM provider is configured (no fake patches)', async () => {
    const orchestratorWithoutLlm = new AgentOrchestrator({
      policy: {
        mode: 'dry_run',
        allowRealPr: false,
      },
    });

    const result = await orchestratorWithoutLlm.runPipeline({
      profile: {
        techStack: ['typescript', 'react'],
        proficiency: 'intermediate',
        focusAreas: ['tooling', 'dx'],
        minMatchScore: 50,
      },
      targetRepo: 'bytedance/flowgram.ai',
      humanApproved: true,
      seedOpportunities: [mockOpportunity],
    });

    expect(result.status).toBe('BLOCKED');
    expect(result.stage).toBe('PATCH_DESIGN');
    expect(result.reportSummary).toContain('Pipeline halted');
  }, 60000);
});
