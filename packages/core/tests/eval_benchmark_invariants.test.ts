/**
 * Tests for canonical benchmark invariants and run-bundle cross-validation.
 */

import { describe, it, expect } from 'bun:test';
import {
  STANDARD_BENCHMARK_SCENARIOS,
  executeBenchmarkScenario,
  crossValidateWithBundle,
  TOOL_TO_ACTION,
} from '../src/eval/benchmark-runner.js';
import { parseTrajectoryFromJSONL } from '../src/eval/trajectory-parser.js';
import type { BenchmarkBundle, ProtocolAction } from '../src/eval/types.js';
import {
  hasPublicIssueReference,
  hashSubmissionArtifact,
} from '../src/submission/submission-route.js';

function communityGateSnapshot(privateVulnerabilityDisclosure: boolean) {
  return {
    sourceCommitSha: 'a'.repeat(40),
    policy: {
      hasGatingRules: false,
      requiresIssueApprovalBeforePr: false,
      autoClosesNewIssues: false,
      hasLgtmApprovalProtocol: false,
      restrictedTriageHours: false,
      privateVulnerabilityDisclosure,
      reasons: [],
      suggestedContributorAction: privateVulnerabilityDisclosure
        ? 'Use private disclosure.'
        : 'Use the provider-backed issue route.',
      matchedKeywords: [],
    },
  };
}

function makeSubmissionIntent(
  runId: string,
  submissionRoute: 'PUBLIC_ISSUE' | 'PRIVATE_SECURITY',
  routeHashKey: 'issueBindingSha256' | 'securityDisclosureSha256',
  routeHash: string,
) {
  return {
    runId,
    upstreamOwner: 'owner',
    upstreamRepo: 'repo',
    baseBranch: 'main',
    baseCommitSha: 'a'.repeat(40),
    branchName: `opencontrib/${runId}`,
    title: 'fix: verified issue',
    body: 'Body',
    bodySha256: hashSubmissionArtifact('Body'),
    commitMessage: 'fix: verified issue',
    isDraft: true,
    files: [],
    patchSha256: 'c'.repeat(64),
    evidenceSha256: 'd'.repeat(64),
    governanceSha256: 'e'.repeat(64),
    policySha256: 'f'.repeat(64),
    submissionRoute,
    [routeHashKey]: routeHash,
    intentSha256: '1'.repeat(64),
    createdAt: new Date(0).toISOString(),
  };
}

function makeAction(action: string, stepIndex: number, runId?: string): ProtocolAction {
  const toolName = Object.entries(TOOL_TO_ACTION).find(
    ([, verb]) => verb === action,
  )?.[0] ?? `unknown_${action}`;
  return {
    action,
    ingress: "mcp",
    toolName,
    stepIndex,
    runId: action === "CREATE_RUN" ? undefined : runId,
    inputRunId: action === "CREATE_RUN" ? undefined : runId,
    outputRunId: action === "CREATE_RUN" ? runId : undefined,
  };
}

function makeRunEvents(
  runId: string,
  phases: string[],
): NonNullable<BenchmarkBundle["events"]> {
  return phases.map((phase, index) => ({
    eventId: `event-${index + 1}`,
    runId,
    timestamp: new Date(index * 1000).toISOString(),
    phase,
    eventType: index === 0 ? "RUN_CREATED" : "PHASE_TRANSITION",
    ...(index === 0
      ? {}
      : {
          payload: {
            fromPhase: phases[index - 1] ?? phase,
            toPhase: phase,
          },
        }),
  }));
}

describe("Public Issue reference detection", () => {
  it("requires a real github.com host boundary for Issue URLs", () => {
    expect(
      hasPublicIssueReference("See https://github.com/owner/repo/issues/42"),
    ).toBe(true);
    expect(
      hasPublicIssueReference("https://notgithub.com/owner/repo/issues/42"),
    ).toBe(false);
    expect(
      hasPublicIssueReference(
        "https://evil.example/path/github.com/owner/repo/issues/42",
      ),
    ).toBe(false);
    expect(hasPublicIssueReference("owner/repo#42")).toBe(true);
  });
});

describe("Benchmark canonical invariants", () => {
  it("CREATE_RUN must be the first protocol action", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0]; // Track A
    const actions: ProtocolAction[] = [
      makeAction("PROBE_RUN", 0),
      makeAction("CREATE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      makeAction("SAVE_ARTIFACT", 4),
      makeAction("VERIFY_GREEN", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      makeAction("REQUEST_APPROVAL", 8),
      makeAction("SUBMIT_PR", 9),
      makeAction("SYNC_FLYWHEEL", 10),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(result.errors.some((e) => e.includes("CREATE_RUN must be the first"))).toBe(true);
  });

  it("CAPTURE_RED must precede SAVE_ARTIFACT which must precede VERIFY_GREEN", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    // RED after GREEN — ordering violation
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("VERIFY_GREEN", 3),
      makeAction("CAPTURE_RED", 4),
      makeAction("SAVE_ARTIFACT", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      makeAction("REQUEST_APPROVAL", 8),
      makeAction("SUBMIT_PR", 9),
      makeAction("SYNC_FLYWHEEL", 10),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("SAVE_ARTIFACT") && e.includes("VERIFY_GREEN"),
      ),
    ).toBe(true);
  });

  it("PR template → governance → approval → submission must be in order", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    // Submission before approval — ordering violation
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      makeAction("SAVE_ARTIFACT", 4),
      makeAction("VERIFY_GREEN", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      makeAction("SUBMIT_PR", 8), // submitted before approval!
      makeAction("REQUEST_APPROVAL", 9),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors.some((e) =>
        e.includes("REQUEST_APPROVAL") && e.includes("SUBMIT_PR"),
      ),
    ).toBe(true);
    expect(result.actionSequenceVerified).toBe(false);
  });

  it("Missing CREATE_RUN fails even with otherwise valid sequence", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    // No CREATE_RUN at all
    const actions: ProtocolAction[] = [
      makeAction("PROBE_RUN", 0),
      makeAction("PREPARE_WORKSPACE", 1),
      makeAction("CAPTURE_RED", 2),
      makeAction("SAVE_ARTIFACT", 3),
      makeAction("VERIFY_GREEN", 4),
      makeAction("RENDER_PR_TEMPLATE", 5),
      makeAction("AUDIT_GOVERNANCE", 6),
      makeAction("REQUEST_APPROVAL", 7),
      makeAction("SUBMIT_PR", 8),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Missing required action: CREATE_RUN")),
    ).toBe(true);
  });

  it("Missing SAVE_ARTIFACT fails (RED → GREEN without PATCH)", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      // No SAVE_ARTIFACT — jumped from RED to GREEN
      makeAction("VERIFY_GREEN", 4),
      makeAction("RENDER_PR_TEMPLATE", 5),
      makeAction("AUDIT_GOVERNANCE", 6),
      makeAction("REQUEST_APPROVAL", 7),
      makeAction("SUBMIT_PR", 8),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Missing required action: SAVE_ARTIFACT")),
    ).toBe(true);
  });

  it("Missing REQUEST_APPROVAL fails", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      makeAction("SAVE_ARTIFACT", 4),
      makeAction("VERIFY_GREEN", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      // No REQUEST_APPROVAL — jumped from governance to submission
      makeAction("SUBMIT_PR", 8),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors.some((e) => e.includes("Missing required action: REQUEST_APPROVAL")),
    ).toBe(true);
  });

  it("does not pass a valid Track A action sequence without the canonical run bundle", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      makeAction("SAVE_ARTIFACT", 4),
      makeAction("VERIFY_GREEN", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      makeAction("REQUEST_APPROVAL", 8),
      makeAction("SUBMIT_PR", 9),
      makeAction("SYNC_FLYWHEEL", 10),
    ];

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(false);
    expect(result.actionSequenceVerified).toBe(true);
    expect(result.runBundleVerified).toBe(false);
    expect(
      result.errors.some((error) =>
        error.includes("Canonical run bundle is required"),
      ),
    ).toBe(true);
  });

  it("Step count exceeding budget fails", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      makeAction("SAVE_ARTIFACT", 4),
      makeAction("VERIFY_GREEN", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      makeAction("REQUEST_APPROVAL", 8),
      makeAction("SUBMIT_PR", 9),
    ];

    // 100 steps exceeds maxAllowedSteps of 25
    const result = executeBenchmarkScenario(
      scenario,
      actions,
      100,
      0,
    );
    expect(result.success).toBe(false);
    expect(
      result.errors.some((e) => e.includes("exceeded maximum budget")),
    ).toBe(true);
  });
});

describe("Run bundle cross-validation", () => {
  it("Detects missing phase events in run bundle", () => {
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("CAPTURE_RED", 1),
      makeAction("SUBMIT_PR", 2),
    ];

    // Canonical events exist, but RED_CAPTURED and PR_SUBMITTED are absent.
    const bundle: BenchmarkBundle = {
      manifest: { runId: "run_phase_missing", currentPhase: "INITIALIZED" },
      events: makeRunEvents("run_phase_missing", ["INITIALIZED"]),
      artifacts: { workspace: { runId: "run_phase_missing" } },
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(false);
    expect(errors.some((e) => e.includes("RED_CAPTURED"))).toBe(true);
    expect(errors.some((e) => e.includes("PR_SUBMITTED"))).toBe(true);
  });

  it("Detects missing artifacts in run bundle", () => {
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("CAPTURE_RED", 1),
      makeAction("SAVE_ARTIFACT", 2),
      makeAction("VERIFY_GREEN", 3),
    ];

    // Canonical events exist, but evidence_red, patch, and evidence are missing.
    const bundle: BenchmarkBundle = {
      manifest: { runId: "run_valid", currentPhase: "EVIDENCE_COLLECTED" },
      events: makeRunEvents("run_valid", [
        "INITIALIZED",
        "WORKSPACE_PREPARED",
        "RED_CAPTURED",
        "PATCH_DRAFTED",
        "EVIDENCE_COLLECTED",
      ]),
      artifacts: { workspace: { runId: "run_valid" } },
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(false);
    expect(errors.some((e) => e.includes("evidence_red"))).toBe(true);
    expect(errors.some((e) => e.includes("patch"))).toBe(true);
    expect(errors.some((e) => e.includes("evidence"))).toBe(true);
  });

  it("accepts actual canonical events and artifacts", () => {
    const runId = "run_valid";
    const actions = [makeAction("CREATE_RUN", 0, runId)];
    const bundle: BenchmarkBundle = {
      manifest: { runId, currentPhase: "INITIALIZED" },
      events: makeRunEvents(runId, ["INITIALIZED"]),
      artifacts: { workspace: { runId } },
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("never verifies a metadata-only bundle", () => {
    const runId = "run_metadata_only";
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    const actions = scenario.requiredActions.map((action, index) =>
      makeAction(action, index, runId),
    );
    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
      {
        manifest: { runId, currentPhase: "PR_SUBMITTED", repoFullName: "owner/repo" },
        eventPhases: scenario.requiredActions,
        artifactTypes: ["workspace", "evidence_red", "patch", "evidence"],
      },
    );

    expect(result.success).toBe(false);
    expect(result.runBundleVerified).toBe(false);
    expect(result.errors.some((error) => error.includes("actual canonical events"))).toBe(true);
    expect(result.errors.some((error) => error.includes("parsed artifacts"))).toBe(true);
  });

  it("accepts the private security route only with provider lifecycle authorization", () => {
    const runId = "run_private";
    const disclosure = {
      runId,
      provider: "github" as const,
      repoFullName: "owner/repo",
      channel: "security policy",
      channelUrl: "https://github.com/owner/repo/security/policy",
      providerVerified: true as const,
      publicDisclosureAllowed: false,
      stage: "CHANNEL_DISCOVERED" as const,
      verifiedAt: new Date(0).toISOString(),
    };
    const events = [
      "DISCLOSED",
      "ACKNOWLEDGED",
      "PUBLIC_FIX_AUTHORIZED",
    ].map((stage, index) => ({
      runId,
      provider: "github" as const,
      repoFullName: "owner/repo",
      stage: stage as "DISCLOSED" | "ACKNOWLEDGED" | "PUBLIC_FIX_AUTHORIZED",
      providerEventId: `private-provider-event-${index + 1}`,
      providerVerified: true as const,
      publicDisclosureAllowed: stage === "PUBLIC_FIX_AUTHORIZED",
      recordedAt: new Date(index + 1).toISOString(),
    }));
    const intent = makeSubmissionIntent(
      runId,
      "PRIVATE_SECURITY",
      "securityDisclosureSha256",
      hashSubmissionArtifact(disclosure),
    );
    const submission = {
      runId,
      provider: "github" as const,
      owner: "owner",
      repo: "repo",
      baseBranch: "main",
      baseCommitSha: "a".repeat(40),
      branchName: `opencontrib/${runId}`,
      intentSha256: intent.intentSha256,
      patchSha256: intent.patchSha256,
      evidenceSha256: intent.evidenceSha256,
      governanceSha256: intent.governanceSha256,
      policySha256: intent.policySha256,
      communityGateSha256: "b".repeat(64),
      submissionRoute: "PRIVATE_SECURITY" as const,
      securityDisclosureSha256: hashSubmissionArtifact(disclosure),
      prNumber: 1,
      prUrl: "https://github.com/owner/repo/pull/1",
      headSha: "c".repeat(40),
      submittedAt: new Date(0).toISOString(),
      verified: true as const,
    };
    const privateRouteBundle: BenchmarkBundle = {
      manifest: {
        runId,
        currentPhase: "PR_SUBMITTED",
        repoFullName: "owner/repo",
      },
      events: [
        {
          eventId: "private-event-1",
          runId,
          timestamp: new Date(0).toISOString(),
          phase: "PR_SUBMITTED",
          eventType: "ARTIFACT_SAVED",
          payload: { artifactType: "submission" },
        },
        {
          eventId: "private-event-2",
          runId,
          timestamp: new Date(1).toISOString(),
          phase: "PR_SUBMITTED",
          eventType: "ARTIFACT_SAVED",
          payload: { artifactType: "security_disclosure" },
        },
      ],
      artifacts: {
        workspace: { communityGate: communityGateSnapshot(true) },
        security_disclosure: disclosure,
        security_disclosure_events: events,
        submission_intent: intent,
        submission,
        pr_draft: intent.body,
      },
    };
    const result = crossValidateWithBundle(
      [makeAction("SUBMIT_PR", 0, runId)],
      privateRouteBundle,
    );

    expect(result.verified).toBe(true);
    expect(result.errors).toHaveLength(0);

    const issueReferencingResult = crossValidateWithBundle(
      [makeAction("SUBMIT_PR", 0, runId)],
      {
        ...privateRouteBundle,
        artifacts: {
          ...privateRouteBundle.artifacts,
          submission_intent: {
            ...intent,
            body: "Fixes #42",
            bodySha256: hashSubmissionArtifact("Fixes #42"),
          },
        },
      },
    );
    expect(issueReferencingResult.verified).toBe(false);
    expect(
      issueReferencingResult.errors.some((error) =>
        error.includes("body contains a public Issue reference"),
      ),
    ).toBe(true);

    const issueReferencingDraftResult = crossValidateWithBundle(
      [makeAction("SUBMIT_PR", 0, runId)],
      {
        ...privateRouteBundle,
        artifacts: {
          ...privateRouteBundle.artifacts,
          pr_draft: "Fixes #42",
        },
      },
    );
    expect(issueReferencingDraftResult.verified).toBe(false);
    expect(
      issueReferencingDraftResult.errors.some((error) =>
        error.includes("pr_draft contains a public Issue reference"),
      ),
    ).toBe(true);
  });

  it("rejects a public submission without the canonical issue binding", () => {
    const runId = "run_public_without_binding";
    const result = crossValidateWithBundle(
      [makeAction("SUBMIT_PR", 0, runId)],
      {
        manifest: {
          runId,
          currentPhase: "PR_SUBMITTED",
          repoFullName: "owner/repo",
        },
        events: [
          {
            eventId: "public-event-1",
            runId,
            timestamp: new Date(0).toISOString(),
            phase: "PR_SUBMITTED",
            eventType: "ARTIFACT_SAVED",
            payload: { artifactType: "submission" },
          },
        ],
        artifacts: {
          workspace: { communityGate: communityGateSnapshot(false) },
          submission_intent: makeSubmissionIntent(
            runId,
            "PUBLIC_ISSUE",
            "issueBindingSha256",
            "a".repeat(64),
          ),
        },
      },
    );

    expect(result.verified).toBe(false);
    expect(result.errors.some((error) => error.includes("issue_binding"))).toBe(
      true,
    );
  });

  it("Empty bundle fails with clear message", () => {
    const actions: ProtocolAction[] = [makeAction("CREATE_RUN", 0)];

    const bundle: BenchmarkBundle = {
      eventPhases: [],
      artifactTypes: [],
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(false);
    expect(errors.some((error) => error.includes("No run events"))).toBe(true);
    expect(errors.some((error) => error.includes("parsed artifacts"))).toBe(true);
  });

  it("Bundle cross-validation integrates with full scenario execution", () => {
    const scenario = STANDARD_BENCHMARK_SCENARIOS[0];
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("PROBE_RUN", 1),
      makeAction("PREPARE_WORKSPACE", 2),
      makeAction("CAPTURE_RED", 3),
      makeAction("SAVE_ARTIFACT", 4),
      makeAction("VERIFY_GREEN", 5),
      makeAction("RENDER_PR_TEMPLATE", 6),
      makeAction("AUDIT_GOVERNANCE", 7),
      makeAction("REQUEST_APPROVAL", 8),
      makeAction("SUBMIT_PR", 9),
      makeAction("SYNC_FLYWHEEL", 10),
    ];

    // Bundle missing RED_CAPTURED phase and evidence_red artifact
    const bundle: BenchmarkBundle = {
      eventPhases: ["INITIALIZED", "PROBE_COMPLETED", "WORKSPACE_PREPARED"],
      artifactTypes: ["workspace"],
    };

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
      bundle,
    );
    expect(result.success).toBe(false);
    expect(result.actionSequenceVerified).toBe(true); // sequence is OK
    expect(result.runBundleVerified).toBe(false); // bundle is incomplete
    expect(
      result.errors.some((e) => e.includes("RED_CAPTURED")),
    ).toBe(true);
  });
});

describe("Canonical run identity", () => {
  it("binds CREATE_RUN to its tool result and later actions to that run", () => {
    const transcript = [
      JSON.stringify({
        step_index: 0,
        tool_calls: [
          {
            name: "contrib_create_run",
            args: { repoFullName: "owner/repo" },
            result: { runId: "run_123" },
          },
        ],
      }),
      JSON.stringify({
        step_index: 1,
        tool_calls: [
          {
            name: "contrib_probe_run",
            args: { runId: "run_123", target: "owner/repo" },
          },
        ],
      }),
    ].join("\n");

    const { actions } = parseTrajectoryFromJSONL(transcript);
    expect(actions[0]?.outputRunId).toBe("run_123");
    expect(actions[0]?.inputRunId).toBeUndefined();
    expect(actions[1]?.inputRunId).toBe("run_123");

    const result = crossValidateWithBundle(actions, {
      manifest: { runId: "run_123", currentPhase: "PROBE_COMPLETED" },
      events: [
        {
          eventId: "event-1",
          runId: "run_123",
          timestamp: new Date(0).toISOString(),
          phase: "INITIALIZED",
          eventType: "RUN_CREATED",
        },
        {
          eventId: "event-2",
          runId: "run_123",
          timestamp: new Date(1).toISOString(),
          phase: "INITIALIZED",
          eventType: "ARTIFACT_SAVED",
          payload: { artifactType: "probe" },
        },
        {
          eventId: "event-3",
          runId: "run_123",
          timestamp: new Date(2).toISOString(),
          phase: "PROBE_COMPLETED",
          eventType: "PHASE_TRANSITION",
          payload: {
            fromPhase: "INITIALIZED",
            toPhase: "PROBE_COMPLETED",
          },
        },
      ],
      artifacts: { probe: { runId: "run_123" } },
    });

    expect(result.verified).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("fails closed when the canonical manifest is missing", () => {
    const result = crossValidateWithBundle(
      [makeAction("CREATE_RUN", 0)],
      {
        eventPhases: ["INITIALIZED"],
        artifactTypes: ["workspace"],
      },
    );

    expect(result.verified).toBe(false);
    expect(result.errors[0]).toContain("Canonical manifest is required");
  });

  it("rejects malformed canonical run ids even when event identity agrees", () => {
    const invalidRunId = "run/with-invalid-separator";
    const result = crossValidateWithBundle([], {
      manifest: { runId: invalidRunId, currentPhase: "INITIALIZED" },
      events: [
        {
          eventId: "event-1",
          runId: invalidRunId,
          timestamp: new Date(0).toISOString(),
          phase: "INITIALIZED",
          eventType: "RUN_CREATED",
        },
      ],
    });

    expect(result.verified).toBe(false);
    expect(result.errors.some((error) => error.includes("valid runId"))).toBe(true);
  });

  it("does not treat a CREATE_RUN input id as its created run id", () => {
    const result = crossValidateWithBundle(
      [
        {
          ...makeAction("CREATE_RUN", 0),
          runId: "forged-input-id",
          inputRunId: "forged-input-id",
        },
      ],
      {
        manifest: { runId: "run_canonical", currentPhase: "INITIALIZED" },
        events: [
          {
            eventId: "event-1",
            runId: "run_canonical",
            timestamp: new Date(0).toISOString(),
            phase: "INITIALIZED",
            eventType: "RUN_CREATED",
          },
        ],
        artifacts: {},
      },
    );

    expect(result.verified).toBe(false);
    expect(result.errors.some((error) => error.includes("missing the runId returned"))).toBe(true);
  });

  it("validates phase transitions against the protocol DAG, including the PoC branch", () => {
    const validEvents = [
      {
        eventId: "event-1",
        runId: "run_dag",
        timestamp: new Date(0).toISOString(),
        phase: "INITIALIZED",
        eventType: "RUN_CREATED",
      },
      {
        eventId: "event-2",
        runId: "run_dag",
        timestamp: new Date(1).toISOString(),
        phase: "WORKSPACE_PREPARED",
        eventType: "PHASE_TRANSITION",
        payload: { fromPhase: "INITIALIZED", toPhase: "WORKSPACE_PREPARED" },
      },
      {
        eventId: "event-3",
        runId: "run_dag",
        timestamp: new Date(2).toISOString(),
        phase: "POC_GENERATED",
        eventType: "PHASE_TRANSITION",
        payload: { fromPhase: "WORKSPACE_PREPARED", toPhase: "POC_GENERATED" },
      },
      {
        eventId: "event-4",
        runId: "run_dag",
        timestamp: new Date(3).toISOString(),
        phase: "RED_CAPTURED",
        eventType: "PHASE_TRANSITION",
        payload: { fromPhase: "POC_GENERATED", toPhase: "RED_CAPTURED" },
      },
    ];
    const valid = crossValidateWithBundle(
      [makeAction("CREATE_RUN", 0, "run_dag")],
      {
        manifest: { runId: "run_dag", currentPhase: "RED_CAPTURED" },
        events: validEvents,
        artifacts: { workspace: { runId: "run_dag" } },
      },
    );
    expect(valid.verified).toBe(true);

    const invalid = crossValidateWithBundle(
      [makeAction("CREATE_RUN", 0, "run_dag")],
      {
        manifest: { runId: "run_dag", currentPhase: "POC_GENERATED" },
        events: [
          ...validEvents.slice(0, 2),
          {
            ...validEvents[3],
            eventId: "event-invalid-red",
            phase: "RED_CAPTURED",
            payload: { fromPhase: "WORKSPACE_PREPARED", toPhase: "RED_CAPTURED" },
          },
          {
            ...validEvents[2],
            eventId: "event-invalid-poc",
            timestamp: new Date(4).toISOString(),
            payload: { fromPhase: "RED_CAPTURED", toPhase: "POC_GENERATED" },
          },
        ],
        artifacts: { workspace: { runId: "run_dag" } },
      },
    );
    expect(invalid.verified).toBe(false);
    expect(invalid.errors.some((error) => error.includes("protocol DAG"))).toBe(true);
  });
});
