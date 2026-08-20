import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { promisify } from 'util';
import type {
  OpenContribPlugin,
  PluginContext,
  ProbeDescriptor,
  ProbeRegistryApi,
  HostServices,
  RepoFingerprint,
  SmartPointer,
  PointerStub,
} from './contract.js';
import { SmartPointerStore } from './pointer-store.js';
import { MicrokernelEventBus } from './event-bus.js';

const execAsync = promisify(exec);
const binaryCache = new Map<string, boolean>();

export class PluginHost implements ProbeRegistryApi {
  private plugins = new Map<string, OpenContribPlugin>();
  private probes = new Map<string, ProbeDescriptor>();
  private activeProbes = new Set<string>();
  public pointers: SmartPointerStore;
  public events: MicrokernelEventBus;
  public pluginsDir: string;
  public workspacePath: string;

  constructor(options: { workspacePath?: string; pluginsDir?: string } = {}) {
    this.workspacePath = options.workspacePath || process.cwd();
    this.pluginsDir = options.pluginsDir || path.join(os.homedir(), '.opencontrib', 'plugins');
    this.pointers = new SmartPointerStore(path.join(this.workspacePath, '.opencontrib', 'pointers'));
    this.events = new MicrokernelEventBus();
  }

  // ── ProbeRegistryApi Implementation ──

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

  // ── Plugin Lifecycle & Host Services ──

  public async registerPlugin(plugin: OpenContribPlugin): Promise<void> {
    if (this.plugins.has(plugin.name)) {
      await this.unregisterPlugin(plugin.name);
    }

    const hostServices: HostServices = {
      workspacePath: this.workspacePath,
      exec: async (cmd: string, opts = {}) => {
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

    const ctx: PluginContext = {
      pluginName: plugin.name,
      host: hostServices,
      pointers: this.pointers,
      probes: this,
      events: this.events,
    };

    try {
      await plugin.activate(ctx);
      this.plugins.set(plugin.name, plugin);
    } catch (err: any) {
      console.error(`[PluginHost] Failed to activate plugin "${plugin.name}":`, err.message);
      throw err;
    }
  }

  public async unregisterPlugin(pluginName: string): Promise<boolean> {
    const plugin = this.plugins.get(pluginName);
    if (!plugin) return false;

    if (plugin.deactivate) {
      try {
        await plugin.deactivate();
      } catch (err: any) {
        console.error(`[PluginHost] Error in deactivate for "${pluginName}":`, err.message);
      }
    }
    return this.plugins.delete(pluginName);
  }

  public listPlugins(): Array<{ name: string; version: string; description?: string }> {
    return Array.from(this.plugins.values()).map((p) => ({
      name: p.name,
      version: p.version,
      description: p.description,
    }));
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
   * Returns lightweight PointerStub summaries (~25 tokens each) to the Agent.
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
