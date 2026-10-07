import {
  getProtocolGuidance,
  PROTOCOL_CONTRACT_PHASES,
} from "./protocol-contract.js";
import type { ContributionRunPhase } from "../run/types.js";

const GUIDE_EXCLUDED_PHASES = new Set<ContributionRunPhase>([
  "INITIALIZED",
  "COMPLETED",
  "FAILED",
]);

export const PROTOCOL_DOC_START =
  "<!-- OPENCONTRIB:GENERATED protocol:start -->";
export const PROTOCOL_DOC_END = "<!-- OPENCONTRIB:GENERATED protocol:end -->";

export type ProtocolDocumentationLocale = "en" | "zh";

export interface WorkflowGuideOptions {
  targetRepo?: string;
  issueNumber?: string | number;
}

function formatIssueNumber(issueNumber: string | number | undefined): string {
  if (issueNumber === undefined || issueNumber === "") return "";
  const parsed = Number(issueNumber);
  return Number.isInteger(parsed) ? `, issueNumber: ${parsed}` : "";
}

function canonicalMcpPath(): string {
  const toolFor = (phase: ContributionRunPhase) =>
    PROTOCOL_CONTRACT_PHASES[phase].mcp.tool;
  return [
    toolFor("INITIALIZED"),
    `${toolFor("OPPORTUNITY_SCOUTED")} or ${toolFor("PROBE_COMPLETED")}`,
    toolFor("WORKSPACE_PREPARED"),
    toolFor("CONTEXT_ASSEMBLED"),
    `(optional ${toolFor("POC_GENERATED")})`,
    toolFor("RED_CAPTURED"),
    toolFor("PATCH_DRAFTED"),
    toolFor("EVIDENCE_COLLECTED"),
    "contrib_render_pr_template",
    toolFor("GOVERNANCE_AUDITED"),
    "contrib_request_approval",
    toolFor("PR_SUBMITTED"),
    toolFor("COMPLETED"),
  ].join(" → ");
}

function renderPhaseSteps(): string[] {
  return Object.values(PROTOCOL_CONTRACT_PHASES)
    .filter(({ phase }) => !GUIDE_EXCLUDED_PHASES.has(phase))
    .map((definition) => {
      const guidance = getProtocolGuidance(definition.phase);
      const allowedFrom = definition.allowedFromPhases.length
        ? definition.allowedFromPhases
            .map((phase) => `\`${phase}\``)
            .join(" or ")
        : "the run anchor";
      const forbidden = definition.forbiddenActions.length
        ? ` Forbidden: ${definition.forbiddenActions.join("; ")}`
        : "";
      const invariants = definition.invariants.length
        ? ` Invariants: ${definition.invariants.join(" ")}`
        : "";
      return `- **${definition.phase}: ${definition.name}** — call \`${definition.mcp.tool}\`; allowed from ${allowedFrom}; next canonical action is \`${guidance.mcpTool}\` (\`${guidance.suggestedNextAction}\`).${invariants}${forbidden}`;
    });
}

/** Render the runtime MCP workflow prompt from the canonical phase contract. */
export function renderWorkflowGuide(
  options: WorkflowGuideOptions = {},
): string {
  const targetRepo = options.targetRepo || "<target_owner/target_repo>";
  const issueNumber = formatIssueNumber(options.issueNumber);
  const initialized = PROTOCOL_CONTRACT_PHASES.INITIALIZED;

  return [
    "# OpenContrib Phase-Gated Contribution Protocol",
    "",
    "This guide is generated from `PROTOCOL_CONTRACT_PHASES`; the state machine is authoritative.",
    "The dependency graph below is not a mandatory linear checklist: optional branches are shown explicitly, and every transition must satisfy the listed allowed source phase.",
    "",
    "## Run anchor",
    "",
    `1. **${initialized.phase}: ${initialized.name} (MUST be first)** — call \`${initialized.mcp.tool}({ repoFullName: ${JSON.stringify(targetRepo)}${issueNumber} })\` to obtain \`runId\`. No discovery, probing, context assembly, workspace work, or source modification may begin before this run anchor exists.`,
    "",
    "## Canonical dependency path",
    "",
    `\`${canonicalMcpPath()}\``,
    "",
    "## Contract-derived phase graph",
    "",
    ...renderPhaseSteps(),
    "",
    "## Evidence and submission invariants",
    "",
    "- A PoC is optional. If used, generate it before `contrib_capture_red`; it never replaces the authoritative RED baseline.",
    "- Capture authoritative RED before drafting a patch, then draft the patch and run authoritative GREEN verification.",
    "- `contrib_capture_red` is mandatory before `contrib_save_artifact` advances to `PATCH_DRAFTED`, whether or not a PoC exists.",
    "- `contrib_verify_green` binds GREEN to RED and advances the evidence gate.",
    "- Before public submission, bind a provider-verified open `IssueBindingArtifact`; a private vulnerability policy instead requires a provider-verified `SecurityDisclosureArtifact` and public-fix authorization, with no public Issue route. For private work, use a non-public task identifier for workspace preparation.",
    "- Create `pr_draft` exactly once in `EVIDENCE_COLLECTED`; governance and later phases treat it as immutable.",
    "- Approval is an artifact-level gate. Request approval through OpenContrib, then submit only through `contrib_submit_pr` and the trusted `SubmissionPort`.",
    "- DO NOT call GitHub create_pull_request directly.",
    "- DO NOT call GitHub MCP or GitHub API create/update-pull-request operations directly. They bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.",
    "- Call `contrib_sync_flywheel` only after a verified submission; it creates the completion artifact as the final canonical step.",
  ].join("\n");
}

function docCommand(phase: ContributionRunPhase): string {
  const definition = PROTOCOL_CONTRACT_PHASES[phase];
  return `\`${definition.cli.example}\` / \`${definition.mcp.tool}\``;
}

/** Render the small protocol section embedded in agent-facing documentation. */
export function renderProtocolDocumentationBlock(
  locale: ProtocolDocumentationLocale = "en",
): string {
  const poc = PROTOCOL_CONTRACT_PHASES.POC_GENERATED;
  const red = PROTOCOL_CONTRACT_PHASES.RED_CAPTURED;
  const patch = PROTOCOL_CONTRACT_PHASES.PATCH_DRAFTED;
  const evidence = PROTOCOL_CONTRACT_PHASES.EVIDENCE_COLLECTED;
  const governance = PROTOCOL_CONTRACT_PHASES.GOVERNANCE_AUDITED;
  const prDraftGuidance = getProtocolGuidance("EVIDENCE_COLLECTED");
  const approvalGuidance = getProtocolGuidance("GOVERNANCE_AUDITED");
  const submission = PROTOCOL_CONTRACT_PHASES.PR_SUBMITTED;

  if (locale === "zh") {
    return [
      "## OpenContrib 权威协议（自动生成）",
      "",
      "- **生命周期顺序**：Run → 侦察/探测 → 工作区 → 上下文 → RED → 补丁 → GREEN → PR 草稿 → 治理 → 受信任审批 → 提交 → Flywheel。RunManager 的 canonical phase 是生命周期；Pipeline stage 只记录执行进度。",
      "- **覆盖率策略**：可信仓库策略指定 coverage.required 与 minimumChangedLineCoverage；GREEN 执行后读取新 LCOV 与修改的可执行源码行。缺失或无效报告标为 UNAVAILABLE，不能满足强制覆盖率策略；整项目汇总不能替代修改行覆盖率。没有已执行测试的结果会被 GREEN 和治理拒绝。",
      "- **安装与部署**：@opencontrib/mcp setup --all 配置 MCP 客户端；@opencontrib/cli setup 检查开发工具链。提供方写入凭据与审批密钥只能存于可信 broker；物理隔离依赖无宿主凭据及元数据权限的独立 worker。持有独立宿主 shell 权限的调用方仍可绕过进程内协议门禁。",
      `- **运行锚点（必须首先执行）**：${docCommand("INITIALIZED")}；没有 runId 不得侦察、准备工作区或修改源码。`,
      `- **工作区与证据**：${docCommand("WORKSPACE_PREPARED")}；PoC（${poc.mcp.tool}）是可选复现步骤，不能替代 ${red.mcp.tool} 的权威 RED。`,
      `- **RED → PATCH → GREEN**：必须先执行 ${red.mcp.tool}，再通过 ${patch.mcp.tool} 保存补丁，最后执行 ${evidence.mcp.tool} 验证 GREEN；没有 RED 不得进入 PATCH_DRAFTED。`,
      `- **路由与治理**：公开漏洞必须先绑定提供方校验的 IssueBindingArtifact；私有漏洞必须绑定提供方校验的 SecurityDisclosureArtifact 并获得公开修复授权，不能创建公开 Issue；准备私有漏洞工作区时使用非公开任务标识。`,
      `- **PR 草稿**：仍处于 ${evidence.phase} 时，通过 CLI ${prDraftGuidance.cliExample} 或 MCP ${prDraftGuidance.mcpTool} 首次创建并保存不可变的 pr_draft；私有安全路由不得包含公开 Issue 引用。随后执行 ${governance.cli.example} / ${governance.mcp.tool}，请求受信任审批（${approvalGuidance.cliExample} / ${approvalGuidance.mcpTool}），最终只通过 ${submission.mcp.tool} / SubmissionPort 提交。`,
      "- 禁止使用原始 GitHub CLI、GitHub MCP 或 GitHub API 写入 Pull Request；它们会绕过 SubmissionIntent、ApprovalArtifact、SubmissionPermit 与提供方校验。",
    ].join("\n");
  }

  return [
    "## Canonical OpenContrib Protocol (generated)",
    "",
    `- **Run anchor (first)**: ${docCommand("INITIALIZED")}; no scouting, workspace preparation, or source edits before a runId exists.`,
    `- **Workspace and evidence**: ${docCommand("WORKSPACE_PREPARED")}; PoC (${poc.mcp.tool}) is optional and never replaces authoritative RED via ${red.mcp.tool}.`,
    "- **Lifecycle order**: Run → scout/probe → workspace → context → RED → patch → GREEN → PR draft → governance → trusted approval → submission → flywheel. The canonical RunManager phase is the lifecycle; pipeline stage labels record execution progress only.",
    "- **Coverage policy**: the trusted repository sets coverage.required and minimumChangedLineCoverage. GREEN reads fresh LCOV changed executable source lines after execution; missing or unusable reports are UNAVAILABLE and block required coverage. Whole-project summaries do not satisfy changed-line coverage. Zero observed tests block GREEN and governance.",
    "- **Setup and deployment**: @opencontrib/mcp setup --all configures MCP clients; @opencontrib/cli setup checks the development toolchain. Provider-write credentials and approval keys belong only to the trusted broker. Physical isolation requires a separate worker with no host credentials or metadata access; unrestricted host shell access can bypass an in-process protocol gate.",
    `- **RED → PATCH → GREEN**: run ${red.mcp.tool} first, then save the patch through ${patch.mcp.tool}, and verify GREEN through ${evidence.mcp.tool}; PATCH_DRAFTED is invalid without RED.`,
    `- **Routing and governance**: public vulnerabilities require a provider-verified IssueBindingArtifact; private vulnerability policy requires a provider-verified SecurityDisclosureArtifact and public-fix authorization, with no public Issue route. Use a non-public task identifier when preparing a private-work workspace.`,
    `- **PR draft**: while still in ${evidence.phase}, create and persist immutable pr_draft with ${prDraftGuidance.cliExample} / ${prDraftGuidance.mcpTool}; private security drafts must omit public Issue references. Then run ${governance.cli.example} → ${approvalGuidance.cliExample} → opencontrib submission submit; MCP order is ${prDraftGuidance.mcpTool} → ${governance.mcp.tool} → ${approvalGuidance.mcpTool} → ${submission.mcp.tool} / SubmissionPort.`,
    "- Do not write Pull Requests through raw GitHub CLI, GitHub MCP, or GitHub API operations; they bypass SubmissionIntent, ApprovalArtifact, SubmissionPermit, and provider verification.",
  ].join("\n");
}

export function renderMarkedProtocolDocumentationBlock(
  locale: ProtocolDocumentationLocale = "en",
): string {
  return [
    PROTOCOL_DOC_START,
    renderProtocolDocumentationBlock(locale),
    PROTOCOL_DOC_END,
  ].join("\n");
}
