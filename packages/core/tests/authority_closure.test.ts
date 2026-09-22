import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ArtifactBundleManager } from "../src/run/artifact-bundle.js";
import { ContributionRunManager } from "../src/run/run-manager.js";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import { IssueBindingService } from "../src/github/issue-binding-service.js";
import { SecurityDisclosureService } from "../src/github/security-disclosure-service.js";

function baseDir(name: string): string {
  return join(
    process.env.OPENCONTRIB_HOME ?? ".",
    `authority-closure-${name}-${Date.now()}`,
  );
}

describe("Authority closure", () => {
  it("creates issue_binding only from a provider response", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("issue") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    const provider = {
      getIssue: async () => ({
        status: "OK" as const,
        data: {
          number: 42,
          title: "Fix the verified issue",
          state: "open" as const,
          htmlUrl: "https://github.com/owner/repo/issues/42",
        },
      }),
    };

    const artifact = await new IssueBindingService(manager, provider).bind({
      runId: run.runId,
      repoFullName: "owner/repo",
      issueNumber: 42,
    });

    expect(artifact.providerVerified).toBe(true);
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toEqual(artifact);
    expect(() =>
      manager.saveArtifact(run.runId, "issue_binding", artifact as any),
    ).toThrow("AuthoritativeArtifactViolationError");
  });

  it("records a provider-verified private channel and blocks public submission", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("security") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    saveCanonicalArtifact(
      manager,
      run.runId,
      "workspace",
      {
        baseBranch: "main",
        baseCommitSha: "a".repeat(40),
        communityGate: {
          policy: { privateVulnerabilityDisclosure: true },
        },
      },
      "WORKSPACE_PREPARED",
    );
    const provider = {
      getRepoTextFile: async () =>
        "Report vulnerabilities privately to the security maintainers.",
    };

    const artifact = await new SecurityDisclosureService(manager, provider).verifyPrivateChannel({
      runId: run.runId,
      repoFullName: "owner/repo",
    });

    expect(artifact.providerVerified).toBe(true);
    expect(artifact.publicDisclosureAllowed).toBe(false);
    expect(() =>
      new SecurityDisclosureService(manager, provider).assertPublicSubmissionAllowed(
        run.runId,
      ),
    ).toThrow("PublicDisclosureBlockedError");
  });

  it("stores patch attempts append-only", () => {
    const runId = "run_patch_attempts";
    const bundles = new ArtifactBundleManager(baseDir("patch"));
    bundles.saveArtifact(runId, "patch_attempt", { attemptNumber: 1 });
    bundles.saveArtifact(runId, "patch_attempt", { attemptNumber: 2 });

    expect(
      bundles
        .listArtifactFiles(runId)
        .filter((name) => /^patch_attempt_\d+\.json$/.test(name)),
    ).toHaveLength(2);
    expect(
      bundles.readArtifact<Record<string, unknown>>(runId, "patch_attempt"),
    ).toEqual({
      attemptNumber: 2,
    });
  });

  it("does not expose patch-attempt history through generic run writes", () => {
    const runManager = new ContributionRunManager({ baseDir: baseDir("generic") });
    const run = runManager.createRun({ repoFullName: "owner/repo" });

    expect(() =>
      runManager.saveArtifact(run.runId, "patch_attempt", {
        attemptNumber: 1,
      }),
    ).toThrow("AuthoritativeArtifactViolationError");
  });
});
