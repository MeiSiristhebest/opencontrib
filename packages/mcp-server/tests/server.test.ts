import { describe, expect, it } from 'bun:test';
import { createOpenContribMcpServer } from '../src/server.js';

describe('OpenContrib MCP Server', () => {
  it('initializes and registers all 18 composable contribution domain tools, resources, and workflow prompt', () => {
    const server = createOpenContribMcpServer();
    expect(server).toBeDefined();
    expect(server['server']).toBeDefined();

    // Verify underlying tools registration
    const tools = (server as any)._registeredTools;
    expect(Object.keys(tools).length).toBe(18);
    expect(tools['contrib_scout']).toBeDefined();
    expect(tools['contrib_rank_opportunity']).toBeDefined();
    expect(tools['contrib_create_run']).toBeDefined();
    expect(tools['contrib_prepare_workspace']).toBeDefined();
    expect(tools['contrib_collect_evidence']).toBeDefined();
    expect(tools['contrib_audit_governance']).toBeDefined();
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
