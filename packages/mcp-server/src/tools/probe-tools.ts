import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'path';
import {
  extractRepoFingerprint,
  negotiateProbes,
  analyzeGitHotspots,
  generatePropertyTest,
  ProbeRegistry,
  createDefaultPluginHost,
  triagePointerFindings,
  type ProbeCost,
  type DefectCategory,
} from '@opencontrib/core';

export function registerProbeTools(server: McpServer): void {
  // -------------------------------------------------------------
  // Tool: contrib_probe_plan (仓库指纹与探测规划)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_plan',
    'Extract repository fingerprint and negotiate matching active SAST/AST/Concurrency probe plugins with cost profiles',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      category: z
        .enum([
          'lifecycle_leak',
          'concurrency_race',
          'protocol_drift',
          'security_cwe',
          'numerical_bounds',
          'dead_code',
          'ci_workflow',
        ])
        .optional()
        .describe('Filter probes targeting specific defect archetype'),
      maxCost: z.enum(['fast', 'medium', 'deep']).optional().default('medium').describe('Maximum allowable probe execution cost profile'),
      includeOptional: z.boolean().optional().default(false).describe('Include optional uninstalled or community probes'),
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.targetPath || '.');
        const fingerprint = await extractRepoFingerprint(resolved);
        const plan = await negotiateProbes(fingerprint, {
          target: resolved,
          categoryFilter: args.category as DefectCategory | undefined,
          maxCost: args.maxCost as ProbeCost,
          includeOptional: args.includeOptional,
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
  // Tool: contrib_probe_run (执行探测器并生成 Smart Pointer)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_run',
    'Execute negotiated SAST/AST probe plugins against repository and return triaged Top-K Smart Pointer URIs (ptr://...)',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      onlyProbes: z.array(z.string()).optional().describe('Execute only specific probe IDs (e.g. ["ast-grep", "semgrep-sast"])'),
      skipProbes: z.array(z.string()).optional().describe('Skip specific probe IDs'),
      limit: z.number().optional().default(5).describe('Maximum number of top findings to return'),
      minConfidence: z.number().optional().default(80).describe('Minimum confidence threshold (0-100)'),
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.targetPath || '.');
        const fingerprint = await extractRepoFingerprint(resolved);
        const host = await createDefaultPluginHost({ workspacePath: resolved });

        const matchingProbes = host.listAll().filter((probe) => {
          if (args.onlyProbes && !args.onlyProbes.includes(probe.id)) return false;
          if (args.skipProbes && args.skipProbes.includes(probe.id)) return false;
          return probe.match(fingerprint);
        });

        const scanResult = await host.executeScan(resolved, matchingProbes);

        const triaged = triagePointerFindings(scanResult.pointersCreated, {
          limit: args.limit ?? 5,
          minConfidence: args.minConfidence ?? 80,
          includeAll: false,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  target: resolved,
                  executedProbes: scanResult.executedProbes,
                  totalFindingsCount: scanResult.pointersCreated.length,
                  triagedPointersCount: triaged.triagedCount,
                  triageSummary: triaged.summary,
                  topPointers: triaged.topPointers,
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
  // Tool: contrib_probe_hotspot (代码热点与 Git Churn 复杂度分析)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_hotspot',
    'Analyze Git commit churn and cyclomatic complexity hotspots to pinpoint high-risk, defect-prone files',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      limit: z.number().optional().default(5).describe('Number of top hotspot files to return'),
      sinceMonths: z.number().optional().default(6).describe('Months of Git history to analyze'),
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.targetPath || '.');
        const result = analyzeGitHotspots(resolved, {
          limit: args.limit ?? 5,
          sinceMonths: args.sinceMonths ?? 6,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  target: resolved,
                  result,
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
  // Tool: contrib_probe_fuzz (属性基模糊测试与边界用例生成)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_fuzz',
    'Generate property-based boundary fuzzing test scaffold for target language and defect category',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      category: z
        .string()
        .optional()
        .default('numerical_bounds')
        .describe('Target defect category (e.g. numerical_bounds, protocol_drift, distributed_cache)'),
      functionName: z.string().optional().default('processInput').describe('Target function to test'),
      language: z.enum(['typescript', 'javascript', 'python', 'rust', 'go']).optional().describe('Programming language override'),
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.targetPath || '.');
        let lang = args.language;
        if (!lang) {
          const fingerprint = await extractRepoFingerprint(resolved);
          const langLower = fingerprint.primaryLanguage.toLowerCase();
          lang = ['typescript', 'javascript', 'python', 'rust', 'go'].includes(langLower)
            ? (langLower as any)
            : 'typescript';
        }

        const spec = generatePropertyTest(args.category as DefectCategory, lang as any, args.functionName || 'processInput');

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  target: resolved,
                  language: lang,
                  spec,
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
