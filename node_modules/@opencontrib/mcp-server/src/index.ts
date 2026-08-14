#!/usr/bin/env bun
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOpenContribMcpServer } from './server.js';

async function main() {
  const server = createOpenContribMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 OpenContrib MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal MCP Server error:', err);
  process.exit(1);
});
