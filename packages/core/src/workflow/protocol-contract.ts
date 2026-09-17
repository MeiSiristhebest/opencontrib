import type { ArtifactType, ContributionRunPhase } from "../run/types.js";

export interface ProtocolContractPhase {
  phase: ContributionRunPhase;
  name: string;
  description: string;
  allowedFromPhases: ContributionRunPhase[];
  requiredArtifacts: ArtifactType[];
  cli: {
    command: string;
    subcommand?: string;
    subcommands?: string[];
    example: string;
  };
  mcp: {
    tool: string;
  };
  forbiddenActions: string[];
  invariants: string[];
  suggestedNextAction: string;
}

export const PROTOCOL_CONTRACT_PHASES = {
  INITIALIZED: {
    phase: "INITIALIZED",
    name: "Run Initialization",
    description:
      "Fresh contribution session created, awaiting targeting and qualification.",
    allowedFromPhases: [],
    requiredArtifacts: [],
    cli: {
      command: "run",
      subcommand: "create",
      example: "opencontrib run create --repo <owner/repo> [--issue <id>]",
    },
    mcp: {
      tool: "contrib_create_run",
    },
    forbiddenActions: [
      "DO NOT modify source files or create git commits before scoping and qualifying the issue/target.",
    ],
    invariants: [
      "Every contribution cycle must originate from a tracked contribution run session.",
    ],
    suggestedNextAction: "scout",
  },
  OPPORTUNITY_SCOUTED: {
    phase: "OPPORTUNITY_SCOUTED",
    name: "Opportunity Scouted",
    description: "Candidate defect or issue discovered, qualified, and scored.",
    allowedFromPhases: ["INITIALIZED"],
    requiredArtifacts: ["opportunity"],
    cli: {
      command: "scout",
      example: "opencontrib scout <owner/repo> --focus bugfix,testing",
    },
    mcp: {
      tool: "contrib_scout",
    },
    forbiddenActions: [
      "DO NOT claim issues that already have active linked pull requests.",
    ],
    invariants: [
      "Target issues must meet feasibility scoring threshold before workspace isolation.",
    ],
    suggestedNextAction: "assemble_context",
  },
  PROBE_COMPLETED: {
    phase: "PROBE_COMPLETED",
    name: "Deep Probe Completed",
    description: "AST/SAST probes executed, Smart Pointers populated in store.",
    allowedFromPhases: ["INITIALIZED", "OPPORTUNITY_SCOUTED"],
    requiredArtifacts: ["probe"],
    cli: {
      command: "probe",
      subcommand: "run",
      example: "opencontrib probe run [target] --limit 5",
    },
    mcp: {
      tool: "contrib_probe_run",
    },
    forbiddenActions: [
      "DO NOT perform blind sequential file reads (> 3 views) across the repository.",
    ],
    invariants: [
      "Pinpoint symbols and defect context strictly via Smart Pointer slices (ptr://...).",
    ],
    suggestedNextAction: "assemble_context",
  },
  CONTEXT_ASSEMBLED: {
    phase: "CONTEXT_ASSEMBLED",
    name: "Context Assembled",
    description:
      "Minimal deterministic context bundle assembled without repository-wide token dump.",
    allowedFromPhases: [
      "INITIALIZED",
      "OPPORTUNITY_SCOUTED",
      "PROBE_COMPLETED",
    ],
    requiredArtifacts: ["context"],
    cli: {
      command: "discovery",
      subcommand: "context",
      example: "opencontrib discovery context --input <json>",
    },
    mcp: {
      tool: "contrib_assemble_context",
    },
    forbiddenActions: [
      "DO NOT dump raw multi-megabyte source trees into model context.",
    ],
    invariants: [
      "Context bundle must be minimal, structured, and contain exploration guidance.",
    ],
    suggestedNextAction: "prepare_workspace",
  },
  WORKSPACE_PREPARED: {
    phase: "WORKSPACE_PREPARED",
    name: "Workspace Sandbox Prepared",
    description:
      "Clean-room Git worktree allocated and isolated from working directory.",
    allowedFromPhases: [
      "INITIALIZED",
      "OPPORTUNITY_SCOUTED",
      "PROBE_COMPLETED",
      "CONTEXT_ASSEMBLED",
    ],
    requiredArtifacts: ["workspace"],
    cli: {
      command: "workspace",
      subcommand: "prepare",
      example: "opencontrib workspace prepare --repo <owner/repo> --issue <id>",
    },
    mcp: {
      tool: "contrib_prepare_workspace",
    },
    forbiddenActions: [
      "DO NOT edit source code files before reproducing a failing unit test (RED Phase).",
      "DO NOT run wide root tests (npm test / go test ./...) without scoping to the subpackage.",
    ],
    invariants: [
      "All development must take place inside isolated worktree sandbox.",
    ],
    suggestedNextAction: "capture_red",
  },
  RED_CAPTURED: {
    phase: "RED_CAPTURED",
    name: "RED Baseline Captured",
    description:
      "A trusted host execution recorded the target assertion failing on the immutable workspace baseline.",
    allowedFromPhases: ["WORKSPACE_PREPARED", "POC_GENERATED"],
    requiredArtifacts: ["workspace", "evidence_red"],
    cli: {
      command: "evidence",
      subcommand: "capture-red",
      example:
        "opencontrib evidence capture-red --test-cmd '<cmd>' --assertion '<pattern>'",
    },
    mcp: {
      tool: "contrib_capture_red",
    },
    forbiddenActions: [
      "DO NOT edit production code before the target RED assertion is captured.",
      "DO NOT accept an unrelated failing suite as the target reproduction.",
    ],
    invariants: [
      "The RED command, assertion, test identity, baseline commit, and source tree hash are recorded by EvidenceService.",
      "RED must exit non-zero and match the expected assertion before patch drafting.",
    ],
    suggestedNextAction: "draft_patch",
  },
  POC_GENERATED: {
    phase: "POC_GENERATED",
    name: "Reproduction PoC Generated",
    description:
      "Standalone reproducible test or script demonstrating the bug before fix.",
    allowedFromPhases: ["WORKSPACE_PREPARED"],
    requiredArtifacts: ["workspace", "poc"],
    cli: {
      command: "verify",
      example: "opencontrib verify <target>",
    },
    mcp: {
      tool: "contrib_verify_poc",
    },
    forbiddenActions: [
      "DO NOT modify production code while authoring reproduction PoC.",
    ],
    invariants: ["PoC must reliably fail against baseline code."],
    suggestedNextAction: "draft_patch",
  },
  PATCH_DRAFTED: {
    phase: "PATCH_DRAFTED",
    name: "Patch Drafted",
    description:
      "Targeted code fix implemented in worktree, awaiting verification.",
    allowedFromPhases: ["RED_CAPTURED", "POC_GENERATED"],
    requiredArtifacts: ["workspace", "evidence_red"],
    cli: {
      command: "run",
      subcommand: "save",
      example: "opencontrib run save <run_id> --type patch --content <json>",
    },
    mcp: {
      tool: "contrib_save_artifact",
    },
    forbiddenActions: [
      "DO NOT edit production files directly from INITIALIZED without workspace preparation.",
      "DO NOT exceed 100 modified lines without prior RFC issue discussion.",
    ],
    invariants: [
      "Diff must be minimal, surgical, and preserve existing architecture idioms.",
    ],
    suggestedNextAction: "collect_evidence",
  },
  EVIDENCE_COLLECTED: {
    phase: "EVIDENCE_COLLECTED",
    name: "Evidence Collected",
    description:
      "Dual-stage RED->GREEN reproduction and stress loop evidence captured.",
    allowedFromPhases: ["PATCH_DRAFTED"],
    requiredArtifacts: ["workspace", "patch", "evidence", "validated_patch"],
    cli: {
      command: "evidence",
      example:
        "opencontrib evidence capture-red --test-cmd '<test_cmd>' --assertion '<pattern>' && opencontrib evidence verify-green --test-cmd '<test_cmd>'",
      subcommands: ["capture-red", "verify-green"],
    },
    mcp: {
      tool: "contrib_verify_green",
    },
    forbiddenActions: [
      "DO NOT skip pre-fix failure verification.",
      "DO NOT enter this phase on a passing test alone — a captured RED baseline is required.",
    ],
    invariants: [
      "A RED baseline (failing test + matching assertion) must be captured before the fix.",
      "The source tree must have changed between the RED capture and the GREEN run.",
      "Ensure unit test passed cleanly with 0 regressions before proceeding.",
    ],
    suggestedNextAction: "prepare_pr_draft",
  },
  GOVERNANCE_AUDITED: {
    phase: "GOVERNANCE_AUDITED",
    name: "Governance Audited",
    description:
      "RFC-100 line limit, anti-AI rubric, and quality confidence score verified.",
    allowedFromPhases: ["EVIDENCE_COLLECTED"],
    requiredArtifacts: [
      "workspace",
      "patch",
      "validated_patch",
      "evidence",
      "pr_draft",
      "governance",
    ],
    cli: {
      command: "governance",
      subcommand: "audit",
      example:
        'opencontrib governance audit --run-id <run_id> --pr-title "<title>"',
    },
    mcp: {
      tool: "contrib_audit_governance",
    },
    forbiddenActions: [
      "DO NOT commit or open a PR with failing governance audit score (<90 overall, <80 weakest).",
    ],
    invariants: [
      "Present patch diff and audit report to human reviewer before PR submission.",
    ],
    suggestedNextAction: "request_approval",
  },
  PR_SUBMITTED: {
    phase: "PR_SUBMITTED",
    name: "PR Submitted",
    description:
      "PR successfully submitted to target repository with verified PR number and URL.",
    allowedFromPhases: ["GOVERNANCE_AUDITED"],
    requiredArtifacts: [
      "workspace",
      "patch",
      "validated_patch",
      "evidence",
      "governance",
      "submission_intent",
      "approval",
      "submission",
    ],
    cli: {
      command: "submission",
      subcommand: "submit",
      example: "opencontrib submission submit --run-id <id>",
    },
    mcp: {
      tool: "contrib_submit_pr",
    },
    forbiddenActions: [
      'DO NOT submit PR without linking issue ("Fixes #<id>").',
    ],
    invariants: [
      "PR must record actual reproduction command and verification result.",
    ],
    suggestedNextAction: "sync_flywheel",
  },
  COMPLETED: {
    phase: "COMPLETED",
    name: "Contribution Completed",
    description:
      "All 9 phases completed, memory ledger and developer heuristics synchronized.",
    allowedFromPhases: ["PR_SUBMITTED"],
    requiredArtifacts: ["workspace", "submission", "result"],
    cli: {
      command: "flywheel",
      subcommand: "sync",
      example: "opencontrib flywheel sync --repo <owner/repo>",
    },
    mcp: {
      tool: "contrib_sync_flywheel",
    },
    forbiddenActions: [],
    invariants: [
      "Flywheel sync records contribution heuristics into persistent memory.",
    ],
    suggestedNextAction: "none (run completed)",
  },
  FAILED: {
    phase: "FAILED",
    name: "Contribution Failed",
    description: "Run terminated due to gate block or irrecoverable error.",
    allowedFromPhases: [
      "INITIALIZED",
      "OPPORTUNITY_SCOUTED",
      "PROBE_COMPLETED",
      "CONTEXT_ASSEMBLED",
      "WORKSPACE_PREPARED",
      "RED_CAPTURED",
      "POC_GENERATED",
      "PATCH_DRAFTED",
      "EVIDENCE_COLLECTED",
      "GOVERNANCE_AUDITED",
      "PR_SUBMITTED",
    ],
    requiredArtifacts: [],
    cli: {
      command: "run",
      subcommand: "resume",
      example: "opencontrib run resume [run_id]",
    },
    mcp: {
      tool: "contrib_resume_run",
    },
    forbiddenActions: [],
    invariants: [],
    suggestedNextAction: "inspect_failure_and_replan",
  },
} satisfies Record<ContributionRunPhase, ProtocolContractPhase>;

/** Derived from PROTOCOL_CONTRACT_PHASES as single source of truth */
export const DERIVED_PHASE_REQUIREMENTS = Object.fromEntries(
  Object.entries(PROTOCOL_CONTRACT_PHASES).map(([phase, def]) => [
    phase,
    {
      fromPhases: def.allowedFromPhases,
      requiredArtifacts: def.requiredArtifacts,
      suggestedAction: def.suggestedNextAction,
    },
  ]),
) as Record<
  ContributionRunPhase,
  {
    fromPhases: ContributionRunPhase[];
    requiredArtifacts: ArtifactType[];
    suggestedAction: string;
  }
>;
