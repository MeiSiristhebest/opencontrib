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
              prNumber: 7,
              prUrl: "https://github.com/org/repo/pull/7",
              headSha: "f".repeat(40),
              submittedAt: "2026-01-01T00:00:00.000Z",
              verified: true,
            },
          }),
          { status: 200 },
        );
      },
    });

    const artifact = await client.submit("run_1234567890abcdef", "b".repeat(64));
    expect(artifact.prNumber).toBe(7);
    expect(JSON.parse(requestBody)).toEqual({
      runId: "run_1234567890abcdef",
      expectedIntentSha256: "b".repeat(64),
    });
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
