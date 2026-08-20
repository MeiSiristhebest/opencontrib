import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
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

const execAsync = promisify(exec);
const binaryCache = new Map<string, boolean>();

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
    this.pluginsDir = options.pluginsDir || path.join(os.homedir(), '.opencontrib', 'plugins');
    this.pointers = new SmartPointerStore(path.join(this.workspacePath, '.opencontrib', 'pointers'));
    this.events = new MicrokernelEventBus();
    this.router = new CapabilityRouter();
    this.evidenceGraph = new EvidenceGraph(this.pointers);
  }

  // ── ProbeRegistryApi Implementation ──

  public isBinaryAvailable(bin: string): boolean {
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
  }

  public async exec(cmd: string, opts: { cwd?: string; timeout?: number } = {}): Promise<{ stdout: string; stderr: string }> {
    const cwd = opts.cwd || this.workspacePath;
    const { stdout, stderr } = await execAsync(cmd, {
      cwd,
      timeout: opts.timeout || 30000,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { stdout, stderr };
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

  public async registerPlugin(plugin: OpenContribPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      await this.unregisterPlugin(plugin.name);
    }

    const hostServices: HostServices = {
      workspacePath: this.workspacePath,
      exec: async (cmd: string, opts = {}) => {
        // Enforce runtime permission checks if permissions are declared
        if (plugin.permissions) {
          const isGitCmd = cmd.trim().startsWith('git ') || cmd.trim() === 'git';
          const hasGitPerm = plugin.permissions.includes('exec:git') || plugin.permissions.includes('exec:binary');
          const hasBinPerm = plugin.permissions.includes('exec:binary');

          if (isGitCmd && !hasGitPerm) {
            throw new PluginPermissionError(plugin.name, 'exec:git', cmd);
          } else if (!isGitCmd && !hasBinPerm) {
            throw new PluginPermissionError(plugin.name, 'exec:binary', cmd);
          }
        }

        const cwd = opts.cwd || this.workspacePath;
        const { stdout, stderr } = await execAsync(cmd, {
          cwd,
          timeout: opts.timeout || 30000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return { stdout, stderr };
      },
      log: (msg: string, level = 'info') => {
        // Structured logging
      },
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
      console.error(`[PluginHost] Failed to activate plugin "${plugin.name}":`, err.message);
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
    const executed: string[] = [];
    const beforeCount = this.pointers.list().length;

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
        await probe.scan(targetPath, this.pointers, hostServices);
      } catch (err: any) {
        console.error(`[PluginHost] Probe "${probe.id}" scan error:`, err.message);
      }
    }

    const allPointers = this.pointers.list();
    const newPointers = allPointers.slice(beforeCount);

    return {
      target: targetPath,
      timestamp: new Date().toISOString(),
      executedProbes: executed,
      pointersCreated: newPointers.map((p) => p.stub),
    };
  }
}
