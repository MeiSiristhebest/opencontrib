import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ContributionRunManager,
  ProfileFlywheel,
  RepoMemoryLedger,
  WorktreeManager,
} from '@opencontrib/core';
import { registerDiscoveryTools } from './tools/discovery-tools.js';
import { registerWorkspaceTools } from './tools/workspace-tools.js';
import { registerEvidenceTools } from './tools/evidence-tools.js';
import { registerGovernanceTools } from './tools/governance-tools.js';
import { registerRunTools } from './tools/run-tools.js';
import { registerEvalTools } from './tools/eval-tools.js';
import { registerPointerTools } from './tools/pointer-tools.js';
import { registerProbeTools } from './tools/probe-tools.js';
import { registerCapabilityTools } from './tools/capability-tools.js';
import { registerResources } from './resources/index.js';
import { registerPrompts } from './prompts/index.js';


export function createOpenContribMcpServer(): McpServer {
  const server = new McpServer({
    name: 'opencontrib-engine',
    version: '1.0.0',
  });

  // Domain state singletons
  const memory = new RepoMemoryLedger();
  const flywheel = new ProfileFlywheel();
  const worktreeManager = new WorktreeManager();
  const runManager = new ContributionRunManager();

  // Register modular tools across domains
  registerDiscoveryTools(server);
  registerWorkspaceTools(server, worktreeManager, runManager);
  registerEvidenceTools(server, runManager);
  registerGovernanceTools(server, memory, flywheel);
  registerRunTools(server, runManager);
  registerEvalTools(server);
  registerPointerTools(server);
  registerProbeTools(server);
  registerCapabilityTools(server);

  // Register resources and workflow prompts
  registerResources(server, memory, runManager);
  registerPrompts(server);

  return server;
}
