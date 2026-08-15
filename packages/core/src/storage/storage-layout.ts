import { existsSync, mkdirSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

export class OpenContribStorage {
  private static instance: OpenContribStorage;
  private customHome?: string;

  constructor(customHome?: string) {
    this.customHome = customHome;
  }

  static getInstance(): OpenContribStorage {
    if (!OpenContribStorage.instance) {
      OpenContribStorage.instance = new OpenContribStorage();
    }
    return OpenContribStorage.instance;
  }

  getHomeDir(): string {
    const home = this.customHome || process.env.OPENCONTRIB_HOME || join(homedir(), '.opencontrib');
    if (!existsSync(home)) {
      mkdirSync(home, { recursive: true });
    }
    return home;
  }

  getRunsDir(): string {
    const dir = join(this.getHomeDir(), 'runs');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getWorkspacesDir(): string {
    const dir = join(this.getHomeDir(), 'workspaces');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getReposDir(): string {
    const dir = join(this.getHomeDir(), 'repos');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  getMemoryFile(): string {
    return join(this.getHomeDir(), 'memory.json');
  }

  getFlywheelFile(): string {
    return join(this.getHomeDir(), 'contributions.json');
  }

  getPresetsFile(): string {
    return join(this.getHomeDir(), 'presets.json');
  }

  getConfigFile(): string {
    return join(this.getHomeDir(), 'config.json');
  }
}

export const defaultStorage = OpenContribStorage.getInstance();
