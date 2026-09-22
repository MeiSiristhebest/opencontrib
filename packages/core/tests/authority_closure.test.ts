import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { ArtifactBundleManager } from "../src/run/artifact-bundle.js";
import { ContributionRunManager } from "../src/run/run-manager.js";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import { IssueBindingService } from "../src/github/issue-binding-service.js";
import { IssueCreationService } from "../src/github/issue-creation-service.js";
import { SecurityDisclosureService } from "../src/github/security-disclosure-service.js";

function baseDir(name: string): string {
  return join(
    process.env.OPENCONTRIB_HOME ?? ".",
    `authority-closure-${name}-${Date.now()}`,
  );
}

describe("Authority closure", () => {
  it("creates a provider issue and seals its returned identity before binding", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("create-issue") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    let created = false;
    const issue = {
      number: 73,
      title: "Provider-created issue",
      state: "open" as const,
      htmlUrl: "https://github.com/owner/repo/issues/73",
    };
    const provider = {
      createIssue: async () => {
        created = true;
        return { status: "OK" as const, data: issue };
      },
      getIssue: async () => ({ status: "OK" as const, data: issue }),
    };

    const binding = await new IssueCreationService(manager, provider).createAndBind({
      runId: run.runId,
      repoFullName: "owner/repo",
      title: "ignored after provider creation",
      body: "A provider-backed issue claim.",
    });

    expect(created).toBe(true);
    expect(binding.providerIssueId).toBe(73);
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toEqual(binding);
  });

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

  it("requires append-only provider lifecycle events before public security submission", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("security-lifecycle") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    saveCanonicalArtifact(
      manager,
      run.runId,
      "workspace",
      {
        baseBranch: "main",
        baseCommitSha: "a".repeat(40),
        communityGate: { policy: { privateVulnerabilityDisclosure: true } },
      },
      "WORKSPACE_PREPARED",
    );
    let stage: "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED" =
      "DISCLOSED";
    const provider = {
      getRepoTextFile: async () =>
        "Report vulnerabilities privately to the security maintainers.",
      getDisclosureStatus: async () => ({
        status: "OK" as const,
        data: {
          stage,
          providerEventId: `event-${stage}`,
          publicDisclosureAllowed: stage === "PUBLIC_FIX_AUTHORIZED",
        },
      }),
    };
    const service = new SecurityDisclosureService(manager, provider);

    await service.verifyPrivateChannel({
      runId: run.runId,
      repoFullName: "owner/repo",
    });
    await expect(
      Promise.resolve().then(() => service.assertPublicSubmissionAllowed(run.runId)),
    ).rejects.toThrow("PublicDisclosureBlockedError");

    await service.syncLifecycle({ runId: run.runId, repoFullName: "owner/repo" });
    stage = "ACKNOWLEDGED";
    await service.syncLifecycle({ runId: run.runId, repoFullName: "owner/repo" });
    stage = "PUBLIC_FIX_AUTHORIZED";
    await service.syncLifecycle({ runId: run.runId, repoFullName: "owner/repo" });
    expect(() => service.assertPublicSubmissionAllowed(run.runId)).not.toThrow();
    expect(manager.getRun(run.runId)?.artifacts.securityDisclosureEvents).toHaveLength(3);
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
