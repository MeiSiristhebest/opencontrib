import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import * as path from 'path';
import {
  extractRepoFingerprint,
  negotiateProbes,
  analyzeGitHotspots,
  generatePropertyTest,
  generateCombinatorialMatrix,
  VariantHunter,
  ProbeRegistry,
  createDefaultPluginHost,
  triagePointerFindings,
  buildContributionRunManager,
  getLocalRepositoryFullName,
  type ContributionRunManager,
  type ProbeCost,
  type DefectCategory,
} from '@opencontrib/core';

export function registerProbeTools(server: McpServer, suppliedRunManager?: ContributionRunManager): void {
  const runManager = suppliedRunManager ?? buildContributionRunManager();
  const requireRun = (requestedRunId?: string): string => {
    const runId = runManager.resolveRunId(requestedRunId);
    if (!runId || !runManager.getRun(runId)) {
      throw new Error('An existing contribution run is required before probing; create a run first.');
    }
    return runId;
  };
  const saveProbe = (runId: string, result: Record<string, unknown>): void => {
    runManager.saveArtifact(runId, 'probe', {
      ...runManager.getRun(runId)!.artifacts.probe,
      ...result,
    });
  };
  // -------------------------------------------------------------
  // Tool: contrib_probe_plan (仓库指纹与探测规划)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_plan',
    'Extract repository fingerprint and negotiate matching active SAST/AST/Concurrency probe plugins with cost profiles',
    {
      runId: z.string().optional().describe('Contribution run ID (defaults to the active run)'),
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
        const runId = requireRun(args.runId);
        const resolved = path.resolve(args.targetPath || '.');
        runManager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));
        const fingerprint = await extractRepoFingerprint(resolved);
        const plan = await negotiateProbes(fingerprint, {
          categoryFilter: args.category as DefectCategory | undefined,
          maxCost: args.maxCost as ProbeCost,
          includeOptional: args.includeOptional,
        } as any);
        saveProbe(runId, { target: resolved, plan });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  runId,
                  currentPhase: runManager.getRun(runId)!.manifest.currentPhase,
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
      runId: z.string().optional().describe('Contribution run ID (defaults to the active run)'),
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      onlyProbes: z.array(z.string()).optional().describe('Execute only specific probe IDs (e.g. ["ast-grep", "semgrep-sast"])'),
      skipProbes: z.array(z.string()).optional().describe('Skip specific probe IDs'),
      limit: z.number().optional().default(5).describe('Maximum number of top findings to return'),
      minConfidence: z.number().optional().default(80).describe('Minimum confidence threshold (0-100)'),
    },
    async (args) => {
      try {
        const runId = requireRun(args.runId);
        const resolved = path.resolve(args.targetPath || '.');
        runManager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));
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
        saveProbe(runId, {
          target: resolved,
          executedProbes: scanResult.executedProbes,
          totalPointersCount: scanResult.pointersCreated.length,
          triagedPointersCount: triaged.triagedCount,
          topPointers: triaged.topPointers,
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
                  runId,
                  currentPhase: runManager.getRun(runId)!.manifest.currentPhase,
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
      runId: z.string().optional().describe('Contribution run ID (defaults to the active run)'),
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      limit: z.number().optional().default(5).describe('Number of top hotspot files to return'),
      sinceMonths: z.number().optional().default(6).describe('Months of Git history to analyze'),
    },
    async (args) => {
      try {
        const runId = requireRun(args.runId);
        const resolved = path.resolve(args.targetPath || '.');
        runManager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));
        const result = analyzeGitHotspots(resolved, {
          limit: args.limit ?? 5,
          sinceMonths: args.sinceMonths ?? 6,
        });
        saveProbe(runId, { target: resolved, hotspots: result });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  runId,
                  currentPhase: runManager.getRun(runId)!.manifest.currentPhase,
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
      runId: z.string().optional().describe('Contribution run ID (defaults to the active run)'),
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
        const runId = requireRun(args.runId);
        const resolved = path.resolve(args.targetPath || '.');
        runManager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));
        let lang = args.language;
        if (!lang) {
          const fingerprint = await extractRepoFingerprint(resolved);
          const langLower = fingerprint.primaryLanguage.toLowerCase();
          lang = ['typescript', 'javascript', 'python', 'rust', 'go'].includes(langLower)
            ? (langLower as any)
            : 'typescript';
        }

        const spec = generatePropertyTest(args.category as DefectCategory, lang as any, args.functionName || 'processInput');
        saveProbe(runId, { target: resolved, fuzz: { language: lang, spec } });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  runId,
                  currentPhase: runManager.getRun(runId)!.manifest.currentPhase,
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

  // -------------------------------------------------------------
  // Tool: contrib_probe_variant_hunt (变体猎杀与同类调用点排查)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_variant_hunt',
    'Hunt for parallel structural defect variants across the repository using ast-grep and ripgrep',
    {
      runId: z.string().optional().describe('Contribution run ID (defaults to active run)'),
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      symbol: z.string().describe('Symbol or function name to search for across sister modules'),
      file: z.string().optional().describe('Source file where the primary defect was located'),
      line: z.number().optional().describe('Line number of primary defect'),
    },
    async (args) => {
      try {
        const runId = requireRun(args.runId);
        const resolved = path.resolve(args.targetPath || '.');
        runManager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));

        const variants = await VariantHunter.huntSymbol(resolved, args.symbol, {
          file: args.file,
          line: args.line,
        });

        saveProbe(runId, {
          target: resolved,
          variantHunt: {
            symbol: args.symbol,
            count: variants.length,
            variants,
            executedAt: new Date().toISOString(),
          },
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  runId,
                  currentPhase: runManager.getRun(runId)!.manifest.currentPhase,
                  target: resolved,
                  symbol: args.symbol,
                  variantsCount: variants.length,
                  variants,
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
  // Tool: contrib_probe_matrix (组合变体矩阵与 3D 测试生成)
  // -------------------------------------------------------------
  server.tool(
    'contrib_probe_matrix',
    'Generate combinatorial mutation matrix and 3D parameterized test scenarios (normal, boundary, failure injection)',
    {
      runId: z.string().optional().describe('Contribution run ID (defaults to active run)'),
      targetPath: z.string().optional().default('.').describe('Target repository workspace path'),
      title: z.string().optional().describe('Issue or PR title'),
      body: z.string().optional().describe('Issue or PR body description'),
      diff: z.string().optional().describe('Unified diff or patch text'),
      language: z.string().optional().describe('Target language (defaults to repository fingerprint)'),
    },
    async (args) => {
      try {
        const runId = requireRun(args.runId);
        const resolved = path.resolve(args.targetPath || '.');
        runManager.assertRepositoryTarget(runId, getLocalRepositoryFullName(resolved));

        let lang = args.language;
        if (!lang) {
          try {
            const fingerprint = await extractRepoFingerprint(resolved);
            lang = fingerprint.primaryLanguage;
          } catch {
            lang = undefined;
          }
        }

        const report = generateCombinatorialMatrix({
          diffText: args.diff,
          issueTitle: args.title,
          issueBody: args.body,
          primaryLanguage: lang,
        });

        saveProbe(runId, {
          target: resolved,
          matrix: report,
        });

        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  status: 'success',
                  runId,
                  currentPhase: runManager.getRun(runId)!.manifest.currentPhase,
                  target: resolved,
                  domain: report.domain,
                  rationale: report.domainRationale,
                  dimensions: report.dimensions,
                  scenarios: report.scenarios,
                  recommendedAssertions: report.recommendedAssertions,
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
