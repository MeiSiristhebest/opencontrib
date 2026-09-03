import type { ProbeDescriptor, HostServices, PointerStub } from './contract.js';
import type { SmartPointerStore } from './pointer-store.js';
import { execWithSpawn, defaultBinaryProbe } from './process-runner.js';

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
        return execWithSpawn(cmd, { cwd, timeout: opts.timeout, shell: false, env: SANITIZED_ENV });
      },
      log: (msg, level = 'info') => {
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](msg);
      },
      isBinaryAvailable: (bin: string) => defaultBinaryProbe.isAvailable(bin),
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
