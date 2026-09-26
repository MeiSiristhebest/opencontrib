import { describe, expect, it } from "bun:test";
import { RemoteSubmissionBrokerClient } from "../src/github/submission-broker-client.js";

describe("Agent-facing submission broker client", () => {
  it("sends only a run reference and accepts a verified broker artifact", async () => {
    let requestBody = "";
    const client = new RemoteSubmissionBrokerClient({
      endpoint: "https://broker.example.test/v1/submissions",
      fetchImpl: async (_input, init) => {
        requestBody = String(init?.body || "");
        expect(init?.headers).toEqual({ "content-type": "application/json" });
        const submissionArtifact = {
          schemaVersion: 1,
          runId: "run_1234567890abcdef",
          provider: "github",
          owner: "org",
          repo: "repo",
          baseBranch: "main",
          baseCommitSha: "a".repeat(40),
          branchName: "opencontrib/run_1234567890abcdef",
          intentSha256: "b".repeat(64),
          patchSha256: "c".repeat(64),
          evidenceSha256: "d".repeat(64),
          governanceSha256: "e".repeat(64),
          policySha256: "p".repeat(64),
          communityGateSha256: "1".repeat(64),
          prNumber: 7,
          prUrl: "https://github.com/org/repo/pull/7",
          headSha: "f".repeat(40),
          submittedAt: "2026-01-01T00:00:00.000Z",
          verified: true,
          submissionRoute: "PUBLIC_ISSUE",
          issueBindingSha256: "9".repeat(64),
        };
        const resultArtifact = {
          runId: submissionArtifact.runId,
          submission: submissionArtifact,
          submissionVerified: true,
          prNumber: submissionArtifact.prNumber,
          prUrl: submissionArtifact.prUrl,
          completedAt: submissionArtifact.submittedAt,
        };
        const resultSha256 = await import("node:crypto").then(
          ({ createHash }) =>
            createHash("sha256")
              .update(JSON.stringify(resultArtifact))
              .digest("hex"),
        );
        return new Response(
          JSON.stringify({
            submissionArtifact,
            completionAttestation: {
              runId: submissionArtifact.runId,
              hostIntentSha256: submissionArtifact.intentSha256,
              prNumber: submissionArtifact.prNumber,
              prUrl: submissionArtifact.prUrl,
              headSha: submissionArtifact.headSha,
              resultSha256,
              verified: true,
              completedAt: submissionArtifact.submittedAt,
              submissionArtifact,
              resultArtifact,
            },
          }),
          { status: 200 },
        );
      },
    });

    const result = await client.submit("run_1234567890abcdef", "b".repeat(64));
    expect(result.submissionArtifact.prNumber).toBe(7);
    expect(result.completionAttestation?.verified).toBe(true);
    expect(JSON.parse(requestBody)).toEqual({
      runId: "run_1234567890abcdef",
      expectedIntentSha256: "b".repeat(64),
    });
  });

  it("throws a protocol error when the broker sends an invalid completionAttestation", async () => {
    const client = new RemoteSubmissionBrokerClient({
      endpoint: "https://broker.example.test/v1/submissions",
      fetchImpl: async () => {
        return new Response(
          JSON.stringify({
            submissionArtifact: {
              schemaVersion: 1,
              runId: "run_1234567890abcdef",
              provider: "github",
              owner: "org",
              repo: "repo",
              baseBranch: "main",
              baseCommitSha: "a".repeat(40),
              branchName: "opencontrib/run_1234567890abcdef",
              intentSha256: "b".repeat(64),
              patchSha256: "c".repeat(64),
              evidenceSha256: "d".repeat(64),
              governanceSha256: "e".repeat(64),
              policySha256: "p".repeat(64),
              communityGateSha256: "1".repeat(64),
              prNumber: 7,
              prUrl: "https://github.com/org/repo/pull/7",
              headSha: "f".repeat(40),
              submittedAt: "2026-01-01T00:00:00.000Z",
              verified: true,
              submissionRoute: "PUBLIC_ISSUE",
              issueBindingSha256: "9".repeat(64),
            },
            completionAttestation: { not: "valid" },
          }),
          { status: 200 },
        );
      },
    });
    await expect(client.submit("run_1234567890abcdef")).rejects.toThrow(
      /invalid completionAttestation/,
    );
  });

  it("rejects non-loopback HTTP endpoints before any network request", () => {
    expect(
      () =>
        new RemoteSubmissionBrokerClient({
          endpoint: "http://broker.example.test/v1/submissions",
        }),
    ).toThrow(/HTTPS except for loopback/);
  });
});
