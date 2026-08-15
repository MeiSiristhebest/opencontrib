import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';

export interface IdeConfigTarget {
  name: string;
  configPath: string;
  format: 'claude' | 'cursor' | 'generic';
}

export function getKnownIdeTargets(): IdeConfigTarget[] {
  const home = homedir();
  const os = platform();

  const targets: IdeConfigTarget[] = [];

  // 1. Claude Desktop
  if (os === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    targets.push({
      name: 'Claude Desktop',
      configPath: join(appData, 'Claude', 'claude_desktop_config.json'),
      format: 'claude',
    });
  } else if (os === 'darwin') {
    targets.push({
      name: 'Claude Desktop',
      configPath: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      format: 'claude',
    });
  } else {
    targets.push({
      name: 'Claude Desktop',
      configPath: join(home, '.config', 'Claude', 'claude_desktop_config.json'),
      format: 'claude',
    });
  }

  // 2. Cursor
  targets.push({
    name: 'Cursor',
    configPath: join(home, '.cursor', 'mcp.json'),
    format: 'cursor',
  });

  // 3. Windsurf
  targets.push({
    name: 'Windsurf',
    configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'generic',
  });

  // 4. Antigravity / Gemini Code Assist
  targets.push({
    name: 'Antigravity',
    configPath: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    format: 'generic',
  });

  // 5. Cline / Roo Code / VSCode extensions
  if (os === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    targets.push({
      name: 'Cline / Roo Code (VSCode)',
      configPath: join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      format: 'generic',
    });
  } else if (os === 'darwin') {
    targets.push({
      name: 'Cline / Roo Code (VSCode)',
      configPath: join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      format: 'generic',
    });
  } else {
    targets.push({
      name: 'Cline / Roo Code (VSCode)',
      configPath: join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
      format: 'generic',
    });
  }

  return targets;
}

export interface InstallOptions {
  githubToken?: string;
  packageRunner?: 'npx' | 'bunx';
  targetClients?: string[];
}

export function installMcpConfiguration(options: InstallOptions = {}): {
  configured: string[];
  skipped: string[];
  configs: Record<string, string>;
} {
  const runner = options.packageRunner || 'npx';
  const targets = getKnownIdeTargets();

  const serverConfig = {
    command: runner,
    args: runner === 'npx' ? ['-y', '@opencontrib/mcp-server'] : ['@opencontrib/mcp-server'],
    ...(options.githubToken ? { env: { GITHUB_TOKEN: options.githubToken } } : {}),
  };

  const configured: string[] = [];
  const skipped: string[] = [];
  const configs: Record<string, string> = {};

  for (const target of targets) {
    if (options.targetClients && !options.targetClients.some((c) => target.name.toLowerCase().includes(c.toLowerCase()))) {
      skipped.push(target.name);
      continue;
    }

    try {
      const configDir = dirname(target.configPath);
      if (!existsSync(configDir)) {
        mkdirSync(configDir, { recursive: true });
      }

      let existingJson: any = { mcpServers: {} };
      if (existsSync(target.configPath)) {
        try {
          const raw = readFileSync(target.configPath, 'utf-8');
          existingJson = JSON.parse(raw);
          if (!existingJson.mcpServers) {
            existingJson.mcpServers = {};
          }
        } catch {
          existingJson = { mcpServers: {} };
        }
      }

      existingJson.mcpServers.opencontrib = serverConfig;

      writeFileSync(target.configPath, JSON.stringify(existingJson, null, 2), 'utf-8');
      configured.push(`${target.name} (${target.configPath})`);
      configs[target.name] = target.configPath;
    } catch (err: any) {
      skipped.push(`${target.name}: ${err.message}`);
    }
  }

  return { configured, skipped, configs };
}
