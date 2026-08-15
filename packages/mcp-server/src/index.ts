#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOpenContribMcpServer } from './server.js';
import { installMcpConfiguration } from './installer.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  // If invoked with "install" or "setup"
  if (command === 'install' || command === 'setup') {
    console.log('✨ OpenContrib MCP — One-Click Setup Utility');
    console.log('----------------------------------------------------');
    const runner = typeof (globalThis as any).Bun !== 'undefined' ? 'bunx' : 'npx';
    const res = installMcpConfiguration({
      packageRunner: runner,
      githubToken: process.env.GITHUB_TOKEN,
    });

    console.log('\n✔ Configured Clients & IDEs:');
    for (const c of res.configured) {
      console.log(`  ✅ ${c}`);
    }

    if (res.skipped.length > 0) {
      console.log('\nℹ Skipped / Not Detected:');
      for (const s of res.skipped) {
        console.log(`  - ${s}`);
      }
    }

    console.log('\n🎉 Setup complete! Restart your IDE (Cursor, Claude Desktop, Windsurf, VS Code) to activate.');
    return;
  }

  // Default: Run MCP Server on stdio
  const server = createOpenContribMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🚀 OpenContrib MCP Server running on stdio');
}

main().catch((err) => {
  console.error('Fatal MCP Server error:', err);
  process.exit(1);
});
