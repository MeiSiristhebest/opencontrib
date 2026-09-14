import type { ArtifactType, ContributionRunPhase } from "../run/types.js";

export interface ProtocolContractPhase {
  phase: ContributionRunPhase;
  name: string;
  description: string;
  cliCommand: string;
  mcpTool: string;
  prerequisites: ContributionRunPhase[];
  requiredArtifacts: ArtifactType[];
  forbiddenActions: string[];
  invariants: string[];
  suggestedNextAction: string;
}

export const PROTOCOL_CONTRACT_PHASES: Record<
  ContributionRunPhase,
  ProtocolContractPhase
> = {
  INITIALIZED: {
    phase: "INITIALIZED",
    name: "Run Initialization",
    description:
      "Fresh contribution session created, awaiting targeting and qualification.",
    cliCommand: "opencontrib run create --repo <owner/repo> [--issue <id>]",
    mcpTool: "contrib_create_run",
    prerequisites: [],
    requiredArtifacts: [],
    forbiddenActions: [
      "DO NOT modify source files or create git commits before scoping and qualifying the issue/target.",
    ],
    invariants: [
      "Every contribution cycle must originate from a tracked contribution run session.",
    ],
    suggestedNextAction:
      "opencontrib scout issues <owner/repo> or opencontrib probe run",
  },
  OPPORTUNITY_SCOUTED: {
    phase: "OPPORTUNITY_SCOUTED",
    name: "Opportunity Scouted",
    description: "Candidate defect or issue discovered, qualified, and scored.",
    cliCommand:
      'opencontrib scout issues <owner/repo> --label "good first issue"',
    mcpTool: "contrib_scout",
    prerequisites: ["INITIALIZED"],
    requiredArtifacts: ["opportunity"],
    forbiddenActions: [
      "DO NOT claim issues that already have active linked pull requests.",
    ],
    invariants: [
      "Target issues must meet feasibility scoring threshold before workspace isolation.",
    ],
    suggestedNextAction:
      "opencontrib discovery context --repo <owner/repo> --issue <id>",
  },
  PROBE_COMPLETED: {
    phase: "PROBE_COMPLETED",
    name: "Deep Probe Completed",
    description: "AST/SAST probes executed, Smart Pointers populated in store.",
    cliCommand: "opencontrib probe run [target]",
    mcpTool: "contrib_probe_run",
    prerequisites: ["INITIALIZED", "OPPORTUNITY_SCOUTED"],
    requiredArtifacts: ["probe"],
    forbiddenActions: [
      "DO NOT perform blind sequential file reads (> 3 views) across the repository.",
    ],
    invariants: [
      "Pinpoint symbols and defect context strictly via Smart Pointer slices (ptr://...).",
    ],
    suggestedNextAction: "opencontrib pointer resolve <uri> --view slice",
  },
  CONTEXT_ASSEMBLED: {
    phase: "CONTEXT_ASSEMBLED",
    name: "Context Assembled",
    description:
      "Minimal deterministic context bundle assembled without repository-wide token dump.",
    cliCommand:
      "opencontrib discovery context --repo <owner/repo> --issue <id>",
    mcpTool: "contrib_assemble_context",
    prerequisites: ["INITIALIZED", "OPPORTUNITY_SCOUTED", "PROBE_COMPLETED"],
    requiredArtifacts: ["context"],
    forbiddenActions: [
      "DO NOT dump raw multi-megabyte source trees into model context.",
    ],
    invariants: [
      "Context bundle must be minimal, structured, and contain exploration guidance.",
    ],
    suggestedNextAction:
      "opencontrib workspace prepare --repo <owner/repo> --issue <id>",
  },
  WORKSPACE_PREPARED: {
    phase: "WORKSPACE_PREPARED",
    name: "Workspace Sandbox Prepared",
    description:
      "Clean-room Git worktree allocated and isolated from working directory.",
    cliCommand:
      "opencontrib workspace prepare --repo <owner/repo> --issue <id>",
    mcpTool: "contrib_prepare_workspace",
    prerequisites: [
      "INITIALIZED",
      "OPPORTUNITY_SCOUTED",
      "PROBE_COMPLETED",
      "CONTEXT_ASSEMBLED",
    ],
    requiredArtifacts: ["workspace"],
    forbiddenActions: [
      "DO NOT edit source code files before reproducing a failing unit test (RED Phase).",
      "DO NOT run wide root tests (npm test / go test ./...) without scoping to the subpackage.",
    ],
    invariants: [
      "All development must take place inside isolated worktree sandbox.",
    ],
    suggestedNextAction:
      'opencontrib evidence capture-red --test-cmd "<test_cmd>" --assertion "<pattern>"',
  },
  POC_GENERATED: {
    phase: "POC_GENERATED",
    name: "Reproduction PoC Generated",
    description:
      "Standalone reproducible test or script demonstrating the bug before fix.",
    cliCommand: "opencontrib verify <target>",
    mcpTool: "contrib_verify_poc",
    prerequisites: ["WORKSPACE_PREPARED"],
    requiredArtifacts: ["workspace", "poc"],
    forbiddenActions: [
      "DO NOT modify production code while authoring reproduction PoC.",
    ],
    invariants: ["PoC must reliably fail against baseline code."],
    suggestedNextAction:
      'opencontrib evidence capture-red --test-cmd "<test_cmd>"',
  },
  PATCH_DRAFTED: {
    phase: "PATCH_DRAFTED",
    name: "Patch Drafted",
    description:
      "Targeted code fix implemented in worktree, awaiting verification.",
    cliCommand:
      "opencontrib run save <run_id> --type patch --content-file <file>",
    mcpTool: "contrib_save_artifact",
    prerequisites: ["WORKSPACE_PREPARED", "POC_GENERATED"],
    requiredArtifacts: ["workspace", "patch"],
    forbiddenActions: [
      "DO NOT exceed 100 modified lines without prior RFC issue discussion.",
    ],
    invariants: [
      "Diff must be minimal, surgical, and preserve existing architecture idioms.",
    ],
    suggestedNextAction:
      'opencontrib evidence verify-green --test-cmd "<test_cmd>"',
  },
  EVIDENCE_COLLECTED: {
    phase: "EVIDENCE_COLLECTED",
    name: "Evidence Collected",
    description:
      "Dual-stage RED->GREEN reproduction and stress loop evidence captured.",
    cliCommand: 'opencontrib evidence verify-green --test-cmd "<test_cmd>"',
    mcpTool: "contrib_collect_evidence",
    prerequisites: ["WORKSPACE_PREPARED", "POC_GENERATED", "PATCH_DRAFTED"],
    requiredArtifacts: ["workspace", "evidence"],
    forbiddenActions: ["DO NOT skip pre-fix failure verification."],
    invariants: [
      "Ensure unit test passed cleanly with 0 regressions before proceeding.",
    ],
    suggestedNextAction:
      'opencontrib governance audit --patch <file> --pr-title "<title>"',
  },
  GOVERNANCE_AUDITED: {
    phase: "GOVERNANCE_AUDITED",
    name: "Governance Audited",
    description:
      "RFC-100 line limit, anti-AI rubric, and quality confidence score verified.",
    cliCommand:
      'opencontrib governance audit --patch <file> --pr-title "<title>"',
    mcpTool: "contrib_audit_governance",
    prerequisites: ["EVIDENCE_COLLECTED"],
    requiredArtifacts: ["workspace", "evidence", "governance"],
    forbiddenActions: [
      "DO NOT commit or open a PR with failing governance audit score (<90 overall, <80 weakest).",
    ],
    invariants: [
      "Present patch diff and audit report to human reviewer before PR submission.",
    ],
    suggestedNextAction:
      'opencontrib governance pr-template --issue <id> --issue-title "<title>" --summary "<summary>"',
  },
  PR_SUBMITTED: {
    phase: "PR_SUBMITTED",
    name: "PR Submitted",
    description:
      "PR successfully submitted to target repository with verified PR number and URL.",
    cliCommand: 'gh pr create --title "<title>" --body-file pr-body.md',
    mcpTool: "contrib_render_pr_template",
    prerequisites: ["GOVERNANCE_AUDITED"],
    requiredArtifacts: ["workspace", "evidence", "governance"],
    forbiddenActions: [
      'DO NOT submit PR without linking issue ("Fixes #<id>").',
    ],
    invariants: [
      "PR must record actual reproduction command and verification result.",
    ],
    suggestedNextAction: "opencontrib flywheel sync --pr <pr_url>",
  },
  COMPLETED: {
    phase: "COMPLETED",
    name: "Contribution Completed",
    description:
      "All 9 phases completed, memory ledger and developer heuristics synchronized.",
    cliCommand: "opencontrib flywheel sync",
    mcpTool: "contrib_sync_flywheel",
    prerequisites: ["PR_SUBMITTED"],
    requiredArtifacts: ["workspace"],
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
    cliCommand: "opencontrib run resume <run_id>",
    mcpTool: "contrib_resume_run",
    prerequisites: [],
    requiredArtifacts: [],
    forbiddenActions: [],
    invariants: [],
    suggestedNextAction:
      "Inspect error logs and resume run with opencontrib run resume <run_id>",
  },
};
