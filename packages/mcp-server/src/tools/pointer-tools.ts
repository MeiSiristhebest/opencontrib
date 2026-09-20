import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SmartPointerStore,
  resolvePointerStoreLocation,
  type PointerView,
} from "@opencontrib/core";

export function registerPointerTools(server: McpServer): void {
  // -------------------------------------------------------------
  // Tool: contrib_resolve_pointer (3级渐进式智能指针解引用)
  // -------------------------------------------------------------
  server.tool(
    "contrib_resolve_pointer",
    "Dereference an OpenContrib Smart Pointer (ptr://...) with progressive token views: stub (Level 1, ~25 tokens), slice (Level 2, ~150 tokens), or evidence (Level 3)",
    {
      uri: z
        .string()
        .describe(
          'Smart Pointer URI, e.g. "ptr://ast-grep/ssrf-ipv6-bypass/src/fetch.ts:42"',
        ),
      view: z
        .enum(["stub", "slice", "evidence", "all"])
        .optional()
        .default("slice")
        .describe(
          "Dereferencing view granularity: stub (meta only), slice (context snippet), evidence (full proof)",
        ),
      storageDir: z
        .string()
        .optional()
        .describe(
          "Optional custom pointers directory path (defaults to the canonical OpenContrib pointer store)",
        ),
    },
    async (args) => {
      const pointerDir = resolvePointerStoreLocation({
        storageDir: args.storageDir,
        cwd: process.cwd(),
      });
      const store = new SmartPointerStore({
        storageDir: pointerDir,
        scope: process.cwd(),
      });

      try {
        const result = store.resolve(
          args.uri,
          (args.view || "slice") as PointerView,
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
                  uri: args.uri,
                  view: args.view || "slice",
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
              type: "text",
              text: JSON.stringify(
                {
                  status: "error",
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
    "contrib_list_pointers",
    "List all available OpenContrib Smart Pointers and Level 1 stub metadata across namespaces",
    {
      namespace: z
        .string()
        .optional()
        .describe('Optional namespace filter, e.g. "ast-grep" or "semgrep"'),
      storageDir: z
        .string()
        .optional()
        .describe("Optional custom pointers directory path"),
    },
    async (args) => {
      const pointerDir = resolvePointerStoreLocation({
        storageDir: args.storageDir,
        cwd: process.cwd(),
      });
      const store = new SmartPointerStore({
        storageDir: pointerDir,
        scope: process.cwd(),
      });

      try {
        const pointers = store.list(args.namespace);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: "success",
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
              type: "text",
              text: JSON.stringify(
                {
                  status: "error",
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
