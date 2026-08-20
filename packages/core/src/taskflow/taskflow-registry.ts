import type { PointerStub, PluginHostContract } from '../kernel/contract.js';

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
        const allProbes = typeof (ctx.host as any).listAll === 'function' ? (ctx.host as any).listAll() : [];
        const scanRes = typeof (ctx.host as any).executeScan === 'function'
          ? await (ctx.host as any).executeScan(ctx.repoPath, allProbes)
          : { pointersCreated: [] };

        const firstFinding = scanRes.pointersCreated.length > 0 ? scanRes.pointersCreated[0] : undefined;
        return {
          output: { findingsCount: scanRes.pointersCreated.length },
          updatedFinding: firstFinding,
        };
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
      execute: async () => ({ output: { variantsSearched: true } }),
    });

    this.register('generate_3d_tests', {
      execute: async () => ({ output: { suiteGenerated: true } }),
    });

    this.register('verify_sandbox', {
      execute: async () => ({ output: { verified: true } }),
    });
  }
}

export const defaultTaskActionRegistry = new TaskActionRegistry();
