import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "path";
import {
  capturePreFixAssertion,
  collectEvidence,
  ContributionRunManager,
  verifyDualStageReproduction,
  captureRedEvidence,
  EvidenceService,
  resolveOpenContribPaths,
  resolvePointerStoreLocation,
  MAX_STRESS_ROUNDS,
  MAX_WORKERS_PER_ROUND,
} from "@opencontrib/core";

export function registerEvidenceTools(
  server: McpServer,
  runManager: ContributionRunManager,
): void {
  // -------------------------------------------------------------
  // Tool: contrib_collect_evidence (diagnostic compatibility only)
  // -------------------------------------------------------------
  server.tool(
    "contrib_collect_evidence",
    "Diagnostic-only evidence inspection; canonical runs must use contrib_capture_red followed by contrib_verify_green",
    {
      cwd: z
        .string()
        .describe("Workspace directory to execute test command in"),
      workspaceRoot: z
        .string()
        .optional()
        .describe(
          "Optional root workspace directory to enforce security boundary (auto-resolved from runId if omitted)",
        ),
      baselineCommitSha: z
        .string()
        .optional()
        .describe(
          "Optional baseline commit SHA before contribution changes (auto-resolved from workspace artifact in runId)",
        ),
      testCommand: z
        .string()
        .describe('Exact test command, e.g. "npm test" or "pytest"'),
      preFixAssertionProbe: z
        .string()
        .optional()
        .describe(
          "Expected failure assertion regex or snippet observed before fix (for dual-stage verification)",
        ),
      preFixTestCommand: z
        .string()
        .optional()
        .describe(
          "Optional separate reproduction script/command to trigger pre-fix failure baseline",
        ),
      stressLoopCount: z
        .number()
        .finite()
        .int()
        .min(1)
        .max(MAX_STRESS_ROUNDS)
        .optional()
        .default(1)
        .describe(
          "Number of test execution runs / stress loop iterations (default 1, use >1 for concurrency/race tests)",
        ),
      runId: z
        .string()
        .optional()
        .describe(
          "Optional runId used only to resolve the diagnostic workspace; this deprecated tool never writes authoritative evidence.",
        ),
    },
    async (args) => {
      let resolvedWorkspaceRoot = args.workspaceRoot;
      let resolvedBaselineCommitSha = args.baselineCommitSha;

      // Auto-resolve workspaceRoot and baselineCommitSha from runId if not explicitly provided
      if (args.runId) {
        try {
          const run = runManager.getRun(args.runId);
          if (run) {
            if (
              run.artifacts?.workspace?.workspacePath &&
              !resolvedWorkspaceRoot
            ) {
              resolvedWorkspaceRoot = String(
                run.artifacts.workspace.workspacePath,
              );
            }
            if (
              run.artifacts?.workspace?.baseCommitSha &&
              !resolvedBaselineCommitSha
            ) {
              resolvedBaselineCommitSha = String(
                run.artifacts.workspace.baseCommitSha,
              );
            }
          }
        } catch (err: any) {
          console.warn(
            `[evidence-tools] Error auto-resolving run "${args.runId}": ${err.message}`,
          );
        }
      }

      // Security boundary validation (now using resolvedWorkspaceRoot)
      const resolvedCwd = path.resolve(args.cwd);
      if (resolvedWorkspaceRoot) {
        const root = path.resolve(resolvedWorkspaceRoot);
        if (!resolvedCwd.startsWith(root + path.sep) && resolvedCwd !== root) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    message: `Security violation: cwd "${resolvedCwd}" escapes workspace root "${root}"`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      } else {
        // Validate cwd is within home directory
        const { baseDir, dataDir } = resolveOpenContribPaths();
        const allowedRoots = [path.resolve(baseDir), path.resolve(dataDir)];
        const isAllowed = allowedRoots.some(
          (root) =>
            resolvedCwd === root || resolvedCwd.startsWith(root + path.sep),
        );
        if (!isAllowed) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    message: `cwd "${resolvedCwd}" is outside the allowed workspace boundary. Set workspaceRoot explicitly.`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
      }

      let dualStageResult: any;

      // 1. Dual-stage verification if preFixAssertionProbe is provided
      if (args.preFixAssertionProbe) {
        const preFixCheck = capturePreFixAssertion(
          args.cwd,
          args.preFixTestCommand || args.testCommand,
          resolvedWorkspaceRoot,
          args.preFixAssertionProbe,
        );
        dualStageResult = await verifyDualStageReproduction({
          cwd: args.cwd,
          workspaceRoot: resolvedWorkspaceRoot,
          testCommand: args.testCommand,
          preFixBaselineCaptured: preFixCheck.assertionCaptured,
          preFixFailureOutput: preFixCheck.baselineOutput,
          stressLoopCount: args.stressLoopCount ?? 1,
        });
      }

      // 2. Comprehensive evidence metrics collection (flaky test baseline + handle leak check)
      const evidence = await collectEvidence({
        cwd: args.cwd,
        workspaceRoot: resolvedWorkspaceRoot,
        baselineCommitSha: resolvedBaselineCommitSha,
        testCommand: args.testCommand,
        stressLoopCount: args.stressLoopCount ?? 1,
      });

      const fullEvidenceReport = {
        ...evidence,
        reproductionVerified: dualStageResult
          ? Boolean(dualStageResult.isReproductionVerified)
          : false,
        allTestsPassing:
          evidence.stressLoopPassed &&
          (evidence.failedUnitTestsCount ?? 0) === 0,
        dualStage: dualStageResult,
      };

      const persistence: { saved: boolean; error?: string } = args.runId
        ? {
            saved: false,
            error:
              "Diagnostic evidence is not authoritative; use contrib_capture_red followed by contrib_verify_green.",
          }
        : { saved: false };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                status: persistence.error ? "PARTIAL_SUCCESS" : "success",
                deprecated: true,
                mode: "diagnostic",
                authoritative: false,
                canonicalReplacements: [
                  "contrib_capture_red",
                  "contrib_verify_green",
                ],
                evidence: fullEvidenceReport,
                persistence: args.runId ? persistence : undefined,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------
  // Tool: contrib_capture_red (Evidence V2: 捕获不可篡改 RED 基线)
  // -------------------------------------------------------------
  server.tool(
    "contrib_capture_red",
    "Capture immutable RED baseline (failing test + source tree hash) before applying fix",
    {
      cwd: z
        .string()
        .describe("Workspace directory to execute test command in"),
      testCommand: z
        .string()
        .describe("Test command expected to FAIL on baseline"),
      assertion: z
        .string()
        .optional()
        .describe("Expected failure assertion regex"),
      runId: z
        .string()
        .optional()
        .describe("Contribution run ID to persist RED baseline into"),
      baselineCommitSha: z
        .string()
        .optional()
        .describe("Baseline commit SHA before changes"),
      workspaceRoot: z.string().optional().describe("Root workspace directory"),
    },
    async (args) => {
      try {
        let red;
        let persistence: { saved: boolean; error?: string } = { saved: false };
        if (args.runId) {
          const evidenceService = new EvidenceService(runManager);
          red = evidenceService.captureRed({
            runId: args.runId,
            cwd: args.cwd,
            testCommand: args.testCommand,
            workspaceRoot: args.workspaceRoot,
            expectedAssertion: args.assertion,
            baselineCommitSha: args.baselineCommitSha,
          });
          persistence = { saved: true };
        } else {
          red = captureRedEvidence({
            cwd: args.cwd,
            testCommand: args.testCommand,
            workspaceRoot: args.workspaceRoot,
            expectedAssertion: args.assertion,
            baselineCommitSha: args.baselineCommitSha,
          });
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: red.assertionMatched ? "success" : "failed",
                  redEvidence: red,
                  persistence: args.runId ? persistence : undefined,
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
                { status: "error", message: err.message },
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
  // Tool: contrib_verify_green (Evidence V2: 验证 GREEN 并与 RED 绑定推进阶段)
  // -------------------------------------------------------------
  server.tool(
    "contrib_verify_green",
    "Verify GREEN run, bind it to previously captured RED baseline, and advance to EVIDENCE_COLLECTED",
    {
      cwd: z
        .string()
        .describe("Workspace directory to execute test command in"),
      testCommand: z
        .string()
        .describe("Test command expected to PASS after fix"),
      runId: z
        .string()
        .describe("Contribution run holding the captured RED artifact"),
      stressLoopCount: z
        .number()
        .finite()
        .int()
        .min(1)
        .max(MAX_STRESS_ROUNDS)
        .optional()
        .default(1)
        .describe("Stress loop iterations (integer 1..100)"),
      concurrencyWorkers: z
        .number()
        .finite()
        .int()
        .min(1)
        .max(MAX_WORKERS_PER_ROUND)
        .optional()
        .default(1)
        .describe("Concurrent workers (integer 1..32)"),
      baselineCommitSha: z.string().optional().describe("Baseline commit SHA"),
      workspaceRoot: z.string().optional().describe("Root workspace directory"),
    },
    async (args) => {
      try {
        const evidenceService = new EvidenceService(runManager);
        const report = await evidenceService.verifyGreen({
          runId: args.runId,
          cwd: args.cwd,
          testCommand: args.testCommand,
          workspaceRoot: args.workspaceRoot,
          baselineCommitSha: args.baselineCommitSha,
          stressLoopCount: args.stressLoopCount ?? 1,
          concurrencyWorkers: args.concurrencyWorkers ?? 1,
        });
        const persistence: { saved: boolean; error?: string } = {
          saved: report.reproductionVerified === true,
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: report.reproductionVerified ? "success" : "failed",
                  evidence: report,
                  persistence,
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
                { status: "error", message: err.message },
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
  // Tool: contrib_verify_poc (执行自主 Fail-First PoC 闭环验证)
  // -------------------------------------------------------------
  server.tool(
    "contrib_verify_poc",
    "Execute autonomous 4-phase closed-loop verification (Red -> Green -> Blue) for a Smart Pointer finding inside a clean-room worktree sandbox",
    {
      repoPath: z.string().describe("Target repository path"),
      pointerUri: z
        .string()
        .describe(
          'Smart Pointer URI to verify, e.g. "ptr://ast-grep/ssrf-test/src/fetch.ts:42"',
        ),
      testCommand: z
        .string()
        .optional()
        .describe("Optional custom test command override"),
      timeoutMs: z
        .number()
        .optional()
        .default(30000)
        .describe("Execution timeout in ms"),
      runId: z
        .string()
        .optional()
        .describe(
          "Optional runId to automatically record poc artifact and advance phase to POC_GENERATED",
        ),
    },
    async (args) => {
      try {
        const { AutonomousPoCVerifier, SmartPointerStore } =
          await import("@opencontrib/core");

        // Validate repoPath against home directory boundary
        const resolvedRepoPath = path.resolve(args.repoPath);
        const { baseDir, dataDir } = resolveOpenContribPaths();
        const allowedRoots = [path.resolve(baseDir), path.resolve(dataDir)];
        const isAllowed = allowedRoots.some(
          (root) =>
            resolvedRepoPath === root ||
            resolvedRepoPath.startsWith(root + path.sep),
        );
        if (!isAllowed) {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    status: "error",
                    message: `repoPath "${resolvedRepoPath}" is outside the allowed workspace boundary`,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        const pointerDir = resolvePointerStoreLocation({
          workspacePath: resolvedRepoPath,
          cwd: resolvedRepoPath,
          scope: resolvedRepoPath,
        });
        const store = new SmartPointerStore({
          storageDir: pointerDir,
          scope: resolvedRepoPath,
        });

        let finding: any;
        try {
          const resolved = store.resolve(args.pointerUri, "stub");
          finding = resolved;
        } catch {
          // Fallback minimal finding stub
          finding = {
            id: args.pointerUri.split("/").pop() || "finding-0",
            namespace: "custom",
            title: "Custom Defect Finding",
            category: "security_cwe",
            severity: "high",
            file: "unknown",
            line: 1,
            confidence: 80,
          };
        }

        const report = await AutonomousPoCVerifier.verifyFinding(
          resolvedRepoPath,
          finding,
          {
            testCommand: args.testCommand,
            timeoutMs: args.timeoutMs,
          },
        );

        if (args.runId) {
          try {
            runManager.saveArtifact(args.runId, "poc", report as any);
          } catch (err: any) {
            console.warn(
              `[evidence-tools] Failed to auto-save poc artifact: ${err.message}`,
            );
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  status: report.status === "VERIFIED" ? "success" : "failed",
                  report,
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
                { status: "error", message: err.message },
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
