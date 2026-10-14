import { describe, it, expect } from "bun:test";
import {
  scoreCandidateIssue,
  resolveLcovReportPath,
  RunTransferBundleSchema,
  buildKernelIsolationCommand,
  createDefaultPluginHost,
  PluginManager,
  TOOL_REGISTRY,
  mergeReproductionFilesIntoPatch,
  type PatchDraft,
  type CodeChangeFile,
} from "../src/index.js";

describe("6 Deep Architectural Mechanisms & Resilience Verification", () => {
  describe("Patch 1: Reproduction Test Merge and CREATE Conflict Prevention", () => {
    it("ensures mergeReproductionFiles preserves both regression tests and patch implementation without duplication", async () => {
      const initialPatch: PatchDraft = {
        title: "fix: sample bug",
        summary: "fixing bug",
        rationale: "reproducible failure",
        targetFiles: [{ path: "src/index.ts", reason: "Implementation" }],
        files: [
          {
            path: "src/index.ts",
            operation: "MODIFY",
            content: "export const x = 1;",
            mode: "100644",
            explanation: "fix defect",
          },
        ],
        implementationSteps: ["step 1"],
        regressionTestPlan: ["test 1"],
        estimatedDiffLines: 10,
      };

      const reproFiles: CodeChangeFile[] = [
        {
          path: "tests/regression.test.ts",
          operation: "CREATE",
          content: "test('repro', () => {})",
          mode: "100644",
          explanation: "reproduction test",
        },
        // Duplicate path in reproFiles that is already in patch.files
        {
          path: "src/index.ts",
          operation: "MODIFY",
          content: "export const x = 2;",
          mode: "100644",
          explanation: "duplicate in repro",
        },
      ];

      const merged = mergeReproductionFilesIntoPatch(initialPatch, reproFiles);

      // Verify regression test was added
      expect(merged.files.some((f) => f.path === "tests/regression.test.ts")).toBe(true);
      // Verify no duplicates
      const indexFiles = merged.files.filter((f) => f.path === "src/index.ts");
      expect(indexFiles.length).toBe(1);
      expect(merged.files.length).toBe(2);
      expect(merged.targetFiles.some((tf) => tf.path === "tests/regression.test.ts")).toBe(true);
    });
  });

  describe("Patch 2: Probe ID Aliases & PluginManager State Gating", () => {
    it("resolves probe aliases for semgrep, ruff, knip, hotspot, and go analyzers", async () => {
      const host = await createDefaultPluginHost();
      const probes = host.listAll();

      const semgrep = probes.find((p) => p.id === "semgrep-sast");
      expect(semgrep).toBeDefined();
      expect(semgrep?.aliases).toContain("semgrep");

      const ruff = probes.find((p) => p.id === "ruff-python");
      expect(ruff).toBeDefined();
      expect(ruff?.aliases).toContain("ruff");

      const knip = probes.find((p) => p.id === "knip-dead-code");
      expect(knip).toBeDefined();
      expect(knip?.aliases).toContain("knip");

      const hotspot = probes.find((p) => p.id === "git-hotspot");
      expect(hotspot).toBeDefined();
      expect(hotspot?.aliases).toContain("hotspot");

      const go = probes.find((p) => p.id === "go-analyzers");
      expect(go).toBeDefined();
      expect(go?.aliases).toContain("nilaway");
      expect(go?.aliases).toContain("noctx");
    });

    it("allows PluginManager to correctly report isEnabled for canonical names and plugin IDs, and false for unknown IDs", () => {
      const pm = new PluginManager();
      // Canonical & aliases enabled by default
      expect(pm.isEnabled("semgrep")).toBe(true);
      expect(pm.isEnabled("semgrep-sast")).toBe(true);
      expect(pm.isEnabled("ruff")).toBe(true);
      expect(pm.isEnabled("ruff-python")).toBe(true);
      expect(pm.isEnabled("knip")).toBe(true);
      expect(pm.isEnabled("knip-dead-code")).toBe(true);
      expect(pm.isEnabled("hotspot")).toBe(true);
      expect(pm.isEnabled("git-hotspot")).toBe(true);
      expect(pm.isEnabled("go-analyzers")).toBe(true);
      expect(pm.isEnabled("nilaway")).toBe(true);

      // Unknown IDs return false
      expect(pm.isEnabled("nonexistent-tool-xyz")).toBe(false);

      // Built-in probes default to enabled in state
      expect(pm.getState("property-fuzz").enabled).toBe(true);
      expect(pm.getState("piolium").enabled).toBe(true);
      expect(pm.getState("workflow-linter").enabled).toBe(true);
    });

    it("verifies tool-registry probeIds map both primary and plugin IDs", () => {
      const semgrepEntry = TOOL_REGISTRY.find((t) => t.id === "semgrep");
      expect(semgrepEntry?.probeIds).toContain("semgrep");
      expect(semgrepEntry?.probeIds).toContain("semgrep-sast");

      const ruffEntry = TOOL_REGISTRY.find((t) => t.id === "ruff");
      expect(ruffEntry?.probeIds).toContain("ruff");
      expect(ruffEntry?.probeIds).toContain("ruff-python");
    });
  });

  describe("Patch 3: Universal Test Coverage Path Resolution", () => {
    it("resolves LCOV paths across Bun, Vitest, Jest, Pytest, and Cargo llvm-cov", () => {
      expect(
        resolveLcovReportPath({ executable: "vitest", args: ["run", "--coverage"] }),
      ).toBe("coverage/lcov.info");

      expect(
        resolveLcovReportPath({
          executable: "vitest",
          args: ["run", "--coverage", "--reportsDirectory=custom-cov"],
        }),
      ).toBe("custom-cov/lcov.info");

      expect(
        resolveLcovReportPath({ executable: "jest", args: ["--coverage"] }),
      ).toBe("coverage/lcov.info");

      expect(
        resolveLcovReportPath({
          executable: "jest",
          args: ["--coverage", "--coverageDirectory=jest-cov"],
        }),
      ).toBe("jest-cov/lcov.info");

      // Pytest with explicit LCOV report
      expect(
        resolveLcovReportPath({
          executable: "pytest",
          args: ["-v", "--cov=src", "--cov-report=lcov"],
        }),
      ).toBe("coverage/lcov.info");

      expect(
        resolveLcovReportPath({
          executable: "pytest",
          args: ["-v", "--cov=src", "--cov-report=lcov:cov/my.info"],
        }),
      ).toBe("cov/my.info");

      // Pytest with XML report should return undefined (not LCOV)
      expect(
        resolveLcovReportPath({
          executable: "pytest",
          args: ["-v", "--cov=src", "--cov-report=xml"],
        }),
      ).toBeUndefined();

      expect(
        resolveLcovReportPath({ executable: "cargo", args: ["llvm-cov", "--lcov"] }),
      ).toBe("lcov.info");

      expect(
        resolveLcovReportPath({
          executable: "bun",
          args: ["test", "--coverage", "--coverage-reporter=lcov", "--coverage-dir=cov"],
        }),
      ).toBe("cov/lcov.info");
    });
  });

  describe("Patch 5: RunTransferBundleSchema Probe & Subagent Artifacts", () => {
    it("validates RunTransferBundle containing probe findings and subagent scores", () => {
      const bundle = {
        protocolVersion: "1.0" as const,
        manifest: {
          schemaVersion: "1.0",
          runId: "run-20261014-0001-abcd",
          repoFullName: "owner/repo",
          createdAt: new Date().toISOString(),
        },
        patch: {
          title: "fix: test fix",
          summary: "test summary",
          targetFiles: [],
          files: [],
        },
        prDraft: "## PR Title\nBody",
        redRecipe: {
          command: "bun test",
          expectedAssertion: "expect(1).toBe(2)",
          testFiles: ["test.ts"],
        },
        probe: {
          variantHunt: { scenarios: 5 },
          matrix: { scenarios: [{ id: "s1" }] },
        },
        subagentScore: 95,
      };

      const parsed = RunTransferBundleSchema.parse(bundle);
      expect(parsed.probe).toBeDefined();
      expect(parsed.subagentScore).toBe(95);
    });
  });

  describe("Patch 6: Feasibility Multiplicative Gating & Native OS Sandbox Isolation", () => {
    it("strictly gates candidate score to 0 when an issue is hard blocked", () => {
      const now = Date.now();
      const blockedScoring = scoreCandidateIssue({
        profile: {
          techStack: ["typescript"],
          focusAreas: ["tooling"],
        },
        issue: {
          title: "Critical memory bug in typescript typechecker",
          body: "Reproducible crash with extensive code example",
          labels: ["bug", "help wanted"],
          createdAt: new Date(now - 1000).toISOString(),
          repoStars: 10000,
        },
        feasibility: {
          level: "hard_blocked",
          scorePenalty: 100,
          scope: "hardware_specific",
          detectedRisks: ["requires_specialized_hardware"],
          missingCapabilities: [],
          mitigations: [],
          rationale: "Hardware dependency blocked",
        },
        now,
      });

      expect(blockedScoring.rawScore).toBe(0);
      expect(blockedScoring.adjustedScore).toBe(0);
    });

    it("buildKernelIsolationCommand provides safe fallback on Windows/unsupported environments", () => {
      const command = buildKernelIsolationCommand(
        "node",
        ["index.js"],
        process.cwd(),
        ["/root/.ssh"],
      );
      if (process.platform === "win32") {
        expect(command.executable).toBe("node");
        expect(command.args).toEqual(["index.js"]);
        expect(command.isKernelIsolated).toBe(false);
      } else {
        expect(command.executable).toBeDefined();
        expect(command.args).toBeDefined();
      }
    });
  });
});
