import { existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getOpenContribDataDir } from "../kernel/home.js";

export class OpenContribStorage {
  private static instance: OpenContribStorage;
  private customDataDir?: string;

  constructor(customDataDir?: string) {
    this.customDataDir = customDataDir;
  }

  static getInstance(): OpenContribStorage {
    if (!OpenContribStorage.instance) {
      OpenContribStorage.instance = new OpenContribStorage();
    }
    return OpenContribStorage.instance;
  }

  getHomeDir(): string {
    // Single source of truth: the canonical OpenContrib data directory
    // (<OPENCONTRIB_HOME>/.opencontrib or ~/.opencontrib).
    const home = this.customDataDir || getOpenContribDataDir();
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true });
    }
    return home;
  }

  getRunsDir(): string {
    const dir = join(this.getHomeDir(), "runs");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getWorkspacesDir(): string {
    const dir = join(this.getHomeDir(), "workspaces");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getReposDir(): string {
    const dir = join(this.getHomeDir(), "repos");
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getMemoryFile(): string {
    return join(this.getHomeDir(), "memory.json");
  }

  getFlywheelFile(): string {
    return join(this.getHomeDir(), "contributions.json");
  }

  getPresetsFile(): string {
    return join(this.getHomeDir(), "presets.json");
  }

  getConfigFile(): string {
    return join(this.getHomeDir(), "config.json");
  }
}

export const defaultStorage = OpenContribStorage.getInstance();
