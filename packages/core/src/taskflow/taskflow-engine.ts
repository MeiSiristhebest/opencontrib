import type { PointerStub, PluginHostContract } from '../kernel/contract.js';
import { defaultTaskActionRegistry, TaskActionRegistry } from './taskflow-registry.js';

export type TaskflowStepStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED' | 'SKIPPED';

export interface TaskflowStepSpec {
  id: string;
  name: string;
  action: string;
  parameters?: Record<string, any>;
}

export interface TaskflowStepResult {
  stepId: string;
  status: TaskflowStepStatus;
  output?: any;
  error?: string;
  durationMs: number;
}

export interface TaskflowExecutionReport {
  flowId: string;
  repoPath: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  stepResults: TaskflowStepResult[];
  totalDurationMs: number;
}

/**
 * Taskflow Runner (Declarative Multi-Agent Workflow Orchestrator)
 * Uses Strategy Pattern (TaskActionRegistry) conforming to OCP.
 */
export class TaskflowRunner {
  /**
   * Executes a declarative taskflow pipeline against a repository
   */
  public static async executeFlow(
    flowId: string,
    repoPath: string,
    steps: TaskflowStepSpec[],
    host: PluginHostContract,
    initialFinding?: PointerStub,
    registry: TaskActionRegistry = defaultTaskActionRegistry,
  ): Promise<TaskflowExecutionReport> {
    const startTime = Date.now();
    const stepResults: TaskflowStepResult[] = [];
    let currentFinding = initialFinding;

    for (const step of steps) {
      const stepStart = Date.now();
      try {
        const handler = registry.get(step.action);
        if (!handler) {
          throw new Error(`Unregistered task action: "${step.action}"`);
        }

        const res = await handler.execute({
          flowId,
          repoPath,
          host,
          currentFinding,
          parameters: step.parameters,
        });

        if (res.updatedFinding) {
          currentFinding = res.updatedFinding;
        }

        stepResults.push({
          stepId: step.id,
          status: 'SUCCESS',
          output: res.output,
          durationMs: Date.now() - stepStart,
        });
      } catch (err: any) {
        stepResults.push({
          stepId: step.id,
          status: 'FAILED',
          error: err.message,
          durationMs: Date.now() - stepStart,
        });
      }
    }

    const hasFail = stepResults.some((s) => s.status === 'FAILED');
    return {
      flowId,
      repoPath,
      status: hasFail ? 'PARTIAL' : 'SUCCESS',
      stepResults,
      totalDurationMs: Date.now() - startTime,
    };
  }
}

// Backward Compatibility Alias
export const TaskflowEngine = TaskflowRunner;
