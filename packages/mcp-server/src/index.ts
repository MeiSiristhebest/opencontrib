#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createOpenContribMcpServer } from './server.js';
import {
  configureMcpTarget,
  generateStandardMcpConfig,
  getKnownIdeTargets,
} from './installer.js';

async function main() {
  const args = process.argv.slice(2);
  const command = args[0]?.toLowerCase();

  // If invoked with "setup", "install", or "--help"
  if (command === 'install' || command === 'setup' || command === '--help' || command === '-h') {
    const isHelp = args.includes('--help') || args.includes('-h') || command === '--help' || command === '-h';
    const isDryRun = args.includes('--dry-run');
    const isAll = args.includes('--all') || args.includes('-a');
    const clientArg = args.find((a) => a.startsWith('--client='))?.split('=')[1]?.toLowerCase();

    console.log('✨ OpenContrib MCP — Client Configuration & Setup');
    console.log('====================================================');

    if (isHelp) {
      console.log(`
Usage:
  npx @opencontrib/mcp-server setup [options]

Options:
  --client=<name>    Configure a specific client (claude | cursor | windsurf | antigravity | vscode)
  --all              Configure all detected clients automatically
  --dry-run          Print configuration changes without writing to disk
  --help, -h         Show this help message

Standard Manual Config (Copy & Paste to your IDE's mcpServers):
${JSON.stringify(generateStandardMcpConfig('npx'), null, 2)}
`);
      return;
    }

    const runner = typeof (globalThis as any).Bun !== 'undefined' ? 'bunx' : 'npx';
    const knownTargets = getKnownIdeTargets();

    // If a specific client was requested
    if (clientArg) {
      const target = knownTargets.find((t) => t.id === clientArg || t.name.toLowerCase().includes(clientArg));
      if (!target) {
        console.error(`❌ Unknown client: "${clientArg}". Available options: ${knownTargets.map((t) => t.id).join(', ')}`);
        process.exit(1);
      }

      const res = configureMcpTarget(target, { packageRunner: runner, dryRun: isDryRun });
      if (res.success) {
        console.log(`\n✅ ${isDryRun ? '[Dry-Run] Would configure' : 'Successfully configured'} ${target.name}:`);
        console.log(`   📁 Path: ${res.configPath}`);
      } else {
        console.error(`\n❌ Failed to configure ${target.name}: ${res.error}`);
      }
      return;
    }

    // If --all was explicitly passed
    if (isAll) {
      console.log('\nConfiguring all detected IDEs:');
      for (const target of knownTargets) {
        const res = configureMcpTarget(target, { packageRunner: runner, dryRun: isDryRun });
        if (res.success) {
          console.log(`  ✅ ${target.name} (${res.configPath})`);
        } else {
          console.log(`  ❌ ${target.name} (${res.error})`);
        }
      }
      console.log('\n🎉 Setup complete! Restart your IDE to activate.');
      return;
    }

    // Default interactive / informative output: List detected paths and exact JSON config
    console.log('\n📋 Detected IDE Configuration Paths on your system:');
    for (const target of knownTargets) {
      console.log(`  - [${target.id}] ${target.name} -> ${target.configPath}`);
    }

    console.log('\n💡 Recommended Universal MCP Configuration (JSON):');
    console.log(JSON.stringify(generateStandardMcpConfig(runner), null, 2));

    console.log('\n👉 Quick Actions:');
    console.log(`  1. Configure specific IDE:  npx @opencontrib/mcp-server setup --client=cursor`);
    console.log(`  2. Configure all IDEs:      npx @opencontrib/mcp-server setup --all`);
    console.log(`  3. Preview without saving:  npx @opencontrib/mcp-server setup --dry-run`);
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
