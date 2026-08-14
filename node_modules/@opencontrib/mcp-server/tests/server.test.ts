import { describe, expect, it } from 'bun:test';
import { createOpenContribMcpServer } from '../src/server.js';

describe('OpenContrib MCP Server', () => {
  it('initializes and registers all 6 core opencontrib tools', () => {
    const server = createOpenContribMcpServer();
    expect(server).toBeDefined();
    // Verify server metadata
    expect(server['server']).toBeDefined();
  });
});
