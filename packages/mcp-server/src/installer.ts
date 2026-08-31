import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { homedir, platform } from 'os';

export const OPENCONTRIB_MCP_PACKAGE = '@opencontrib/mcp';

export interface IdeConfigTarget {
  id: 'claude' | 'cursor' | 'windsurf' | 'antigravity' | 'vscode';
  name: string;
  configPath: string;
  format: 'claude' | 'cursor' | 'generic';
}

export function getKnownIdeTargets(): IdeConfigTarget[] {
  const home = homedir();
  const os = platform();

  const targets: IdeConfigTarget[] = [];

  // 1. Claude Desktop
  let claudePath = join(home, '.config', 'Claude', 'claude_desktop_config.json');
  if (os === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    claudePath = join(appData, 'Claude', 'claude_desktop_config.json');
  } else if (os === 'darwin') {
    claudePath = join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  targets.push({
    id: 'claude',
    name: 'Claude Desktop',
    configPath: claudePath,
    format: 'claude',
  });

  // 2. Cursor
  targets.push({
    id: 'cursor',
    name: 'Cursor IDE',
    configPath: join(home, '.cursor', 'mcp.json'),
    format: 'cursor',
  });

  // 3. Windsurf
  targets.push({
    id: 'windsurf',
    name: 'Windsurf / Codeium',
    configPath: join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    format: 'generic',
  });

  // 4. Antigravity / Gemini Code Assist
  targets.push({
    id: 'antigravity',
    name: 'Antigravity / Gemini Code Assist',
    configPath: join(home, '.gemini', 'antigravity', 'mcp_config.json'),
    format: 'generic',
  });

  // 5. VS Code / Cline / Roo Code
  let vscodeClinePath = join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  if (os === 'win32') {
    const appData = process.env.APPDATA || join(home, 'AppData', 'Roaming');
    vscodeClinePath = join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  } else if (os === 'darwin') {
    vscodeClinePath = join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json');
  }
  targets.push({
    id: 'vscode',
    name: 'VS Code (Cline / Roo Code)',
    configPath: vscodeClinePath,
    format: 'generic',
  });

  return targets;
}

export function generateStandardMcpConfig(runner: 'npx' | 'bunx' = 'npx') {
  return {
    mcpServers: {
      opencontrib: {
        command: runner,
        args: runner === 'npx' ? ['-y', OPENCONTRIB_MCP_PACKAGE] : [OPENCONTRIB_MCP_PACKAGE],
      },
    },
  };
}

export interface InstallOptions {
  githubToken?: string;
  packageRunner?: 'npx' | 'bunx';
  clientIds?: string[];
  dryRun?: boolean;
}

export function configureMcpTarget(target: IdeConfigTarget, options: InstallOptions = {}): { success: boolean; configPath: string; error?: string } {
  const runner = options.packageRunner || 'npx';
  const serverConfig = {
    command: runner,
    args: runner === 'npx' ? ['-y', OPENCONTRIB_MCP_PACKAGE] : [OPENCONTRIB_MCP_PACKAGE],
  };

  // SECURITY: Tokens are NOT written to config files. Set GITHUB_TOKEN in your environment.
  if (options.githubToken) {
    console.warn('[installer] githubToken provided but intentionally not written to config file. Set GITHUB_TOKEN env var instead.');
  }

  try {
    const configDir = dirname(target.configPath);
    if (!options.dryRun && !existsSync(configDir)) {
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

    if (!options.dryRun) {
      writeFileSync(target.configPath, JSON.stringify(existingJson, null, 2), 'utf-8');
    }
    return { success: true, configPath: target.configPath };
  } catch (err: any) {
    return { success: false, configPath: target.configPath, error: err.message };
  }
}
