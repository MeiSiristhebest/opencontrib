import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TOOL_REGISTRY, type ToolRegistryEntry } from './tool-registry.js';

function getOpenContribHome(): string {
  return process.env.OPENCONTRIB_HOME || os.homedir();
}

export interface PluginState {
  enabled: boolean;
  disabledAt?: string;
  disabledReason?: 'binary-not-found' | 'user-disabled' | 'probe-incompatible' | string;
  installedAt?: string;
}

export interface PluginManagerOptions {
  statePath?: string;
}

/**
 * PluginManager — Persists plugin enable/disable state to ~/.opencontrib/plugins-state.json.
 *
 * State is consulted at runtime by ProbeRegistry and PluginHost to decide whether
 * a given probe should run or be skipped.  The state file is the single source of
 * truth: `pm.enable('semgrep')` persists immediately, so the next scan activates it
 * without re-running setup.
 */
export class PluginManager {
  private statePath: string;
  private state: Record<string, PluginState> = {};

  constructor(opts: PluginManagerOptions = {}) {
    this.statePath = opts.statePath || path.join(getOpenContribHome(), '.opencontrib', 'plugins-state.json');
    this.load();
  }

  private load(): void {
    try {
      if (fs.existsSync(this.statePath)) {
        const raw = fs.readFileSync(this.statePath, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          this.state = parsed.plugins && typeof parsed.plugins === 'object' ? parsed.plugins : parsed;
        }
      }
    } catch {
      this.state = {};
    }
  }

  private save(): void {
    const dir = path.dirname(this.statePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = this.statePath + '.tmp';
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(this.state, null, 2), 'utf8');
      fs.renameSync(tmpPath, this.statePath);
    } catch {
      try { fs.unlinkSync(tmpPath); } catch {}
      throw new Error(`Failed to save plugin state to ${this.statePath}`);
    }
  }

  /** Get the current state of a plugin. Unset plugins default to `{ enabled: true }`. */
  getState(pluginId: string): PluginState {
    const s = this.state[pluginId];
    if (!s) {
      return { enabled: true };
    }
    return s;
  }

  /** Whether the plugin is currently enabled. Returns false for unknown IDs. */
  isEnabled(pluginId: string): boolean {
    if (this.state[pluginId] !== undefined) {
      return this.state[pluginId].enabled;
    }
    const isKnown = TOOL_REGISTRY.some((t) => t.id === pluginId);
    return isKnown;
  }

  /** Return the reason a plugin was disabled, or undefined. */
  getDisabledReason(pluginId: string): string | undefined {
    const s = this.state[pluginId];
    return s?.enabled === false ? s.disabledReason : undefined;
  }

  /** Enable a plugin, persisting the state immediately. */
  enable(pluginId: string): void {
    this.state[pluginId] = {
      enabled: true,
      installedAt: new Date().toISOString(),
    };
    this.save();
  }

  /** Disable a plugin with a reason, persisting immediately. */
  disable(pluginId: string, reason: string): void {
    this.state[pluginId] = {
      enabled: false,
      disabledAt: new Date().toISOString(),
      disabledReason: reason,
    };
    this.save();
  }

  /** Get the list of all known tools (from TOOL_REGISTRY) with their probe mappings. */
  getToolRegistry(): ToolRegistryEntry[] {
    return TOOL_REGISTRY;
  }

  /** Get the full state object. */
  getAllStates(): Record<string, PluginState> {
    return { ...this.state };
  }

  /** Reset state to defaults (all plugins enabled). */
  reset(): void {
    this.state = {};
    this.save();
  }

  /** Check which tools from a given list are available. Returns { present, missing }. */
  checkTools(toolIds: string[]): { present: string[]; missing: string[] } {
    const isWindows = process.platform === 'win32';

    const present: string[] = [];
    const missing: string[] = [];

    for (const toolId of toolIds) {
      const entry = TOOL_REGISTRY.find((t) => t.id === toolId);
      if (!entry) {
        missing.push(toolId);
        continue;
      }

      let found = false;
      for (const bin of entry.bin) {
        const cmd = isWindows ? 'where.exe' : 'command';
        const args = isWindows ? ['-q', bin] : ['-v', bin];
        const result = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 3000 });
        if (result.status === 0) {
          found = true;
          break;
        }
      }

      if (found) present.push(toolId);
      else missing.push(toolId);
    }

    return { present, missing };
  }

  /** Get the state file path. */
  getStatePath(): string {
    return this.statePath;
  }
}

export const defaultPluginManager = new PluginManager();
