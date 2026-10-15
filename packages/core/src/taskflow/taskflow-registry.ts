import type { PointerStub, PluginHostContract } from '../kernel/contract.js';
import type { NormalizedFinding } from '../probe/types.js';
import { VariantHunter } from '../forensics/variant-hunting.js';
import { ThreeDimensionalTestGenerator } from '../testing/three-dim-test-gen.js';
import { verifyFindingAdversarially } from '../probe/adapters/piolium.js';
import { AutonomousPoCVerifier } from '../sandbox/poc-verifier.js';

export interface TaskflowExecutionContext {
  flowId: string;
  repoPath: string;
  host: PluginHostContract;
  currentFinding?: PointerStub;
  parameters?: Record<string, any>;
}

export interface TaskStepOutput {
  output?: any;
  updatedFinding?: PointerStub;
}

export interface TaskActionHandler {
  execute(ctx: TaskflowExecutionContext): Promise<TaskStepOutput>;
}

/**
 * Task Action Strategy Registry (Adheres strictly to OCP - Open/Closed Principle)
 * Allows registering custom auditing, triage, and verification actions without modifying engine code.
 */
export class TaskActionRegistry {
  private handlers = new Map<string, TaskActionHandler>();

  constructor() {
    this.registerBuiltinHandlers();
  }

  public register(action: string, handler: TaskActionHandler): void {
    this.handlers.set(action, handler);
  }

  public get(action: string): TaskActionHandler | undefined {
    return this.handlers.get(action);
  }

  public has(action: string): boolean {
    return this.handlers.has(action);
  }

  private registerBuiltinHandlers(): void {
    this.register('probe_scan', {
      execute: async (ctx) => {
        try {
          const specifiedProbes = ctx.parameters?.probes;
          const allProbes = typeof (ctx.host as any).listAll === 'function' ? (ctx.host as any).listAll() : [];
          const probesToRun = Array.isArray(specifiedProbes)
            ? allProbes.filter((p: any) => specifiedProbes.includes(p.name || p.id))
            : allProbes;
          const scanRes = typeof (ctx.host as any).executeScan === 'function'
            ? await (ctx.host as any).executeScan(ctx.repoPath, probesToRun)
            : { pointersCreated: [] };

          const firstFinding = scanRes.pointersCreated && scanRes.pointersCreated.length > 0 ? scanRes.pointersCreated[0] : undefined;
          return {
            output: { findingsCount: scanRes.pointersCreated ? scanRes.pointersCreated.length : 0 },
            updatedFinding: firstFinding,
          };
        } catch (err: any) {
          return {
            output: { findingsCount: 0, warning: err.message },
          };
        }
      },
    });

    this.register('context_bundle', {
      execute: async (ctx) => {
        if (ctx.currentFinding) {
          return {
            output: { bundleId: `bundle-${ctx.currentFinding.id}`, targetFile: ctx.currentFinding.file },
          };
        }
        return { output: { skipped: true, reason: 'No finding to bundle' } };
      },
    });

    this.register('variant_hunt', {
      execute: async (ctx) => {
        if (!ctx.currentFinding) {
          return { output: { variantsSearched: false, count: 0, reason: 'No finding to hunt variants for' } };
        }
        try {
          const variants = await VariantHunter.huntVariants(ctx.repoPath, ctx.currentFinding, ctx.host);
          return {
            output: {
              variantsSearched: true,
              sourceFindingId: ctx.currentFinding.id,
              count: variants.length,
              variants,
            },
          };
        } catch (err: any) {
          return {
            output: { variantsSearched: false, error: err.message },
          };
        }
      },
    });

    this.register('generate_3d_tests', {
      execute: async (ctx) => {
        if (!ctx.currentFinding) {
          return { output: { suiteGenerated: false, reason: 'No finding to generate tests for' } };
        }
        try {
          const file = ctx.currentFinding.file || '';
          let lang: 'typescript' | 'go' | 'python' = 'typescript';
          if (file.endsWith('.go')) lang = 'go';
          else if (file.endsWith('.py')) lang = 'python';

          const suite = ThreeDimensionalTestGenerator.generateSuite(ctx.currentFinding, lang);
          return {
            output: {
              suiteGenerated: true,
              language: lang,
              targetSymbol: suite.targetSymbol,
              testFileSuggestedName: suite.testFileSuggestedName,
              testCasesCount: suite.testCases.length,
              renderedCode: suite.renderedCode,
            },
          };
        } catch (err: any) {
          return {
            output: { suiteGenerated: false, error: err.message },
          };
        }
      },
    });

    this.register('verify_sandbox', {
      execute: async (ctx) => {
        if (!ctx.currentFinding) {
          return { output: { verified: false, reason: 'No finding to verify' } };
        }
        try {
          const steps = ctx.currentFinding.evidence?.verificationSteps ||
            (ctx.currentFinding.verificationStep ? [ctx.currentFinding.verificationStep] : []);

          let pocReport: any = undefined;
          if (steps.length > 0 && ctx.repoPath) {
            try {
              pocReport = await AutonomousPoCVerifier.verifyFinding(
                ctx.repoPath,
                ctx.currentFinding,
                { testCommand: ctx.currentFinding.evidence?.executionCommand },
              );
            } catch (pocErr: any) {
              pocReport = { status: 'FAILED', error: pocErr.message };
            }
          }

          let executionResult: { output?: string; error?: string; passed?: boolean } | undefined;

          if (ctx.currentFinding.evidence?.executionCommand && typeof (ctx.host as any).exec === 'function') {
            try {
              const res = await (ctx.host as any).exec(ctx.currentFinding.evidence.executionCommand, {
                cwd: ctx.repoPath,
                timeout: 15000,
              });
              executionResult = {
                output: res.stdout,
                error: res.stderr,
                passed: true,
              };
            } catch (execErr: any) {
              executionResult = {
                output: execErr.stdout,
                error: execErr.message || String(execErr),
                passed: false,
              };
            }
          }

          const normalized: NormalizedFinding = {
            id: ctx.currentFinding.id,
            probeName: ctx.currentFinding.legacyId || 'finding',
            category: ctx.currentFinding.category,
            title: ctx.currentFinding.title,
            description: ctx.currentFinding.slice?.codeSnippet || '',
            file: ctx.currentFinding.file,
            line: ctx.currentFinding.line,
            severity: ctx.currentFinding.severity,
            prPotentialScore: ctx.currentFinding.confidence || 80,
          };
          const adversarialVerdict = verifyFindingAdversarially(normalized);

          // Base verified status on actual PoC execution and command result
          let isVerified = !adversarialVerdict.isFalsePositive;
          if (pocReport) {
            isVerified = isVerified && pocReport.status === 'VERIFIED';
          } else if (executionResult) {
            isVerified = isVerified && executionResult.passed === true;
          }

          return {
            output: {
              verified: isVerified,
              verdict: adversarialVerdict.verdict,
              confidenceScore: adversarialVerdict.confidenceScore,
              counterArguments: adversarialVerdict.counterArguments,
              stepsCount: steps.length,
              pocReport,
              executionResult,
            },
          };
        } catch (err: any) {
          return {
            output: { verified: false, error: err.message },
          };
        }
      },
    });
  }
}

export const defaultTaskActionRegistry = new TaskActionRegistry();
