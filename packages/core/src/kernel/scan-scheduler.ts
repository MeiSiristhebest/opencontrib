import { spawn, spawnSync } from 'child_process';
import type { ProbeDescriptor, HostServices, PointerStub } from './contract.js';
import type { SmartPointerStore } from './pointer-store.js';
import { parseCommandSpec } from '../sandbox/command-spec.js';

const binaryCache = new Map<string, boolean>();

/** Credential-bearing env var keys stripped from probe subprocesses. */
const CREDENTIAL_ENV_KEYS = new Set([
  'GH_TOKEN', 'GITHUB_TOKEN', 'GITLAB_TOKEN', 'NPM_TOKEN', 'NPM_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY_ID', 'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET', 'AZURE_TENANT_ID', 'GCP_SERVICE_ACCOUNT_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS', 'SLACK_TOKEN', 'DOCKER_TOKEN', 'DOCKER_PASSWORD',
  'PRIVATE_KEY', 'SSH_AUTH_SOCK',
]);

function buildSanitizedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!CREDENTIAL_ENV_KEYS.has(key)) env[key] = value;
  }
  return env;
}
const SANITIZED_ENV = buildSanitizedEnv();

export interface ScanSchedulerResult {
  target: string;
  timestamp: string;
  executedProbes: string[];
  pointersCreated: PointerStub[];
}

function execWithSpawn(cmd: string, opts: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
  const cwd = opts.cwd || process.cwd();
  const parsed = parseCommandSpec(cmd);
  if (!parsed.executable) {
    return Promise.reject(new Error('Empty command'));
  }
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn(parsed.executable, parsed.args, {
      cwd,
      encoding: 'utf-8',
      shell: false,
      env: SANITIZED_ENV,
    });

    const timer = opts.timeout
      ? setTimeout(() => {
          if (killed) return;
          killed = true;
          child.kill('SIGKILL');
          reject(new Error(`Command timed out after ${opts.timeout}ms: ${parsed.executable}`));
        }, opts.timeout)
      : undefined;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code: number | null, _signal: string | null) => {
      clearTimeout(timer);
      if (killed) return;
      if (code !== 0) reject(new Error(stderr || `Command exited with code ${code}: ${parsed.executable}`));
      else resolve({ stdout, stderr });
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
    const executed: Array<{ id: string; status: 'success' | 'error'; error?: string }> = [];
    const beforeCount = store.list().length;

    const hostServices: HostServices = {
      workspacePath: targetPath,
      exec: async (cmd: string, opts = {}) => {
        const cwd = opts.cwd || targetPath;
        return execWithSpawn(cmd, { ...opts, cwd });
      },
      log: (msg, level = 'info') => {
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](msg);
      },
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
      try {
        await probe.scan(targetPath, store, hostServices);
        executed.push({ id: probe.id, status: 'success' });
      } catch (err: any) {
        console.error(`[ProbeScanScheduler] Probe "${probe.id}" scan error:`, err.message);
        executed.push({ id: probe.id, status: 'error', error: err.message });
      }
    }

    const allPointers = store.list();
    const newPointers = allPointers.slice(beforeCount);

    return {
      target: targetPath,
      timestamp: new Date().toISOString(),
      executedProbes: executed.map((e) => e.id),
      pointersCreated: newPointers.map((p) => p.stub),
    };
  }
}
