import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import {
  detectCommunityGate,
  detectCommunityGateFromContents,
  hashCommunityGateSnapshot,
  readCommunityGateAtCommit,
} from "../src/governance/community-gate.js";

describe("Community Gate Detector", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  it("detects auto-close and lgtmi approval requirements from CONTRIBUTING.md", async () => {
    const contributingContent = `
# Contributing Guidelines

## Contribution Gate
All issues and PRs from new contributors are auto-closed by default.
Maintainers review auto-closed issues daily and reopen worthwhile ones.
Approval happens through maintainer replies on issues:
- \`lgtmi\`: your future issues will not be auto-closed
- \`lgtm\`: your future issues and PRs will not be auto-closed
`;

    fs.writeFileSync(
      path.join(tmpDir, "CONTRIBUTING.md"),
      contributingContent,
      "utf8",
    );

    const gate = await detectCommunityGate(tmpDir);

    expect(gate.hasGatingRules).toBe(true);
    expect(gate.autoClosesNewIssues).toBe(true);
    expect(gate.hasLgtmApprovalProtocol).toBe(true);
    expect(gate.requiresIssueApprovalBeforePr).toBe(true);
    expect(gate.suggestedContributorAction).toContain("PAUSE pipeline");
  });

  it("detects weekend restricted triage hours", async () => {
    const contributingContent = `
# Contributing
Issues submitted Friday through Sunday are not guaranteed to be reviewed until the next working week.
`;

    fs.writeFileSync(
      path.join(tmpDir, "CONTRIBUTING.md"),
      contributingContent,
      "utf8",
    );

    const gate = await detectCommunityGate(tmpDir);

    expect(gate.restrictedTriageHours).toBe(true);
    expect(gate.reasons.some((r) => r.includes("Weekend"))).toBe(true);
  });

  it("does not treat issue-first wording alone as maintainer approval", () => {
    const gate = detectCommunityGateFromContents([
      {
        path: "CONTRIBUTING.md",
        content: "Please open an issue first so work is coordinated.",
      },
    ]);

    expect(gate.requiresIssueApprovalBeforePr).toBe(false);
    expect(gate.hasGatingRules).toBe(false);
  });

  it("captures diff ceilings and preserves restricted-hours policy", () => {
    const gate = detectCommunityGateFromContents([
      {
        path: "CONTRIBUTING.md",
        content:
          "PRs have a 60 lines max. Reviews are not guaranteed Friday through Sunday.",
      },
    ]);

    expect(gate.maxDiffCeiling).toBe(60);
    expect(gate.restrictedTriageHours).toBe(true);
    expect(gate.hasGatingRules).toBe(false);
  });

  it("pins DCO and AI disclosure requirements in the community policy snapshot", () => {
    const gate = detectCommunityGateFromContents([
      {
        path: "CONTRIBUTING.md",
        content:
          "Every commit must include Signed-off-by. Disclose the use of AI-assisted tooling in the PR.",
      },
    ]);

    expect(gate.requiresDco).toBe(true);
    expect(gate.requiresAiDisclosure).toBe(true);
    expect(gate.reasons.join(" ")).toContain("Developer Certificate of Origin");
    expect(gate.reasons.join(" ")).toContain("AI");
  });

  it("fails closed when a baseline community policy read fails", () => {
    expect(() =>
      readCommunityGateAtCommit(
        {
          listTree: () => ({
            success: true,
            stdout: "CONTRIBUTING.md\n",
            stderr: "",
          }),
          show: () => ({
            success: false,
            stdout: "",
            stderr: "permission denied",
          }),
        },
        "a".repeat(40),
      ),
    ).toThrow(
      /CommunityGateSnapshotError: cannot read baseline community policy/,
    );
  });

  it("pins the detected policy to the source commit and a stable hash", () => {
    const snapshot = readCommunityGateAtCommit(
      {
        listTree: () => ({
          success: true,
          stdout: "",
          stderr: "",
        }),
        show: () => ({ success: true, stdout: "", stderr: "" }),
      },
      "a".repeat(40),
    );

    expect(snapshot.sourceCommitSha).toBe("a".repeat(40));
    expect(hashCommunityGateSnapshot(snapshot)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("returns permissive policy when no governance files exist", async () => {
    const gate = await detectCommunityGate(tmpDir);

    expect(gate.hasGatingRules).toBe(false);
    expect(gate.requiresIssueApprovalBeforePr).toBe(false);
    expect(gate.autoClosesNewIssues).toBe(false);
  });
});
