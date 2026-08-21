import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'path';
import { createDefaultPluginHost, extractRepoFingerprint } from '@opencontrib/core';

export function registerCapabilityTools(server: McpServer): void {
  // -------------------------------------------------------------
  // Tool: contrib_plan_capabilities (能力路由与执行计划规划)
  // -------------------------------------------------------------
  server.tool(
    'contrib_plan_capabilities',
    'Evaluate repository fingerprint and agent intent to generate an optimized, scored capability routing plan across security, concurrency, and defect domains',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      intent: z
        .string()
        .optional()
        .default('general')
        .describe('Agent intent: general, deep_security, concurrency_hunt, or hygiene'),
      enableHeavy: z.boolean().optional().default(false).describe('Enable heavy/slow scan providers (e.g. deep static analysis)'),
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.targetPath || '.');
        const fingerprint = await extractRepoFingerprint(resolved);
        const host = await createDefaultPluginHost({ workspacePath: resolved });

        const plan = host.router.planRouting(fingerprint, {
          intent: args.intent || 'general',
          enableHeavy: args.enableHeavy ?? false,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  target: resolved,
                  plan,
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }, null, 2) }],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_list_plugins (列出已加载的 Microkernel 插件与探针)
  // -------------------------------------------------------------
  server.tool(
    'contrib_list_plugins',
    'List all active Microkernel security plugins, AST analyzers, and registered probe adapters',
    {},
    async () => {
      try {
        const host = await createDefaultPluginHost();
        const plugins = host.listPlugins();
        const probes = host.listAll();

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  pluginsCount: plugins.length,
                  probesCount: probes.length,
                  plugins,
                  probes: probes.map((p) => ({
                    id: p.id,
                    name: p.name,
                    category: p.category,
                    description: p.description,
                  })),
                },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          isError: true,
          content: [{ type: 'text', text: JSON.stringify({ status: 'error', message: err.message }, null, 2) }],
        };
      }
    },
  );
}
