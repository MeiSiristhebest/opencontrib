---
name: open-source-contributor
description: |
  Universal Agent-Native Open Source Contributor protocol powered by OpenContrib Engine and GitHub MCP.
  Fuses phase-gated engineering governance, empirical evidence verification, and MCP engine automation.
---

# OpenContrib — 智能体开源贡献协议标准 (GitHub MCP + OpenContrib 双核驱动)

> **核心哲学**：大模型生成代码容易，但让开源社区 Maintainer 欣然合并极难。
> 平台通信与网络 I/O 交给 **GitHub MCP**，领域算法、隔离沙箱与质量门禁交给 **OpenContrib MCP**。

---

## 🚨 五大铁律 (Five Immutable Governance Rules)

1. **仓库固有规范优先 (Repo Convention Override)**：优先遵循目标仓库的 commit 风格、原生 PR 模板与 DCO 签名要求。
2. **人机协作硬门禁 (Human-in-the-Loop Pre-Flight Gate)**：在调用 GitHub MCP 创建任何 Issue 或 PR 之前，**必须先将拟提交的完整标题与正文草案呈现给用户确认，未获明确指令前绝不可直接推送**！
3. **自然工程师口吻 (Humanized Engineering Tone)**：严禁任何机械化模板标题（如“Google Standard”等标签），使用最自然、地道、清晰的资深工程师口吻书写，杜绝任何 AI Smell。
4. **真实物证链标准 (Empirical Evidence Chain)**：严禁无证据裸提交。必须包含基线测试对比、20 次压力测试循环与资源句柄物证。
5. **100 行 RFC 防卫门禁 (RFC 100-Line Gate)**：变更预估 > 100 行或涉及公开架构变动，强制阻断并转为提交 RFC Issue 讨论。

---

## 🧩 双核 MCP 工具协同流水线 (Dual MCP Pipeline)

| 阶段 | 平台 I/O (调用 GitHub MCP) | 算法与门禁 (调用 OpenContrib MCP) |
| :--- | :--- | :--- |
| **Phase 0: 发现与资格判定** | `search_issues`<br>`get_issue_comments` | `contrib_create_run` (创建 Contribution Run 会话)<br>`contrib_scout` (多生态 Issue 探测)<br>`contrib_rank_opportunity` (多维概率特征信号)<br>`contrib_assess_feasibility` (本地 OS / 环境可行性评估)<br>`contrib_qualify_issue` (7天作者优先权 / 反跟风门禁) |
| **Phase 0 (主动探针模式)** | `get_file_contents` (读取 workflows / manifest) | `contrib_diagnose_manifests` (生成 <=100 行安全与工作流补丁建议) |
| **Phase 1: 仓库深度 Onboard** | `get_file_contents` (读取 CONTRIBUTING.md) | `contrib_assemble_context` (构建探索指引与目标测试)<br>`contrib_prepare_workspace` (创建 ~/.opencontrib/workspaces 隔离沙箱并捕获 baselineCommitSha) |
| **Phase 2: 方案设计 & RFC** | - | `contrib_audit_governance` (<=100 行 Diff 预算检查) |
| **Phase 3: 代码实现** | - | 4-Layer 防御模型实现，消除任何 AI 机器人口吻；`contrib_save_artifact` 实时持久化 |
| **Phase 4: 测试与物证链** | - | `contrib_collect_evidence` (Pre-Fix 失败断言 + Post-Fix 20次连续压测 + 真实 Baseline 差分测试计数) |
| **Phase 5: 子代理审查与门禁** | - | `contrib_audit_governance` (7 维数学置信度 $\ge 90\% \land \text{弱项} \ge 80\%$) |
| **Phase 6 & 7: PR 提交与飞轮**| `fork_repository`<br>`push_files`<br>`create_pull_request` | `contrib_render_pr_template` (渲染六厂融合 PR 模板)<br>`contrib_track_pr_status` (跟踪 PR 状态与 CI 反馈)<br>`contrib_sync_flywheel` (同步记忆库与 Profile Markdown) |
| **零 Token 资源注入** | - | `opencontrib://doctor` (环境诊断)<br>`opencontrib://memory` (仓库记忆与避坑指南)<br>`opencontrib://runs` (Run 历史审计) |
| **智能体工作流 Prompt** | - | `opencontrib_workflow_guide` (9-Step Phase-Gated 标准执行协议) |

---

## 🚦 7 阶段执行准则

1. **Contribution Delta 基准**：所有测试增量与文件变更基于 Run 初始化时的 `baseCommitSha`，杜绝混入历史提交。
2. **Step 4.0 单测基线隔离**：改代码前在 `main` 跑 3~5 遍测试，记录固有 Flaky 用例，避免误报。
3. **7 维置信度数学公式**：
   $$\text{Overall Confidence} = 0.25(\text{RC}) + 0.25(\text{Impl}) + 0.20(\text{Reg}) + 0.10(\text{Def}) + 0.10(\text{Test}) + 0.05(\text{Style}) + 0.05(\text{Sec})$$
4. **完成合并后**：调用 `contrib_sync_flywheel` 更新本地经验记忆库与 GitHub Profile README 贡献徽章。

