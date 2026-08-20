import { execSync, exec } from 'child_process';
import { promisify } from 'util';
import type { ProbeDescriptor, HostServices, PointerStub } from './contract.js';
import type { SmartPointerStore } from './pointer-store.js';

const execAsync = promisify(exec);
const binaryCache = new Map<string, boolean>();

export interface ScanSchedulerResult {
  target: string;
  timestamp: string;
  executedProbes: string[];
  pointersCreated: PointerStub[];
}

/**
 * Probe Scan Scheduler (Adheres strictly to SRP - Single Responsibility Principle)
 * Dedicated solely to coordinating concurrent/sequential probe execution, timeout boundaries, and pointer persistence.
 */
export class ProbeScanScheduler {
  /**
   * Executes a collection of probes against a target path and persists findings in the pointer store
   */
  public static async executeScan(
    targetPath: string,
    probesToRun: ProbeDescriptor[],
    store: SmartPointerStore,
  ): Promise<ScanSchedulerResult> {
    const executed: string[] = [];
    const beforeCount = store.list().length;

    const hostServices: HostServices = {
      workspacePath: targetPath,
      exec: async (cmd: string, opts = {}) => {
        const cwd = opts.cwd || targetPath;
        const { stdout, stderr } = await execAsync(cmd, {
          cwd,
          timeout: opts.timeout || 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr };
      },
      log: () => {},
      isBinaryAvailable: (bin: string) => {
        if (binaryCache.has(bin)) return binaryCache.get(bin)!;
        try {
          const isWindows = process.platform === 'win32';
          const checkCmd = isWindows ? `where.exe ${bin}` : `which ${bin}`;
          execSync(checkCmd, { stdio: 'ignore' });
          binaryCache.set(bin, true);
          return true;
        } catch {
          binaryCache.set(bin, false);
          return false;
        }
      },
    };

    for (const probe of probesToRun) {
      executed.push(probe.id);
      try {
        await probe.scan(targetPath, store, hostServices);
      } catch (err: any) {
        console.error(`[ProbeScanScheduler] Probe "${probe.id}" scan error:`, err.message);
      }
    }

    const allPointers = store.list();
    const newPointers = allPointers.slice(beforeCount);

    return {
      target: targetPath,
      timestamp: new Date().toISOString(),
      executedProbes: executed,
      pointersCreated: newPointers.map((p) => p.stub),
    };
  }
}
