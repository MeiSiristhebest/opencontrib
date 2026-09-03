import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  PluginPermissionError,
  type OpenContribPlugin,
  type PluginContext,
  type ProbeDescriptor,
  type ProbeRegistryApi,
  type HostServices,
  type RepoFingerprint,
  type PointerStub,
  type KernelToolDescriptor,
} from './contract.js';
import { SmartPointerStore } from './pointer-store.js';
import { MicrokernelEventBus } from './event-bus.js';
import { CapabilityRouter } from './capability-router.js';
import { EvidenceGraph } from './evidence-graph.js';
import { ProbeScanScheduler } from './scan-scheduler.js';
import { parseCommandSpec } from '../sandbox/command-spec.js';
import { getOpenContribHome } from './home.js';
import { execWithSpawn, defaultBinaryProbe } from './process-runner.js';


/** Credential-bearing env var keys that must never be passed to plugin subprocesses. */
const PLUGIN_CREDENTIAL_ENV_KEYS = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GITLAB_TOKEN',
  'NPM_TOKEN',
  'NPM_AUTH_TOKEN',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SESSION_TOKEN',
  'AZURE_CLIENT_SECRET',
  'AZURE_TENANT_ID',
  'GCP_SERVICE_ACCOUNT_KEY',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'SLACK_TOKEN',
  'DOCKER_TOKEN',
  'DOCKER_PASSWORD',
  'PRIVATE_KEY',
  'SSH_AUTH_SOCK',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'DEEPSEEK_API_KEY',
  'GROQ_API_KEY',
  'COHERE_API_KEY',
  'MISTRAL_API_KEY',
  'HF_TOKEN',
  'AZURE_OPENAI_API_KEY',
]);

/** Return a credential-stripped copy of the process environment. */
function buildSanitizedPluginEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!PLUGIN_CREDENTIAL_ENV_KEYS.has(key) && !/(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_AUTH|_CREDENTIAL)$/i.test(key)) {
      env[key] = value;
    }
  }
  return env;
}

const SANITIZED_PLUGIN_ENV = buildSanitizedPluginEnv();

export class PluginHost implements ProbeRegistryApi {
  private plugins = new Map<string, OpenContribPlugin>();
  private pluginCapabilities = new Map<string, { probes: string[]; tools: string[] }>();
  private probes = new Map<string, ProbeDescriptor>();
  private tools = new Map<string, KernelToolDescriptor>();
  public pointers: SmartPointerStore;
  public events: MicrokernelEventBus;
  public router: CapabilityRouter;
  public evidenceGraph: EvidenceGraph;
  public pluginsDir: string;
  public workspacePath: string;

  constructor(options: { workspacePath?: string; pluginsDir?: string } = {}) {
    this.workspacePath = options.workspacePath || process.cwd();
    const home = getOpenContribHome();
    const opencontribDir = home.endsWith('.opencontrib') ? home : path.join(home, '.opencontrib');
    this.pluginsDir = options.pluginsDir || path.join(opencontribDir, 'plugins');
    this.pointers = new SmartPointerStore(path.join(this.workspacePath, '.opencontrib', 'pointers'));
    this.events = new MicrokernelEventBus();
    this.router = new CapabilityRouter();
    this.evidenceGraph = new EvidenceGraph(this.pointers);
  }

  // ── ProbeRegistryApi Implementation ──

  public isBinaryAvailable(bin: string): boolean {
    return defaultBinaryProbe.isAvailable(bin);
  }

  public async exec(cmd: string, opts: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const cwd = opts.cwd || this.workspacePath;
    return execWithSpawn(cmd, {
      ...opts,
      cwd,
      shell: process.platform === 'win32',
      env: SANITIZED_PLUGIN_ENV,
    });
  }

  public register(probe: ProbeDescriptor): void {
    this.probes.set(probe.id, probe);
  }

  public unregister(probeId: string): boolean {
    return this.probes.delete(probeId);
  }

  public get(probeId: string): ProbeDescriptor | undefined {
    return this.probes.get(probeId);
  }

  public listAll(): ProbeDescriptor[] {
    return Array.from(this.probes.values());
  }

  public registerTool(tool: KernelToolDescriptor): void {
    this.tools.set(tool.name, tool);
  }

  public getTool(toolName: string): KernelToolDescriptor | undefined {
    return this.tools.get(toolName);
  }

  public listTools(): KernelToolDescriptor[] {
    return Array.from(this.tools.values());
  }

  // ── Plugin Lifecycle & Host Services ──

  /**
   * @deprecated Code-driven plugin registration is being consolidated onto the
   * data-driven {@link ProbeRegistry} (the single source of truth for probe
   * *definitions*, per architecture review §16 stage 4). New capabilities should
   * be declared as `ProbeManifest`s via `ProbeRegistry.register(manifest)`;
   * this runtime `OpenContribPlugin` path is retained only for backward
   * compatibility and will be removed in a later phase.
   */
  public async registerPlugin(plugin: OpenContribPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      await this.unregisterPlugin(plugin.name);
    }

    const hostServices: HostServices = {
      workspacePath: this.workspacePath,
      exec: async (cmd: string, opts = {}) => {
        const parsed = parseCommandSpec(cmd);
        const exe = parsed.executable.toLowerCase();
        const isGitCmd = exe === 'git' || exe === 'git.exe';
        const hasGitPerm = plugin.permissions?.includes('exec:git') || plugin.permissions?.includes('exec:binary');
        const hasBinPerm = plugin.permissions?.includes('exec:binary');

        if (isGitCmd && !hasGitPerm) {
          throw new PluginPermissionError(plugin.name, 'exec:git', cmd);
        }
        if (!isGitCmd && !hasBinPerm) {
          throw new PluginPermissionError(plugin.name, 'exec:binary', cmd);
        }

        const cwd = opts.cwd || this.workspacePath;
        const { stdout, stderr } = await execWithSpawn(cmd, {
          cwd,
          timeout: opts.timeout || 30000,
        });
        return { stdout, stderr };
      },
      log: (msg: string, level = 'info') => {
        console[level === 'error' ? 'error' : level === 'warn' ? 'warn' : 'log'](msg);
      },
      isBinaryAvailable: (bin: string) => defaultBinaryProbe.isAvailable(bin),
    };

    const registeredProbes: string[] = [];
    const registeredTools: string[] = [];

    const ctx: PluginContext = {
      pluginName: plugin.name,
      host: hostServices,
      pointers: this.pointers,
      probes: {
        register: (probe) => {
          registeredProbes.push(probe.id);
          this.register(probe);
        },
        unregister: (id) => this.unregister(id),
        get: (id) => this.get(id),
        listAll: () => this.listAll(),
      },
      events: this.events,
      registerTool: (tool) => {
        registeredTools.push(tool.name);
        this.registerTool(tool);
      },
    };

    try {
      await plugin.activate(ctx);
      this.plugins.set(plugin.name, plugin);
      this.pluginCapabilities.set(plugin.name, {
        probes: registeredProbes,
        tools: registeredTools,
      });

      await this.events.emit('plugin:activated', {
        name: plugin.name,
        version: plugin.version,
        probesCount: registeredProbes.length,
        toolsCount: registeredTools.length,
      }, plugin.name);
    } catch (err: any) {
      // Rollback: undo all registrations that occurred before the failure
      for (const pId of registeredProbes) this.unregister(pId);
      for (const tName of registeredTools) this.tools.delete(tName);
      console.error(`[PluginHost] Failed to activate "${plugin.name}", rolled back ${registeredProbes.length} probes and ${registeredTools.length} tools:`, err.message);
      throw err;
    }
  }

  public async unregisterPlugin(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;

    // Clean up registered capabilities
    const caps = this.pluginCapabilities.get(pluginName);
    if (caps) {
      for (const pId of caps.probes) this.unregister(pId);
      for (const tName of caps.tools) this.tools.delete(tName);
      this.pluginCapabilities.delete(pluginName);
    }

    if (plugin.deactivate) {
      try {
        await plugin.deactivate();
      } catch (err: any) {
        console.error(`[PluginHost] Error in deactivate for "${pluginName}":`, err.message);
      }
    }
    const removed = this.plugins.delete(pluginName);
    await this.events.emit('plugin:deactivated', { name: pluginName }, 'kernel');
    return removed;
  }

  public listPlugins(): Array<{
    name: string;
    version: string;
    description?: string;
    probes: string[];
    tools: string[];
  }> {
    return Array.from(this.plugins.values()).map((p) => {
      const caps = this.pluginCapabilities.get(p.name) || { probes: [], tools: [] };
      return {
        name: p.name,
        version: p.version,
        description: p.description,
        probes: caps.probes,
        tools: caps.tools,
      };
    });
  }

  /**
   * Progressive Capability Negotiation:
   * Match all registered probes against the target repository fingerprint.
   *
   * @deprecated Prefer `negotiateProbes` from `probe/negotiator.ts`, which
   * negotiates against the canonical `ProbeRegistry` (single source of truth).
   */
  public negotiate(
    fingerprint: RepoFingerprint,
    options: { only?: string[]; skip?: string[] } = {},
  ): {
    selectedProbes: ProbeDescriptor[];
    skippedProbes: Array<{ id: string; name: string; reason: string }>;
  } {
    const selectedProbes: ProbeDescriptor[] = [];
    const skippedProbes: Array<{ id: string; name: string; reason: string }> = [];

    for (const probe of this.probes.values()) {
      if (options.skip && options.skip.includes(probe.id)) {
        skippedProbes.push({ id: probe.id, name: probe.name, reason: 'Explicitly skipped via --skip' });
        continue;
      }

      if (options.only && options.only.length > 0 && !options.only.includes(probe.id)) {
        skippedProbes.push({ id: probe.id, name: probe.name, reason: 'Not in --only list' });
        continue;
      }

      try {
        const isMatch = probe.match(fingerprint);
        if (isMatch) {
          selectedProbes.push(probe);
        } else {
          skippedProbes.push({
            id: probe.id,
            name: probe.name,
            reason: `Did not match repository fingerprint (${fingerprint.primaryLanguage})`,
          });
        }
      } catch (err: any) {
        skippedProbes.push({ id: probe.id, name: probe.name, reason: `Match evaluation error: ${err.message}` });
      }
    }

    return { selectedProbes, skippedProbes };
  }

  /**
   * Execute negotiated probes concurrently and populate SmartPointerStore.
   * Delegated to ProbeScanScheduler (SRP separation).
   */
  public async executeScan(
    targetPath: string,
    probesToRun: ProbeDescriptor[],
  ): Promise<{
    target: string;
    timestamp: string;
    executedProbes: string[];
    pointersCreated: PointerStub[];
  }> {
    return ProbeScanScheduler.executeScan(targetPath, probesToRun, this.pointers);
  }
}
