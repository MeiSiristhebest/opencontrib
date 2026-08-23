import { spawn, spawnSync } from 'child_process';
import type { ProbeDescriptor, HostServices, PointerStub } from './contract.js';
import type { SmartPointerStore } from './pointer-store.js';

const binaryCache = new Map<string, boolean>();

export interface ScanSchedulerResult {
  target: string;
  timestamp: string;
  executedProbes: string[];
  pointersCreated: PointerStub[];
}

function execWithSpawn(cmd: string, opts: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  const cwd = opts.cwd || process.cwd();
  return new Promise((resolve, reject) => {
    const isWindows = process.platform === 'win32';
    const shell = isWindows ? 'cmd.exe' : 'sh';
    const shellArgs = isWindows ? ['/c', cmd] : ['-c', cmd];
    const child = spawn(shell, shellArgs, {
      cwd,
      timeout: opts.timeout || 30000,
      encoding: 'utf-8',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code: number | null, _signal: string | null) => {
      if (code !== 0) {
        reject(new Error(stderr || `Command exited with code ${code}: ${cmd}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
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
        return execWithSpawn(cmd, { ...opts, cwd });
      },
      log: () => {},
      isBinaryAvailable: (bin: string) => {
        if (binaryCache.has(bin)) return binaryCache.get(bin)!;
        try {
          const isWindows = process.platform === 'win32';
          const cmd = isWindows ? 'where.exe' : 'command';
          const args = isWindows ? ['-q', bin] : ['-v', bin];
          const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000 });
          binaryCache.set(bin, result.status === 0);
          return result.status === 0;
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
