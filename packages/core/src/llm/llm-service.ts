import { z, type ZodSchema } from 'zod';

export interface LLMProvider {
  complete(prompt: string, systemPrompt?: string): Promise<string>;
}

export interface OpenAICompatibleProviderOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  defaultHeaders?: Record<string, string>;
  timeoutMs?: number;
}

/**
 * Production-Grade OpenAI-Compatible LLM Provider.
 * Connects to live LLM endpoints (OpenAI, DeepSeek, Claude, Ollama, etc.) with timeout and error handling.
 */
export class OpenAICompatibleProvider implements LLMProvider {
  private apiKey: string;
  private baseURL: string;
  private model: string;
  private defaultHeaders: Record<string, string>;
  private timeoutMs: number;

  constructor(options: OpenAICompatibleProviderOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.OPENAI_API_KEY ||
      process.env.LLM_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      '';
    this.baseURL = (options.baseURL || process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
    this.model = options.model || process.env.LLM_MODEL || 'gpt-4o';
    this.defaultHeaders = options.defaultHeaders || {};
    this.timeoutMs = options.timeoutMs || 90_000;
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        'OpenAICompatibleProvider: Missing API key. Please set OPENAI_API_KEY, LLM_API_KEY, or pass apiKey explicitly.',
      );
    }

    const messages: Array<{ role: string; content: string }> = [];
    if (systemPrompt) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: prompt });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const endpoint = `${this.baseURL}/chat/completions`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
          ...this.defaultHeaders,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorBody = await response.text().catch(() => '');
        throw new Error(`LLM API request failed with status ${response.status}: ${errorBody}`);
      }

      const data = (await response.json()) as any;
      const content = data?.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error('LLM API returned empty response content.');
      }
      return content;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        throw new Error(`LLM API request timed out after ${this.timeoutMs}ms.`);
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

/**
 * Mock LLM Provider strictly for testing or offline simulations.
 * Must be explicitly instantiated or opted-in; never silently masquerades in production.
 */
export class MockLLMProvider implements LLMProvider {
  private fallbackHandler?: (prompt: string) => Promise<string>;

  constructor(fallbackHandler?: (prompt: string) => Promise<string>) {
    this.fallbackHandler = fallbackHandler;
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
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

// Backward compatibility alias for legacy tests
export const MockOrDirectLLMProvider = MockLLMProvider;

export class LLMService {
  private provider: LLMProvider;

  constructor(provider?: LLMProvider) {
    if (provider) {
      this.provider = provider;
    } else if (process.env.OPENAI_API_KEY || process.env.LLM_API_KEY || process.env.ANTHROPIC_API_KEY) {
      this.provider = new OpenAICompatibleProvider();
    } else {
      throw new Error(
        'LLMService: No LLM Provider configured. Pass an explicit provider (e.g. new OpenAICompatibleProvider() or new MockLLMProvider() in tests) or set OPENAI_API_KEY / LLM_API_KEY.',
      );
    }
  }


  getProvider(): LLMProvider {
    return this.provider;
  }

  async parseStructuredOutput<T>(
    rawText: string,
    schema: ZodSchema<T>,
    repairAttempt = 0,
  ): Promise<{ data: T; isRepaired: boolean }> {
    try {
      let jsonString = rawText.trim();
      const codeBlockMatch = jsonString.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
      if (codeBlockMatch) {
        jsonString = codeBlockMatch[1];
      }

      const parsed = JSON.parse(jsonString);
      const validated = schema.parse(parsed);
      return { data: validated, isRepaired: repairAttempt > 0 };
    } catch (err: any) {
      if (repairAttempt < 2) {
        const repairPrompt = `The previous output did not strictly conform to the expected JSON schema.\nError: ${err.message}\nPlease fix and output valid JSON conforming strictly to schema.\nRaw Output:\n${rawText}`;
        const repairedText = await this.provider.complete(repairPrompt);
        return this.parseStructuredOutput(repairedText, schema, repairAttempt + 1);
      }
      throw new Error(`Schema validation and repair failed: ${err.message}`);
    }
  }

  async generateStructured<T>(input: {
    prompt: string;
    systemPrompt?: string;
    schema: ZodSchema<T>;
  }): Promise<{ data: T; isRepaired: boolean }> {
    const rawResponse = await this.provider.complete(input.prompt, input.systemPrompt);
    return this.parseStructuredOutput(rawResponse, input.schema);
  }
}
