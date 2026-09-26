/** `opencontrib governance <sub>` — Audit, impact, CI diagnosis, PR template. */

import { Command } from "commander";
import {
  auditGovernance,
  analyzePatchImpactAndConsistency,
  parseCiRawLogs,
  renderMasterPrTemplate,
  resolveCanonicalSubmissionRoute,
  validateMarkdownIntegrity,
  buildContributionRunManager,
  detectCommunityGate,
  getOpenContribDataDir,
  ActiveSessionManager,
  type ContributionRunManager,
} from "@opencontrib/core";

import {
  printJSON,
  parseJSON,
  readStdin,
  printPhaseGuidance,
  printCommunityGateAlert,
} from "../utils/output.js";
import { CliExitError } from "../utils/exit.js";

import fs from "node:fs";
import path from "node:path";

// Lazy factory: constructed on first use, not at module load time.
let _runManager: ContributionRunManager | null = null;
let _runManagerHome = "";
const getRunManager = (): ContributionRunManager => {
  // Test harnesses and the global --home option can change the storage root
  // after this command module has been imported. Never reuse a manager bound
  // to a different home, or an active session from that home can leak into a
  // diagnostic-only command.
  const currentHome = getOpenContribDataDir();
  if (!_runManager || _runManagerHome !== currentHome) {
    _runManager = buildContributionRunManager();
    _runManagerHome = currentHome;
  }
  return _runManager;
};

// ─── governance audit ─────────────────────────────────────────────────────────
const auditCommand = new Command("audit")
  .description(
    "Audit patch for anti-AI patterns, diff size, markdown integrity, and quality confidence rubric",
  )
  .option(
    "--patch <file-or-text>",
    "Git unified diff content or path to .diff/.patch file (optional if --run-id is provided)",
  )
  .requiredOption("--pr-title <text>", "Proposed PR title")
  .option("--pr-body <text>", "Proposed PR body text")
  .option(
    "--pr-body-file <path>",
    "Path to markdown file containing proposed PR body",
  )
  .option(
    "--evidence <json>",
    "Diagnostic evidence JSON; canonical runs use capture-red and verify-green",
  )
  .option("--evidence-file <path>", "Path to evidence.json file")
  .option(
    "--subagent-score <n>",
    "External subagent quality score (0-100)",
    (v) => Number(v),
  )
  .option(
    "--is-autonomous",
    "Whether preparing for autonomous PR submission",
    false,
  )
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option(
    "--require-coverage",
    "Require measured changed-code coverage to satisfy the repository policy",
    false,
  )
  .option(
    "--coverage-minimum <n>",
    "Minimum changed-code coverage percentage when coverage is required",
    (v) => {
      const parsed = Number(v);
      if (!Number.isFinite(parsed)) {
        throw new Error("--coverage-minimum must be a finite number");
      }
      return parsed;
    },
  )
  .option(
    "--require-resource-leak-check",
    "Require trusted resource/handle leak evidence",
    false,
  )
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      patch?: string;
      prTitle: string;
      prBody?: string;
      prBodyFile?: string;
      evidence?: string;
      evidenceFile?: string;
      subagentScore?: number;
      isAutonomous?: boolean;
      runId?: string;
      requireCoverage?: boolean;
      coverageMinimum?: number;
      requireResourceLeakCheck?: boolean;
      pretty?: boolean;
    }) => {
      try {
        const coverageMinimum = opts.coverageMinimum;
        if (
          coverageMinimum !== undefined &&
          (coverageMinimum < 0 || coverageMinimum > 100)
        ) {
          console.error("❌ --coverage-minimum must be between 0 and 100.");
          throw new CliExitError(2);
        }
        const runId = getRunManager().resolveRunId(opts.runId);

        let patchContent = opts.patch || "";
        if (opts.patch && fs.existsSync(opts.patch)) {
          try {
            patchContent = fs.readFileSync(opts.patch, "utf-8");
          } catch (err: any) {
            console.error(
              `Failed to read patch file "${opts.patch}": ${err.message}`,
            );
            throw new CliExitError(1);
          }
        } else if (!patchContent && runId) {
          const run = getRunManager().getRun(runId);
          if (run?.artifacts?.patch) {
            patchContent =
              typeof run.artifacts.patch === "string"
                ? run.artifacts.patch
                : JSON.stringify(run.artifacts.patch);
          }
        }

        if (!patchContent && !runId) {
          console.error(
            "❌ --patch is required when no active runId is provided.",
          );
          throw new CliExitError(1);
        }

        let prBodyContent = opts.prBody;
        if (opts.prBodyFile && fs.existsSync(opts.prBodyFile)) {
          try {
            prBodyContent = fs.readFileSync(opts.prBodyFile, "utf-8");
          } catch (err: any) {
            console.error(
              `Failed to read PR body file "${opts.prBodyFile}": ${err.message}`,
            );
            throw new CliExitError(1);
          }
        }

        let evidence: import("@opencontrib/core").EvidenceReport | undefined;
        if (opts.evidenceFile && fs.existsSync(opts.evidenceFile)) {
          try {
            const raw = JSON.parse(fs.readFileSync(opts.evidenceFile, "utf-8"));
            const { EvidenceReportSchema } = await import("@opencontrib/core");
            const parsed = EvidenceReportSchema.safeParse(raw);
            if (!parsed.success) {
              console.error(
                `❌ Invalid evidence in "${opts.evidenceFile}": ${parsed.error.message}`,
              );
              throw new CliExitError(1);
            }
            evidence = parsed.data;
          } catch (err: any) {
            if (err instanceof CliExitError) throw err;
            console.error(
              `Failed to read evidence file "${opts.evidenceFile}": ${err.message}`,
            );
            throw new CliExitError(1);
          }
        } else if (opts.evidence) {
          const raw = parseJSON(opts.evidence, "--evidence");
          const { EvidenceReportSchema } = await import("@opencontrib/core");
          const parsed = EvidenceReportSchema.safeParse(raw);
          if (!parsed.success) {
            console.error(
              `❌ Invalid --evidence payload: ${parsed.error.message}`,
            );
            throw new CliExitError(1);
          }
          evidence = parsed.data;
        } else if (runId) {
          try {
            const run = getRunManager().getRun(runId);
            if (run?.artifacts?.evidence) {
              const { EvidenceReportSchema } =
                await import("@opencontrib/core");
              const parsed = EvidenceReportSchema.safeParse(
                run.artifacts.evidence,
              );
              evidence = parsed.success ? parsed.data : undefined;
            }
          } catch (err: any) {
            console.warn(
              `[Governance] Warning: Could not auto-load evidence from run "${runId}": ${err.message}`,
            );
          }
        }

        const audit = auditGovernance({
          patchContent,
          prTitle: opts.prTitle,
          prBody: prBodyContent || "",
          evidence,
          coveragePolicy: {
            required: opts.requireCoverage ?? false,
            minimumChangedLineCoverage: opts.coverageMinimum,
          },
          resourceLeakPolicy: {
            required: opts.requireResourceLeakCheck ?? false,
          },
          subagentQualityScore: opts.subagentScore,
          isAutonomousPrSubmission: opts.isAutonomous ?? false,
        });

        let canonicalDecision: any;
        let isPassed = audit.overallConfidence.isPassed;

        if (runId) {
          const { GovernanceService } = await import("@opencontrib/core");
          const govService = new GovernanceService(getRunManager());
          canonicalDecision = govService.audit(runId, {
            prTitle: opts.prTitle,
            prBody: prBodyContent, // undefined unless explicitly provided by caller
            subagentScore: opts.subagentScore,
            isAutonomous: opts.isAutonomous,
            coveragePolicy: {
              required: opts.requireCoverage ?? false,
              minimumChangedLineCoverage: coverageMinimum,
            },
            resourceLeakPolicy: {
              required: opts.requireResourceLeakCheck ?? false,
            },
          });
          // When running against a tracked run, the authoritative GovernanceService decision is the source of truth
          isPassed = Boolean(canonicalDecision?.passed);
        }

        printJSON(
          {
            status: isPassed ? "passed" : "failed",
            audit,
            canonicalDecision,
          },
          opts.pretty,
        );

        if (!isPassed) {
          printPhaseGuidance({
            currentPhase: "GOVERNANCE_AUDITED",
            runId,
            status: "GATED_BLOCKED",
            humanCheckpoint: "Checkpoint 3 (Governance Quality Gate Failure)",
            forbiddenActions: audit.guidance.forbiddenActions,
            invariants: audit.guidance.invariants,
            nextCommand: audit.guidance.nextCommand,
          });
          throw new CliExitError(2);
        }

        printPhaseGuidance({
          currentPhase: "GOVERNANCE_AUDITED",
          runId,
          status: "SUCCESS",
          humanCheckpoint: "Checkpoint 3 (Pre-Flight Review - Ready for PR)",
          nextCommand: runId
            ? `opencontrib governance request-approval --run-id ${runId}`
            : "opencontrib governance request-approval",
          invariants: audit.guidance.invariants,
        });
      } catch (err: any) {
        if (err instanceof CliExitError) throw err;
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── governance impact ────────────────────────────────────────────────────────
const impactCommand = new Command("impact")
  .description(
    "Analyze patch for cross-platform anti-patterns and overlooked sibling files",
  )
  .requiredOption("--patch <file-or-text>", "Git unified diff content")
  .requiredOption(
    "--modified-files <list>",
    "Comma-separated list of modified files",
    (v) => v.split(","),
  )
  .option(
    "--repo-context <list>",
    "Comma-separated repo file paths for sibling detection",
    (v) => v.split(","),
  )
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      patch: string;
      modifiedFiles: string[];
      repoContext?: string[];
      pretty?: boolean;
    }) => {
      try {
        const analysis = analyzePatchImpactAndConsistency({
          modifiedFiles: opts.modifiedFiles,
          patchContent: opts.patch,
          repoContextFiles: opts.repoContext,
        });
        printJSON(
          {
            status: analysis.isCompliant ? "compliant" : "warnings_found",
            analysis,
          },
          opts.pretty,
        );
      } catch (err: any) {
        if (err instanceof CliExitError) throw err;
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── governance ci-diagnose ───────────────────────────────────────────────────
const ciDiagnoseCommand = new Command("ci-diagnose")
  .description(
    "Parse CI logs to extract failing test names, line numbers, and root causes",
  )
  .option(
    "--log-file <path>",
    "Path to raw CI/terminal log file (or pipe via stdin)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(async (opts: { pretty?: boolean }, _cmd: Command) => {
    try {
      const logFile = (opts as any)["log-file"];
      let rawLog: string;
      if (logFile) {
        const fsLib = await import("fs");
        rawLog = fsLib.readFileSync(logFile, "utf-8");
      } else {
        rawLog = await readStdin();
      }
      if (!rawLog) {
        console.error(
          "❌ No log input. Use --log-file <path> or pipe via stdin",
        );
        throw new CliExitError(1);
      }
      const report = parseCiRawLogs(rawLog);
      printJSON(
        {
          status: report.hasFailure ? "failure_detected" : "healthy",
          report,
        },
        opts.pretty,
      );
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

// ─── governance pr-template ───────────────────────────────────────────────────
const prTemplateCommand = new Command("pr-template")
  .description(
    "Render a clean PR description following target repo template or Master 6-Tier standard",
  )
  .option(
    "--issue <num>",
    "Fixed issue number (diagnostic-only when --run-id is supplied)",
  )
  .requiredOption("--issue-title <text>", "Title of the issue")
  .requiredOption("--summary <text>", "Concise fix summary")
  .option("--validation-cmd <cmd>", "Command used to verify the fix")
  .option("--validation-output <text>", "Test passing log excerpt")
  .option(
    "--native-template <text>",
    "Raw markdown of target repo PULL_REQUEST_TEMPLATE.md",
  )
  .option(
    "--key-changes <list>",
    "Comma-separated list of key changes made",
    (v) => v.split(","),
  )
  .option("--confidence <n>", "Quality confidence score (0-100)", (v) =>
    Number(v),
  )
  .option("--risk <level>", "Risk tier", (v) =>
    (["LOW", "MEDIUM", "HIGH"] as const).includes(v as any)
      ? (v as "LOW" | "MEDIUM" | "HIGH")
      : "MEDIUM",
  )
  .option("--is-docs-only", "Documentation-only change", false)
  .option("--ai-disclosure", "AI disclosure required by repo", false)
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print", false)
  .action(
    async (opts: {
      issue?: string;
      issueTitle: string;
      summary: string;
      validationCmd?: string;
      validationOutput?: string;
      nativeTemplate?: string;
      keyChanges?: string[];
      confidence?: number;
      risk?: "LOW" | "MEDIUM" | "HIGH";
      isDocsOnly?: boolean;
      aiDisclosure?: boolean;
      runId?: string;
      pretty?: boolean;
    }) => {
      try {
        const runId = opts.runId ? getRunManager().resolveRunId(opts.runId) : undefined;
        const canonicalRun = runId ? getRunManager().getRun(runId) : undefined;
        if (opts.runId && !canonicalRun) {
          throw new Error(`Contribution run "${runId}" not found.`);
        }
        const canonicalRoute = canonicalRun
          ? resolveCanonicalSubmissionRoute(canonicalRun)
          : undefined;
        const diagnosticIssueNumber = Number(opts.issue);
        const issueNumber = canonicalRoute
          ? canonicalRoute.route === "PUBLIC_ISSUE"
            ? canonicalRoute.issueBinding!.providerIssueId
            : undefined
          : diagnosticIssueNumber;
        if (
          !canonicalRoute &&
          (!Number.isInteger(diagnosticIssueNumber) || diagnosticIssueNumber <= 0)
        ) {
          throw new Error(
            "CanonicalIssueBindingRequiredError: --issue must be a positive integer when rendering without a canonical run.",
          );
        }
        const resolvedIssueNumber = issueNumber;
        let evidence: import("@opencontrib/core").EvidenceReport | undefined;
        if (runId) {
          const { EvidenceReportSchema } = await import("@opencontrib/core");
          const parsed = EvidenceReportSchema.safeParse(
            canonicalRun?.artifacts.evidence,
          );
          if (parsed.success) {
            evidence = parsed.data;
          } else {
            console.warn(
              `[Governance] Run ${runId} has no canonical EvidenceReport; rendering an unverified template.`,
            );
          }
        }

        const prBody = renderMasterPrTemplate({
          keyChanges: opts.keyChanges || [],
          nativeTemplateContent: opts.nativeTemplate,
          issueNumber: resolvedIssueNumber,
          submissionRoute: canonicalRoute?.route,
          issueTitle:
            canonicalRoute?.issueBinding?.title ??
            canonicalRun?.manifest.issueTitle ??
            opts.issueTitle,
          summary: opts.summary,
          // A canonical run may only render verification facts from its
          // host-owned EvidenceReport; CLI-supplied validation text is
          // diagnostic-only and cannot enter the stored PR draft.
          validationCommand: runId ? undefined : opts.validationCmd,
          validationOutputSnippet: runId ? undefined : opts.validationOutput,
          confidenceScore: opts.confidence,
          riskLevel: opts.risk,
          isDocumentationOnly: opts.isDocsOnly ?? false,
          aiDisclosureRequired: canonicalRoute
            ? canonicalRoute.policy.requiresAiDisclosure === true
            : opts.aiDisclosure ?? false,
          dcoRequired: canonicalRoute?.policy.requiresDco === true,
          evidence,
        });

        if (runId && getRunManager().getRun(runId)) {
          getRunManager().saveArtifact(runId, "pr_draft", prBody);
        }

        const effectivePhase = runId
          ? getRunManager().getRun(runId)?.manifest.currentPhase
          : "PATCH_DRAFTED";
        printJSON({ status: "success", prBody }, opts.pretty);

        printPhaseGuidance({
          currentPhase: effectivePhase,
          runId,
          status: "SUCCESS",
          humanCheckpoint:
            "Checkpoint 3 (PR Drafted & Ready for Governance Audit)",
          nextCommand: runId
            ? `opencontrib governance audit --run-id ${runId} --pr-title "${opts.issueTitle}"`
            : `opencontrib governance audit --patch <file> --pr-title "${opts.issueTitle}"`,
          invariants: [
            canonicalRoute?.route === "PRIVATE_SECURITY"
              ? "Do not add a public Fixes/Closes issue reference; use the provider-authorized security route."
              : 'Ensure the PR description includes the provider-bound "Fixes #<issue_number>" reference.',
            "Audit governance before requesting approval.",
          ],
        });
      } catch (err: any) {
        if (err instanceof CliExitError) throw err;
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── governance claim / render-issue ─────────────────────────────────────────
const claimCommand = new Command("claim")
  .alias("render-issue")
  .description(
    "Generate an authoritative Claim artifact for the run's selected submission route",
  )
  .requiredOption(
    "--issue <num>",
    "Target issue number (or temporary ID for 0-day)",
    "0",
  )
  .requiredOption("--title <text>", "Title of the issue")
  .option("--finding <summary>", "Summary of root cause and file/line location")
  .option("--test-snippet <snippet>", "Reproduction test code snippet")
  .option("--pretty", "Pretty-print JSON output", false)
  .action(
    async (opts: {
      issue: string;
      title: string;
      finding?: string;
      testSnippet?: string;
      pretty?: boolean;
    }) => {
      try {
        const { ClaimProtocol } = await import("@opencontrib/core");
        const num = parseInt(opts.issue, 10) || 0;
        const payload = ClaimProtocol.generateClaimPayload(num, opts.title);
        if (opts.finding) {
          payload.findingSummary = opts.finding;
        }
        if (opts.testSnippet) {
          payload.claimComment += `\n\n\`\`\`\n${opts.testSnippet}\n\`\`\``;
        }
        printJSON({ status: "success", payload }, opts.pretty);
      } catch (err: any) {
        if (err instanceof CliExitError) throw err;
        printJSON({ status: "error", message: err.message }, opts.pretty);
        throw new CliExitError(1);
      }
    },
  );

// ─── governance lint-md ───────────────────────────────────────────────────────
const lintMdCommand = new Command("lint-md")
  .description(
    "Run 5-layer industrial static validation on Markdown file or stdin",
  )
  .argument(
    "[file]",
    "Path to markdown file to validate (reads from stdin if omitted)",
  )
  .option("--pretty", "Pretty-print", false)
  .action(async (file?: string, opts?: { pretty?: boolean }) => {
    try {
      let content = "";
      if (file && fs.existsSync(file)) {
        content = fs.readFileSync(file, "utf-8");
      } else {
        content = await readStdin();
      }
      const report = validateMarkdownIntegrity(content);
      printJSON(
        {
          status: report.isValid ? "passed" : "failed",
          report,
        },
        opts?.pretty,
      );
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts?.pretty);
      throw new CliExitError(1);
    }
  });

// ─── governance gate ──────────────────────────────────────────────────────────
const gateCommand = new Command("gate")
  .description(
    "Detect community contribution rules, auto-close policies, and issue approval requirements",
  )
  .argument("[target]", "Path to target repository workspace", ".")
  .option("--pretty", "Pretty-print JSON output", false)
  .action(async (target = ".", opts: { pretty?: boolean }) => {
    try {
      const active = ActiveSessionManager.getActiveSession();
      const resolved =
        target === "." &&
        active?.workspacePath &&
        fs.existsSync(active.workspacePath)
          ? active.workspacePath
          : path.resolve(target);

      const gate = await detectCommunityGate(resolved);
      printJSON({ status: "success", target: resolved, gate }, opts?.pretty);

      if (gate.hasGatingRules) {
        printCommunityGateAlert({
          repo: active?.repoFullName || path.basename(resolved),
          reasons: gate.reasons,
          suggestedAction: gate.suggestedContributorAction,
          isPaused: gate.requiresIssueApprovalBeforePr,
        });
      }
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts?.pretty);
      throw new CliExitError(1);
    }
  });

// ─── governance request-approval ─────────────────────────────────────────────
const approveCommand = new Command("request-approval")
  .description(
    "Create a cryptographically bound approval challenge; only a trusted host may mint the approval artifact",
  )
  .option("--run-id <id>", "Contribution run ID (defaults to active session)")
  .option("--pretty", "Pretty-print", false)
  .action(async (opts: { runId?: string; pretty?: boolean }) => {
    try {
      const runId = getRunManager().resolveRunId(opts.runId);
      if (!runId) {
        console.error(
          "❌ No runId found in active session or --run-id option.",
        );
        throw new CliExitError(1);
      }

      const runManager = getRunManager();
      const run = runManager.getRun(runId);
      if (!run) {
        throw new Error(`Run "${runId}" does not exist.`);
      }

      const [owner, repo] = (run.manifest.repoFullName || "").split("/");
      if (!owner || !repo) {
        throw new Error(
          `Cannot determine upstream repository from manifest "${run.manifest.repoFullName}".`,
        );
      }

      // Ensure SubmissionIntent exists before challenging approval
      if (!run.artifacts?.submissionIntent) {
        const { SubmissionIntentService } = await import("@opencontrib/core");
        new SubmissionIntentService(runManager).createIntent({
          runId,
          upstreamOwner: owner,
          upstreamRepo: repo,
        });
      }

      const { ApprovalService } = await import("@opencontrib/core");
      const challenge = new ApprovalService(runManager).requestApproval(runId);
      printJSON(
        {
          status: "APPROVAL_REQUESTED",
          challenge,
          message:
            "SubmissionIntent created & Challenge issued. A trusted human/policy host must mint the approval; this CLI command never self-approves.",
        },
        opts.pretty,
      );
      printPhaseGuidance({
        currentPhase: "GOVERNANCE_AUDITED",
        runId,
        status: "SUCCESS",
        humanCheckpoint: "Checkpoint 3 (Awaiting Trusted Approval Authority)",
        nextCommand: `opencontrib submission submit --run-id ${runId}`,
        invariants: [
          "No approval artifact was minted by the agent-facing CLI.",
          "Submission remains blocked until a trusted authority records the exact challenge hash.",
        ],
      });
    } catch (err: any) {
      if (err instanceof CliExitError) throw err;
      printJSON({ status: "error", message: err.message }, opts.pretty);
      throw new CliExitError(1);
    }
  });

// ─── Top-level command ────────────────────────────────────────────────────────

export const governanceCommand = new Command("governance")
  .description(
    "Governance audit, impact analysis, CI diagnosis, PR template rendering, Issue Claim generation, community gate detection, and Markdown linting",
  )
  .addCommand(auditCommand)
  .addCommand(approveCommand)
  .addCommand(gateCommand)
  .addCommand(impactCommand)
  .addCommand(ciDiagnoseCommand)
  .addCommand(prTemplateCommand)
  .addCommand(claimCommand)
  .addCommand(lintMdCommand);
