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
import type { BenchmarkBundle, ProtocolAction } from '../src/eval/types.js';

function makeAction(action: string, stepIndex: number): ProtocolAction {
  const toolName = Object.entries(TOOL_TO_ACTION).find(
    ([, verb]) => verb === action,
  )?.[0] ?? `unknown_${action}`;
  return { action, ingress: "mcp", toolName, stepIndex };
}

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

  it("Valid Track A sequence passes without bundle", () => {
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

    const result = executeBenchmarkScenario(
      scenario,
      actions,
      actions.length,
      0,
    );
    expect(result.success).toBe(true);
    expect(result.actionSequenceVerified).toBe(true);
    expect(result.errors).toHaveLength(0);
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

    // Bundle has events but missing RED_CAPTURED and PR_SUBMITTED phases
    const bundle: BenchmarkBundle = {
      eventPhases: ["INITIALIZED"],
      artifactTypes: ["workspace"],
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

    // Bundle has events but missing evidence_red, patch, evidence artifacts
    const bundle: BenchmarkBundle = {
      eventPhases: [
        "INITIALIZED",
        "RED_CAPTURED",
        "PATCH_DRAFTED",
        "EVIDENCE_COLLECTED",
      ],
      artifactTypes: ["workspace"], // missing evidence_red, patch, evidence
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(false);
    expect(errors.some((e) => e.includes("evidence_red"))).toBe(true);
    expect(errors.some((e) => e.includes("patch"))).toBe(true);
    expect(errors.some((e) => e.includes("evidence"))).toBe(true);
  });

  it("Valid bundle passes cross-validation", () => {
    const actions: ProtocolAction[] = [
      makeAction("CREATE_RUN", 0),
      makeAction("CAPTURE_RED", 1),
      makeAction("SAVE_ARTIFACT", 2),
      makeAction("VERIFY_GREEN", 3),
    ];

    const bundle: BenchmarkBundle = {
      eventPhases: [
        "INITIALIZED",
        "RED_CAPTURED",
        "PATCH_DRAFTED",
        "EVIDENCE_COLLECTED",
      ],
      artifactTypes: ["workspace", "evidence_red", "patch", "evidence", "validated_patch"],
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(true);
    expect(errors).toHaveLength(0);
  });

  it("Empty bundle fails with clear message", () => {
    const actions: ProtocolAction[] = [makeAction("CREATE_RUN", 0)];

    const bundle: BenchmarkBundle = {
      eventPhases: [],
      artifactTypes: [],
    };

    const { verified, errors } = crossValidateWithBundle(actions, bundle);
    expect(verified).toBe(false);
    expect(errors[0]).toContain("No run events");
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
