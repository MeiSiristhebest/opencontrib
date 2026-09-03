import type { LLMProvider } from '../llm/llm-service.js';

/**
 * TEST-ONLY Mock LLM Provider.
 *
 * ⚠️ This module lives under `testkit/` and MUST NOT be wired into any production
 * code path. The governance engine is an anti-fabrication gate (Exit Code 2 hard
 * gate); shipping a provider that returns hard-coded confidence scores of ~94 would
 * silently defeat that gate. Use `MockLLMProvider` only in isolated test environments.
 *
 * The `LLMService` constructor refuses this provider when `NODE_ENV === 'production'`.
 */

export class MockLLMProvider implements LLMProvider {
  private fallbackHandler?: (prompt: string) => Promise<string>;

  constructor(fallbackHandler?: (prompt: string) => Promise<string>) {
    this.fallbackHandler = fallbackHandler;
  }

  async complete(prompt: string, _systemPrompt?: string): Promise<string> {
    if (this.fallbackHandler) {
      return this.fallbackHandler(prompt);
    }

    // 1. Subagent Review Evaluation
    if (
      prompt.includes('SubagentReviewEvaluationSchema') ||
      prompt.includes('Maintainer Reviewer') ||
      prompt.includes('Maintainer/Security/QA') ||
      prompt.includes('confidence breakdown') ||
      prompt.includes('confidenceBreakdown') ||
      prompt.includes('maintainerPerspective')
    ) {
      return JSON.stringify({
        maintainerPerspective: {
          acceptanceLikelihood: 'HIGH',
          styleConformance: 'Conforms to repository standards',
          concerns: [],
        },
        securityPerspective: {
          vulnerabilitiesDetected: false,
          findings: [],
        },
        qaPerspective: {
          testAdequacy: 'Comprehensive test plan',
          flakyRisk: 'Low',
        },
        confidenceBreakdown: {
          rootCause: 94,
          implementation: 93,
          regression: 91,
          defensiveCoverage: 89,
          testCoverage: 92,
          styleMatch: 95,
          securityAudit: 94,
        },
      });
    }

    // 2. Patch Draft
    if (
      prompt.includes('PatchDraftSchema') ||
      prompt.includes('surgical patch') ||
      prompt.includes('targetFiles') ||
      prompt.includes('Generate patch') ||
      prompt.includes('generate a minimal surgical patch')
    ) {
      return JSON.stringify({
        title: 'fix: address issue with surgical patch',
        summary: 'Surgical bugfix addressing root cause.',
        rationale: 'Minimal surgical patch adhering to style rules.',
        targetFiles: [{ path: 'src/index.ts', reason: 'Primary implementation' }],
        files: [
          {
            path: 'src/index.ts',
            operation: 'MODIFY',
            content: '// Surgical bugfix patch\n',
            explanation: 'Surgical fix.',
          },
        ],
        implementationSteps: ['Apply fix', 'Run tests'],
        regressionTestPlan: ['Run regression tests'],
        estimatedDiffLines: 12,
      });
    }

    return '{}';
  }
}
