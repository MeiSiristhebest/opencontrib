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
  type ProbeCost,
  type DefectCategory,
} from '@opencontrib/core';

export function registerProbeTools(server: McpServer): void {
  // -------------------------------------------------------------
  // Tool: contrib_probe_plan (仓库指纹与探测规划)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_plan',
    'Extract repository fingerprint and negotiate matching active SAST/AST probes and cost budget without executing them',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace path (defaults to current directory)'),
      maxCost: z.enum(['fast', 'medium', 'deep']).optional().default('medium').describe('Maximum allowed execution cost tier'),
      onlyProbes: z.array(z.string()).optional().describe('Optional list of probe IDs to exclusively include'),
      skipProbes: z.array(z.string()).optional().describe('Optional list of probe IDs to skip'),
    },
    async (args) => {
      try {
        const resolved = path.resolve(args.targetPath || '.');
        const fingerprint = await extractRepoFingerprint(resolved);
        const plan = negotiateProbes(
          fingerprint,
          {
            only: args.onlyProbes,
            skip: args.skipProbes,
            maxCost: args.maxCost as ProbeCost,
            checkBinaries: true,
          },
          new ProbeRegistry(),
        );

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  target: resolved,
                  fingerprint,
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
  // Tool: contrib_probe_run (执行 Microkernel 探测插件并输出 Top-K Smart Pointers)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_run',
    'Execute matching SAST/AST Microkernel probe plugins against target repository, returning triaged Top-K actionable Smart Pointers (ptr://...)',
    {
      targetPath: z.string().optional().default('.').describe('Target repository workspace directory'),
      limit: z.number().optional().default(5).describe('Maximum number of top high-value Smart Pointers to return (default 5)'),
      minConfidence: z.number().optional().default(80).describe('Minimum finding confidence threshold (0-100, default 80)'),
      onlyProbes: z.array(z.string()).optional().describe('Optional probe IDs to exclusively execute'),
      skipProbes: z.array(z.string()).optional().describe('Optional probe IDs to skip'),
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

        const severityWeights: Record<string, number> = {
          critical: 100,
          high: 85,
          medium: 60,
          low: 30,
        };

        const categoryMultipliers: Record<string, number> = {
          lifecycle_leak: 1.2,
          concurrency_race: 1.2,
          protocol_drift: 1.15,
          security_cwe: 1.1,
          numerical_bounds: 1.05,
        };

        const scoredPointers = scanResult.pointersCreated.map((ptr) => {
          const sevWeight = severityWeights[ptr.severity] || 50;
          const catMult = categoryMultipliers[ptr.category] || 1.0;
          const conf = typeof ptr.confidence === 'number' ? ptr.confidence : 80;
          const triageScore = Math.round(sevWeight * catMult * (conf / 100));

          return {
            ...ptr,
            triageScore,
            resolveCommand: `opencontrib pointer resolve ${ptr.uri} --view slice`,
          };
        });

        const minConfidence = args.minConfidence ?? 80;
        const limit = args.limit ?? 5;
        const filtered = scoredPointers.filter((p) => (p.confidence ?? 80) >= minConfidence);
        const sorted = filtered.sort((a, b) => b.triageScore - a.triageScore);
        const topPointers = sorted.slice(0, limit);

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
                  triagedPointersCount: topPointers.length,
                  triageSummary: `Identified ${scanResult.pointersCreated.length} raw findings across ${scanResult.executedProbes.length} active probes. Triaged to top ${topPointers.length} actionable high-value defect pointers.`,
                  topPointers,
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
