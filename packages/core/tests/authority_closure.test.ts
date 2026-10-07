import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactBundleManager } from "../src/run/artifact-bundle.js";
import { ContributionRunManager } from "../src/run/run-manager.js";
import { ActiveSessionManager } from "../src/run/active-session.js";
import { saveCanonicalArtifact } from "../src/run/canonical-writer.js";
import { IssueBindingService } from "../src/github/issue-binding-service.js";
import { buildPublicIssueBindingProvider } from "../src/composition-root.js";
import { IssueCreationService } from "../src/github/issue-creation-service.js";
import { SecurityDisclosureService } from "../src/github/security-disclosure-service.js";
import * as publicCore from "../src/index.js";
import * as publicGitHub from "../src/github/index.js";

const testStorageDirs: string[] = [];

function baseDir(name: string): string {
  const dir = mkdtempSync(join(tmpdir(), `authority-closure-${name}-`));
  testStorageDirs.push(dir);
  return dir;
}

function privateCommunityGate() {
  return {
    sourceCommitSha: "a".repeat(40),
    policy: {
      hasGatingRules: false,
      requiresIssueApprovalBeforePr: false,
      autoClosesNewIssues: false,
      hasLgtmApprovalProtocol: false,
      restrictedTriageHours: false,
      privateVulnerabilityDisclosure: true,
      reasons: ["Private vulnerability reporting is required."],
      suggestedContributorAction: "Use the private disclosure channel.",
      matchedKeywords: [],
    },
  };
}

function publicCommunityGate() {
  return {
    ...privateCommunityGate(),
    policy: {
      ...privateCommunityGate().policy,
      privateVulnerabilityDisclosure: false,
      reasons: [],
      suggestedContributorAction: "Follow the repository contribution policy.",
    },
  };
}

function savePublicCommunityGate(
  manager: ContributionRunManager,
  runId: string,
): void {
  saveCanonicalArtifact(manager, runId, "workspace", {
    baseCommitSha: "a".repeat(40),
    communityGate: publicCommunityGate(),
  });
}

afterEach(() => {
  for (const dir of testStorageDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Authority closure", () => {
  it("keeps issue-binding authority out of the public API", () => {
    expect("IssueBindingService" in publicCore).toBe(false);
    expect("parsePublicIssueNumber" in publicCore).toBe(false);
    expect("IssueBindingService" in publicGitHub).toBe(false);
    expect("parsePublicIssueNumber" in publicGitHub).toBe(false);

    const manager = new ContributionRunManager({ baseDir: baseDir("public-binding-api") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    const forgedBinding = {
      runId: run.runId,
      provider: "github",
      repoFullName: "owner/repo",
      providerIssueId: 42,
      state: "open",
      title: "Agent-authored binding",
      issueUrl: "https://github.com/owner/repo/issues/42",
      providerVerified: true,
      verifiedAt: new Date().toISOString(),
    };

    expect("pinIssueNumberFromBinding" in manager).toBe(false);
    expect("_pinIssueNumberFromProviderIssue" in manager).toBe(false);
    expect(() =>
      manager.saveArtifact(run.runId, "issue_binding", forgedBinding),
    ).toThrow("AuthoritativeArtifactViolationError");
    expect(manager.getRun(run.runId)?.manifest.issueNumber).toBeUndefined();
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toBeUndefined();
  });

  it("creates a provider issue and seals its returned identity before binding", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("create-issue") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    savePublicCommunityGate(manager, run.runId);
    let created = false;
    const issue = {
      number: 73,
      title: "Provider-created issue",
      state: "open" as const,
      htmlUrl: "https://github.com/owner/repo/issues/73",
      body: "A provider-backed issue claim.",
      labels: [],
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

  it("rejects malformed repository names before creating a provider issue", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("invalid-repo") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    let createCalls = 0;
    const provider = {
      createIssue: async () => {
        createCalls += 1;
        return { status: "OK" as const, data: {
          number: 1,
          title: "issue",
          state: "open" as const,
          htmlUrl: "https://github.com/owner/repo/issues/1",
          body: "Issue body.",
          labels: [],
        } };
      },
      getIssue: async () => ({ status: "NOT_FOUND" as const, data: null as never }),
    };

    await expect(
      new IssueCreationService(manager, provider).createAndBind({
        runId: run.runId,
        repoFullName: "owner/repo/extra",
        title: "Issue title",
        body: "Issue body",
      }),
    ).rejects.toThrow("repoFullName must be exactly owner/repo");
    expect(createCalls).toBe(0);
  });

  it("creates issue_binding only from a provider response", async () => {
    const storageDir = baseDir("issue");
    const activeSession = new ActiveSessionManager(join(storageDir, "active-session.json"));
    const manager = new ContributionRunManager({ baseDir: storageDir, activeSession });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    savePublicCommunityGate(manager, run.runId);
    const provider = {
      getIssue: async () => ({
        status: "OK" as const,
        data: {
          number: 42,
          title: "Fix the verified issue",
          state: "open" as const,
          htmlUrl: "https://github.com/owner/repo/issues/42",
          body: "Provider-backed issue body.",
          labels: ["bug"],
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
    expect(manager.getRun(run.runId)?.manifest.issueNumber).toBe(42);
    expect(activeSession.getActiveSession()?.issueNumber).toBe(42);
    expect(activeSession.getActiveSession()?.issueTitle).toBe("Fix the verified issue");
    expect(() =>
      manager.saveArtifact(run.runId, "issue_binding", artifact as any),
    ).toThrow("AuthoritativeArtifactViolationError");
  });

  it("binds enterprise issue URLs using the configured provider host", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("enterprise-issue") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    savePublicCommunityGate(manager, run.runId);
    const host = "github.enterprise.test";
    const service = new IssueBindingService(manager, {
      issueUrlHost: host,
      getIssue: async (_owner, _repo, issueNumber) => ({
        status: "OK",
        data: {
          number: issueNumber,
          title: "Enterprise issue",
          state: "open",
          htmlUrl: `https://${host}/owner/repo/issues/${issueNumber}`,
          body: "Provider-backed issue body.",
          labels: [],
        },
      }),
    });

    const binding = await service.bind({
      runId: run.runId,
      repoFullName: "owner/repo",
      issueNumber: 42,
    });

    expect(binding.issueUrl).toBe(`https://${host}/owner/repo/issues/42`);
    expect(manager.getRun(run.runId)?.manifest.issueNumber).toBe(42);
    await expect(
      service.verify({
        runId: run.runId,
        repoFullName: "owner/repo",
        issueNumber: 42,
      }),
    ).resolves.toEqual(binding);
  });

  it("exposes an unauthenticated issue-only provider to agent-facing code", () => {
    const provider = buildPublicIssueBindingProvider({
      host: "github.enterprise.test",
    });
    expect(provider.issueUrlHost).toBe("github.enterprise.test");
    expect(provider.getIssue).toBeFunction();
    expect("createIssue" in provider).toBe(false);
  });

  it("requires a valid canonical policy snapshot before public issue binding", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("missing-policy") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    let lookupCount = 0;
    const provider = {
      getIssue: async () => {
        lookupCount += 1;
        return {
          status: "OK" as const,
          data: {
            number: 42,
            title: "Fix the verified issue",
            state: "open" as const,
            htmlUrl: "https://github.com/owner/repo/issues/42",
            body: "Provider issue body.",
            labels: [],
          },
        };
      },
    };

    await expect(
      new IssueBindingService(manager, provider).bind({
        runId: run.runId,
        repoFullName: "owner/repo",
        issueNumber: 42,
      }),
    ).rejects.toThrow("requires a valid canonical workspace policy snapshot");
    expect(lookupCount).toBe(0);
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toBeUndefined();
    expect(manager.getRun(run.runId)?.manifest.issueNumber).toBeUndefined();
  });

  it("blocks public issue binding for private disclosure runs", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("private-issue") });
    const run = manager.createRun({ repoFullName: "owner/repo" });
    saveCanonicalArtifact(manager, run.runId, "workspace", {
      baseCommitSha: "a".repeat(40),
      communityGate: privateCommunityGate(),
    });
    let lookupCount = 0;
    const provider = {
      getIssue: async () => {
        lookupCount += 1;
        return {
          status: "OK" as const,
          data: {
            number: 42,
            title: "Private vulnerability",
            state: "open" as const,
            htmlUrl: "https://github.com/owner/repo/issues/42",
            body: "Private issue body.",
            labels: [],
          },
        };
      },
    };

    await expect(
      new IssueBindingService(manager, provider).bind({
        runId: run.runId,
        repoFullName: "owner/repo",
        issueNumber: 42,
      }),
    ).rejects.toThrow("private disclosure runs cannot bind a public issue");
    expect(lookupCount).toBe(0);
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toBeUndefined();
    expect(manager.getRun(run.runId)?.manifest.issueNumber).toBeUndefined();
  });

  it("rechecks public issue bindings against the current provider without writing", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("verify-issue") });
    const run = manager.createRun({ repoFullName: "owner/repo", issueNumber: 42 });
    savePublicCommunityGate(manager, run.runId);
    const binding = {
      runId: run.runId,
      provider: "github" as const,
      repoFullName: "owner/repo",
      providerIssueId: 42,
      state: "open" as const,
      title: "Fix the verified issue",
      issueUrl: "https://github.com/owner/repo/issues/42",
      providerVerified: true as const,
      verifiedAt: "2026-10-06T00:00:00.000Z",
    };
    saveCanonicalArtifact(manager, run.runId, "issue_binding", binding);
    let issue: {
      number: number;
      title: string;
      state: "open" | "closed";
      htmlUrl: string;
      body: string;
      labels: string[];
    } = {
      number: 42,
      title: "Fix the verified issue",
      state: "open" as const,
      htmlUrl: "https://github.com/owner/repo/issues/42",
      body: "Provider-backed issue body.",
      labels: ["bug"],
    };
    let lookupCount = 0;
    const service = new IssueBindingService(manager, {
      getIssue: async () => {
        lookupCount += 1;
        return { status: "OK" as const, data: issue };
      },
    });

    const verifiedIssueContext = await service.verifyIssueContext({
      runId: run.runId,
      repoFullName: "owner/repo",
      issueNumber: 42,
    });
    expect(verifiedIssueContext.binding).toEqual(binding);
    expect(verifiedIssueContext.issue.body).toBe("Provider-backed issue body.");
    expect(verifiedIssueContext.issue.labels).toEqual(["bug"]);
    expect(lookupCount).toBe(1);

    issue = { ...issue, title: "Changed title" };
    await expect(service.verify({
      runId: run.runId,
      repoFullName: "owner/repo",
      issueNumber: 42,
    })).rejects.toThrow("does not match the stored binding");

    issue = { ...issue, state: "closed" };
    await expect(service.verify({
      runId: run.runId,
      repoFullName: "owner/repo",
      issueNumber: 42,
    })).rejects.toThrow("mismatched issue identity");
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toEqual(binding);
    expect(manager.getRun(run.runId)?.manifest.issueNumber).toBe(42);
  });

  it("rejects a provider binding that conflicts with the run issue number", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("issue-conflict") });
    const run = manager.createRun({
      repoFullName: "owner/repo",
      issueNumber: 7,
    });
    savePublicCommunityGate(manager, run.runId);
    let lookupCount = 0;
    const provider = {
      getIssue: async () => {
        lookupCount += 1;
        return {
          status: "OK" as const,
          data: {
            number: 42,
            title: "Fix the verified issue",
            state: "open" as const,
            htmlUrl: "https://github.com/owner/repo/issues/42",
            body: "Provider-backed issue body.",
            labels: [],
          },
        };
      },
    };

    await expect(
      new IssueBindingService(manager, provider).bind({
        runId: run.runId,
        repoFullName: "owner/repo",
        issueNumber: 42,
      }),
    ).rejects.toThrow("already bound to issue #7");
    expect(lookupCount).toBe(0);
    expect(manager.getRun(run.runId)?.artifacts.issueBinding).toBeUndefined();
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

  it("rejects skipped stages, backwards stages, and replayed lifecycle IDs", async () => {
    const manager = new ContributionRunManager({ baseDir: baseDir("lifecycle-order") });
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
    let stage: "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED" =
      "DISCLOSED";
    let eventId = "event-DISCLOSED";
    const provider = {
      getRepoTextFile: async () =>
        "Report vulnerabilities privately to the security maintainers.",
      getDisclosureStatus: async () => ({
        status: "OK" as const,
        data: {
          stage,
          providerEventId: eventId,
          publicDisclosureAllowed: stage === "PUBLIC_FIX_AUTHORIZED",
        },
      }),
    };
    const service = new SecurityDisclosureService(manager, provider);
    const input = { runId: run.runId, repoFullName: "owner/repo" };

    await service.syncLifecycle(input);
    stage = "PUBLIC_FIX_AUTHORIZED";
    eventId = "event-PUBLIC_FIX_AUTHORIZED";
    await expect(service.syncLifecycle(input)).rejects.toThrow(
      "lifecycle stages must advance",
    );

    stage = "ACKNOWLEDGED";
    eventId = "event-ACKNOWLEDGED";
    await service.syncLifecycle(input);
    stage = "PUBLIC_FIX_AUTHORIZED";
    eventId = "event-PUBLIC_FIX_AUTHORIZED";
    await service.syncLifecycle(input);

    stage = "DISCLOSED";
    eventId = "event-DOWNGRADE";
    await expect(service.syncLifecycle(input)).rejects.toThrow(
      "provider lifecycle moved backwards",
    );
    stage = "ACKNOWLEDGED";
    eventId = "event-DISCLOSED";
    await expect(service.syncLifecycle(input)).rejects.toThrow(
      "provider reused an event ID",
    );
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
