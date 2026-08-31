import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  configureMcpTarget,
  generateStandardMcpConfig,
  OPENCONTRIB_MCP_PACKAGE,
  type IdeConfigTarget,
} from '../src/installer.js';
import { createOpenContribMcpServer } from '../src/server.js';

describe('OpenContrib MCP Server', () => {
  it('initializes and registers all 34 composable contribution domain tools, resources, and workflow prompt', () => {
    const server = createOpenContribMcpServer();
    expect(server).toBeDefined();
    expect(server['server']).toBeDefined();

    // Verify underlying tools registration
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).length).toBe(34);
    expect(tools['contrib_scout']).toBeDefined();
    expect(tools['contrib_rank_opportunity']).toBeDefined();
    expect(tools['contrib_create_run']).toBeDefined();
    expect(tools['contrib_prepare_workspace']).toBeDefined();
    expect(tools['contrib_collect_evidence']).toBeDefined();
    expect(tools['contrib_audit_governance']).toBeDefined();
    expect(tools['contrib_analyze_impact']).toBeDefined();
    expect(tools['contrib_diagnose_ci']).toBeDefined();
    expect(tools['contrib_render_pr_template']).toBeDefined();
    expect(tools['contrib_sync_flywheel']).toBeDefined();

    // Verify resources registration
    const resources = (server as any)._registeredResources;
    expect(Object.keys(resources).length).toBeGreaterThanOrEqual(3);
    expect(resources['opencontrib://doctor']).toBeDefined();
    expect(resources['opencontrib://memory']).toBeDefined();
    expect(resources['opencontrib://runs']).toBeDefined();

    // Verify prompt registration
    const prompts = (server as any)._registeredPrompts;
    expect(prompts['opencontrib_workflow_guide']).toBeDefined();
  });
});

describe('OpenContrib MCP Installer', () => {
  it('generates client configuration with the published npm package name', () => {
    const npxConfig = generateStandardMcpConfig('npx');
    const bunxConfig = generateStandardMcpConfig('bunx');

    expect(OPENCONTRIB_MCP_PACKAGE).toBe('@opencontrib/mcp');
    expect(npxConfig.mcpServers.opencontrib.args).toEqual(['-y', '@opencontrib/mcp']);
    expect(bunxConfig.mcpServers.opencontrib.args).toEqual(['@opencontrib/mcp']);
  });

  it('writes client configuration with the published npm package name', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'opencontrib-installer-'));
    const target: IdeConfigTarget = {
      id: 'cursor',
      name: 'Cursor IDE',
      configPath: join(tempDir, 'mcp.json'),
      format: 'cursor',
    };

    try {
      const result = configureMcpTarget(target, { packageRunner: 'npx' });
      const config = JSON.parse(readFileSync(target.configPath, 'utf-8'));

      expect(result.success).toBe(true);
      expect(config.mcpServers.opencontrib.args).toEqual(['-y', '@opencontrib/mcp']);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
