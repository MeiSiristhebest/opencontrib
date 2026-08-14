import { z, type ZodSchema } from 'zod';

export interface LLMProvider {
  complete(prompt: string, systemPrompt?: string): Promise<string>;
}

export class MockOrDirectLLMProvider implements LLMProvider {
  private fallbackHandler?: (prompt: string) => Promise<string>;

  constructor(fallbackHandler?: (prompt: string) => Promise<string>) {
    this.fallbackHandler = fallbackHandler;
  }

  async complete(prompt: string, systemPrompt?: string): Promise<string> {
    if (this.fallbackHandler) {
      return this.fallbackHandler(prompt);
    }
    // Return structured default if no live LLM key provided
    return '{}';
  }
}

export class LLMService {
  private provider: LLMProvider;

  constructor(provider?: LLMProvider) {
    this.provider = provider || new MockOrDirectLLMProvider();
  }

  async parseStructuredOutput<T>(
    rawText: string,
    schema: ZodSchema<T>,
    repairAttempt = 0,
  ): Promise<{ data: T; isRepaired: boolean }> {
    try {
      // 1. Extract JSON block if enclosed in markdown
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
        // Attempt automated repair prompt loop
        const repairPrompt = `The previous output did not strictly conform to the expected schema.\nError: ${err.message}\nPlease fix and output valid JSON conforming strictly to the requested schema.\nRaw Output:\n${rawText}`;
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
