import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'path';
import { SmartPointerStore, type PointerView } from '@opencontrib/core';

export function registerPointerTools(server: McpServer): void {
  // -------------------------------------------------------------
  // Tool: contrib_resolve_pointer (3级渐进式智能指针解引用)
  // -------------------------------------------------------------
  server.tool(
    'contrib_resolve_pointer',
    'Dereference an OpenContrib Smart Pointer (ptr://...) with progressive token views: stub (Level 1, ~25 tokens), slice (Level 2, ~150 tokens), or evidence (Level 3)',
    {
      uri: z.string().describe('Smart Pointer URI, e.g. "ptr://ast-grep/ssrf-ipv6-bypass/src/fetch.ts:42"'),
      view: z
        .enum(['stub', 'slice', 'evidence', 'all'])
        .optional()
        .default('slice')
        .describe('Dereferencing view granularity: stub (meta only), slice (context snippet), evidence (full proof)'),
      storageDir: z
        .string()
        .optional()
        .describe('Optional custom pointers directory path (defaults to .opencontrib/pointers in current working directory)'),
    },
    async (args) => {
      const pointerDir = args.storageDir || path.join(process.cwd(), '.opencontrib', 'pointers');
      const store = new SmartPointerStore(pointerDir);

      try {
        const result = store.resolve(args.uri, (args.view || 'slice') as PointerView);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  uri: args.uri,
                  view: args.view || 'slice',
                  data: result,
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
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'error',
                  message: err.message,
                  uri: args.uri,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_list_pointers (列出可用智能指针元数据)
  // -------------------------------------------------------------
  server.tool(
    'contrib_list_pointers',
    'List all available OpenContrib Smart Pointers and Level 1 stub metadata across namespaces',
    {
      namespace: z.string().optional().describe('Optional namespace filter, e.g. "ast-grep" or "semgrep"'),
      storageDir: z.string().optional().describe('Optional custom pointers directory path'),
    },
    async (args) => {
      const pointerDir = args.storageDir || path.join(process.cwd(), '.opencontrib', 'pointers');
      const store = new SmartPointerStore(pointerDir);

      try {
        const pointers = store.list(args.namespace);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  count: pointers.length,
                  pointers: pointers.map((p) => p.stub),
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
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'error',
                  message: err.message,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );
}
