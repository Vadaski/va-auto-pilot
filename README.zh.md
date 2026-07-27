# VA Auto-Pilot

[![CI](https://github.com/Vadaski/va-auto-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Vadaski/va-auto-pilot/actions)
[![npm](https://img.shields.io/npm/v/va-auto-pilot)](https://www.npmjs.com/package/va-auto-pilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Vadaski/va-auto-pilot?style=social)](https://github.com/Vadaski/va-auto-pilot)

**CLI 优先的自治多智能体工程闭环——给出目标，模型自己找路径。**

[English README](./README.md)

```
┌──────────────────────────────────────────────────────┐
│                    管理 Agent                         │
│  目标 → 约束 → 锚点 → 视角                            │
├──────────┬──────────┬──────────┬─────────────────────┤
│ 工人 A   │ 工人 B   │ 工人 C   │  ...并行轨道         │
│ (实现)   │ (实现)   │ (审查)   │                     │
├──────────┴──────────┴──────────┴─────────────────────┤
│         CLI 质量门禁（确定性）                          │
│  typecheck · lint · test · review · acceptance        │
├──────────────────────────────────────────────────────┤
│        陷阱指南（失败知识会复利）                        │
└──────────────────────────────────────────────────────┘
```

### 立即体验

```bash
npx va-auto-pilot init ./auto-pilot-demo --demo
cd ./auto-pilot-demo
npm install
npm run check:demo
```

如果要接入已有仓库，使用 `npx va-auto-pilot init .`。正式派发任务前，请配置你要使用的 CLI Agent：默认模板现在是一个厂商中立的占位符，会明确报错退出；需通过 `--agent-template` 或 worker 覆盖来指定实际 Agent。

---

## 这个框架在押什么赌注

大多数 Agent 框架会降低自治度：把任务拆成细碎步骤，精确规定模型该做什么，让 Agent 贴着人类维护的脚本走。

VA Auto-Pilot 押的是反向的赌注。

**这个框架生来就是为强编程 Agent 而建。** 它给出目标、约束和验收标准，然后把路径交给 Agent。没有要遵循的步骤清单，没有要扮演的角色列表，只有：这件事做完之后必须满足哪些条件。

长链路自治闭环需要强规划、强工具使用和稳定验证能力。较小模型仍然可以参与边界清晰的子任务，但完整闭环默认需要前沿级执行质量。

这就是这个赌注。

---

## 为什么前沿模型需要这个

2026 前沿级编程模型带来了非凡能力：自主多步推理、大上下文窗口、原生工具调用。VA Auto-Pilot 旨在**放大这些优势**并**防御残余弱点**。

### 放大优势

- **目标驱动委派** — 管理者给出目标、约束和验收标准，不做微管理。模型的推理能力被充分释放。
- **并行自主轨道** — 前沿模型原生处理复杂的并行工具编排。框架顺势而为，而不是把一切串行化。
- **长上下文感知** — 冲刺状态、陷阱指南、运行日志天然适配能在上下文中容纳整个项目的模型。

### 防御弱点

- **证据门禁防止幻觉** — CLI 命令产生客观的通过/失败信号，模型无法靠辩解绕开。"我觉得做完了"不等于"确实做完了"。门禁能拦截明显的占位符作弊并强制可观测证据，但它不能密码学级别地证明一条测试命令本身是有意义的。
- **陷阱复利防止重蹈覆辙** — 未解决失败会注入相关委派；由已解决 pitfall 自动合成的规则先进入 probation，避免一次带噪 resolution 静默升级成永久硬约束。
- **对抗性审查打破自我验证闭环** — 全新上下文的审查员只看 diff，不看意图。这在结构上防止了自治循环最常见的失败模式：对越来越错的输出越来越有信心。

> **一句话：** 信任模型的推理力，用确定性机制兜底盲区。

---

## 与 va-agent-protocol 的关系

VA Auto-Pilot 是一个**冲刺执行引擎**——它运行自治工程闭环。[va-agent-protocol](https://github.com/Vadaski/va-agent-protocol) 是**通用任务协议**——将任何 CLI Agent 包装成可组合单元的标准化契约。

VA Auto-Pilot 可以独立运行，也可以作为 va-agent-protocol 的 reference engine / managed agent。协议是任务契约，Auto-Pilot 是满足这个契约的一种执行引擎。

`scripts/lib/colony-bridge.mjs` 中的事件驱动 Colony 派发器可选地使用 `va-agent-protocol`，解析顺序为：`VA_AGENT_PROTOCOL_PATH` 环境变量 → 已安装的 `va-agent-protocol` npm 包 → 本地兄弟仓库。legacy/直接 Colony surface 保留智能路由；当前 orchestrated `await-workers` 为获得真实 PID/token 的 READY→persist→GO、worker 自持 deadline 与无重复恢复，强制使用 crash-safe spawn lifecycle，不会静默走 Colony 路由。

长运行的 `run.json` 与 `tracks.json` 通过持久、带哈希校验的事务意图联合发布。当 run 已持久进入 `done` 后，`recover --apply` 会立即、幂等地完成 claim release、checkpoint/review 清理和 active-run 移除，无需等待 lease TTL；`halted`、`error` 或仍有真实/新鲜 worker 证据时不会走这条捷径。控制文件损坏、GO 后 PID 尚未落盘的模糊窗口都会 fail closed。进程树控制覆盖 launcher/worker PGID 与 Windows 子进程树；但恶意命令仍可主动创建新的 POSIX session（`setsid`/detached daemon）逃逸这一 best-effort 边界，因此 worker 命令不得 daemonize。

MCP 和 A2A 是互补的连接层。VA Auto-Pilot 位于连接和消息之上：它治理长链路工程任务如何被拆解、执行、审查、恢复和验收。

## Harness + Loop Engineering

用现在行业里的语言说，VA Auto-Pilot 是一个以 **Loop Engineering** 为骨架、以 **Harness Engineering** 为可靠性层的系统。

- **Harness**：围绕模型的约束、Skill、CLI 工具、质量门禁、对抗审查、陷阱记忆和确定性反馈。
- **Loop**：冲刺状态、manager/worker 分派、计划审查、并行轨道、恢复策略、自动提交和下一轮选择。

Loop 负责让工作持续推进；Harness 负责防止这种推进把错误自动放大。

---

## 核心设计贡献

### 1. 视角从约束与锚点中浮现，而不是从角色列表中分配

大多数多智能体审查框架预设了视角："安全审查员""QA 工程师""架构审查员"。问题在于，通用角色只能暴露通用失败模式，而真正的失败模式往往是这次具体变更特有的。

VA Auto-Pilot 采用不同的模型。在任何评审开始之前，管理 Agent 首先识别：
- **约束**：这次变更有哪些硬边界？
- **锚点**：变更之后，哪些不变量必须依然成立？

确定了真实的约束与锚点之后，问题就变成了：*针对这次特定变更，哪些专家视角能暴露最关键的失败模式？* 视角从分析中浮现——而不是从固定列表中指派。

### 2. CLI 优先是正确性保证，而不是风格偏好

质量门禁通过确定性 CLI 命令执行。`npm run check:all` 只有两种结果：通过或不通过。模型无法宣称自己完成了，也无法用辩解绕过一个失败的门禁。

这建立了一个客观的同步点，把"我认为做好了"和"确实做好了"分开。门禁本身仍可能被足够"配合"的 Agent 绕过，因此框架还会通过陷阱复利和对抗性审查来提高作弊成本。

### 3. 管理者委派，而不是实现

管理 Agent 的价值在于知道*什么*必须为真，而不是*怎么*把它变成真。实现总是委派给带完整上下文的子 Agent：目标、约束、硬限制和完成门禁。

### 4. 战略拆解先于战术执行

高层目标不由人工拆解成任务。框架运行一次并行维度扫描：每个子 Agent 独立审计问题的一个维度，各维度之间不交叉污染。

### 5. 对抗性冲刺收尾审查是一级门禁

每个冲刺结束时，都有一个全新上下文的对抗性审查员——他只看到了 diff，看不到意图。他的工作是找到冲刺团队视而不见的东西。

### 6. 失败知识会复利

陷阱指南记录结构化的失败元数据——不只是错误字符串，还有假设和缺失的上下文。相关的未解决 pitfall 会成为硬约束；从已解决 pitfall 学到的规则先进入 probation，只有携带证据显式提升后才会生效。活跃学习规则会按配置的半衰期降低置信度：有效反馈刷新寿命，无效反馈将其退役；当两条相关规则原本都可注入时，显式声明的冲突会同时隔离双方。系统复利的是经过治理的知识，而不是把每次历史失败都永久堆进 prompt。

### 7. 工具会报告自己的问题

pitfall 复利的是*项目自身*的失败；meta-problem 闭环的是*工具自身*的失败。当 gate 无法表达项目的技术栈、orchestration 状态机行为异常、或协议文本误导 agent 时，agent 会把一条结构化的 meta-problem（分类、严重度、期望 vs 实际、命令/退出码/输出证据）记录到项目本地的 `.va-auto-pilot/meta-problems.json`——协议要求必须在当轮 cycle 结束前完成记录。记录永不离开项目磁盘。在采用了 auto-pilot 的项目上运行 `va-auto-pilot meta report --project <path>`，会以 stdout-only 方式输出未解决 meta-problem 的聚类报告，并映射到本仓库候选模块，让真实世界的摩擦流回 backlog，而不是随冲刺结束蒸发。

---

## 什么时候用 VA Auto-Pilot

**适合使用的场景：**
- 你有前沿级别的编程模型能力
- 你的目标足够复杂，人类也需要先拆解才能执行
- 你需要有保证的质量门禁，而不是尽力而为的审查
- 你希望有一个随模型进步而变强的执行闭环

**不适合使用的场景：**
- 你无法提供具备强规划、工具使用和验证行为的 Agent
- 你想控制每一个实现步骤
- 你的任务小而明确——一个写得好的单条提示词更快
- 你希望流程轻量——这个框架有协议开销，价值在于保证质量

---

## 快速开始

```bash
# 全局安装
npm i -g va-auto-pilot

# 或直接用 npx
npx va-auto-pilot init .
```

从 GitHub 引导（不依赖 npm）：

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
rm -rf "$tmp"
```

体验默认人类工作流：

```bash
va-auto-pilot init ./auto-pilot-demo --demo
cd ./auto-pilot-demo
va-auto-pilot goal --text "把这个项目推进到可发布状态"
va-auto-pilot plan-from-goal --json
va-auto-pilot plan-from-goal --apply --json
va-auto-pilot cockpit
```

要真正派发任务，需要配置一个 CLI Agent。示例：

```bash
# Claude Code
va-auto-pilot run . --agent-template 'claude -p --output-format text "Implement task {taskId} in this project"'

# Codex CLI
va-auto-pilot run . --agent-template 'codex exec --full-auto -C . "Implement task {taskId}"'

# Kimi CLI
va-auto-pilot run . --agent-template 'kimi -w . --quiet -p "Implement task {taskId}"'
```

cockpit 是日常控制面：人类只需要判断目标是否仍然正确、风险是否可接受、验收证据是否可信。
sprint-state、run-journal、pitfall、quality gate 和 orchestration phase 都是 agent 的可审计内部机制。
对于当前 run，cockpit 会先校验任务 evidence manifest、artifact 大小与哈希身份、event log 绑定、必需 gate 结果，以及存在时声明的 review 计数，再呈现结构化 proof。只有没有 bundle 时，journal 摘要才作为回退上下文；gate 可信度会压缩成证据风险信号。
过期 placeholder gate 由 agent 通过 `va-auto-pilot gates audit` 和 `va-auto-pilot gates maintain --apply` 维护。
显式目标路径是 `goal -> plan-from-goal -> candidate backlog -> orchestrate plan -> review-plan`；`orchestrate plan` 也会自动消费未处理的 objective intent。

显式编排模式把“审批”当作真正的完整性边界：计划审查必须以明确的
`PLAN REVIEW STATUS: PASS|FAIL` 作为最后一个非空行（如有发现，结构化输出放在它之前），任何审查豁免都必须说明理由；提交审批会绑定任务、允许提交的文件集
（或隔离 worktree commit）、证据引用和当前集成分支 `HEAD`。任一上下文发生变化，运行会退回
审批阶段，而不是提交过期或无关改动。run/task ID 只能使用路径安全的标识符；human-board
和状态的并发更新采用加锁原子写；`init`/`upgrade` 会拒绝指向符号链接的脚手架目标。

默认 cockpit 输出从人类需要做的决策开始：

```text
Goal Cockpit
Objective: 把这个项目推进到可发布状态 (human goal; needs-human-intent-processing)
Progress: NEEDS MANAGER ACTION - New human intent must be incorporated before worker dispatch. (dispatch blocked)
Risk: MEDIUM - NO_ACTIVE_RUN: No active orchestration run exists.
Evidence trust: TRUSTED - Required evidence gates are configured and no evidence risk signals are active.
Evidence: collecting
  Gate trust: configured
  Recent completions: none
  Recent failures: none
  Known unresolved problems: none
  Recovery: recoverable
  Approval freshness: current
  Commit readiness: not-ready - No completed worker results are waiting to commit.
Approval: No human approval needed now. Manager action required: New human intent must be incorporated before worker dispatch.
Manager next:
1. Generate candidate backlog: node scripts/auto-pilot.mjs plan-from-goal --json - Turn unchecked goal intent into an explicit candidate backlog.
2. Apply candidate backlog: node scripts/auto-pilot.mjs plan-from-goal --apply --json - Persist candidate backlog items into sprint state and mark intent handled.
```

需要机器可读审计面或可执行 `nextCommands` 时，使用 `va-auto-pilot cockpit --json`。

---

## Managed DocStore

VA Auto-Pilot 可以通过 `ManagedDocStore` 管理设计、决策和流程文档。仓库存在 `.docstore/*` 时，托管文档必须通过 DocStore CLI 或 SDK 写入，不要手改 `.docstore/INDEX.json` 或托管路径。

### 初始化 / 修复

```bash
node ./scripts/doc-store-cli.mjs init
node ./scripts/doc-store-cli.mjs init --force --mode=mixed --managed-roots=.docstore/designs,.docstore/decisions,.docstore/process
```

- `init` 可重复运行；健康状态下会转为 `doctor`。
- 修改 `mode` 或 `managedRoots` 时使用 `--force`，保留已有 journal、archive 和 extension 状态。
- 如果 `doctor` 报 pending journal recovery 或 config/index drift，通过 `init` 或 ManagedDocStore API 修复。

### 纳管旧文档

```bash
node ./scripts/doc-store-cli.mjs adopt docs/designs/doc-store-api-draft.md --kind=design --title="DocStore API Draft"
```

`adopt` 会把已有文件迁入 `.docstore/`，在 git worktree 中优先使用 `git mv` 保留历史。

### 安装 hook

```bash
node ./scripts/doc-store-cli.mjs install-hook
node ./scripts/doc-store-cli.mjs uninstall-hook
```

`install-hook` 幂等；如已有 `.git/hooks/pre-commit`，DocStore 会保存并串联执行。

### 模式

- `legacy` — 兼容模式，不强制托管路径。
- `mixed` — 仅配置的 `.docstore/*` roots 强制通过 DocStore 写入。
- `managed` — 配置的托管 roots 全严格；除非 staged `INDEX.json` 与 artifact 变更匹配，否则拒绝手改。

当前仓库使用 `mixed` 模式，托管 `.docstore/designs`、`.docstore/decisions` 和 `.docstore/process`。

---

## 目标优先委派

使用这个框架的正确方式是给它一个目标，而不是一个计划。

```text
$va-auto-pilot

目标：
上线 onboarding v2，显著提升激活率。

约束：
- 不改变既有架构边界
- 不引入安全回归
- 关键链路延迟维持在 300ms 内

验收：
- typecheck/lint/test 全通过
- 配置的 review gate 无阻断问题
- 验收流 MUST 100%，SHOULD >= 80%
```

没有要修改哪些文件，没有要遵循的步骤顺序，没有规定的实现方式。你定义终局和约束，这是全部的契约。

---

## 并发模型

- 每轮先选一个主任务，同时可并发启动 0 到多个独立轨道
- 强制门禁是并发轨道的同步屏障
- 未通过门禁不得推进状态
- 默认路径是模型原生并发工具调用
- 将 `review-agent` 替换为你环境中配置的 reviewer 命令或包装器（下方示例仅为占位符）

人类通常通过 `cockpit --json` 看摘要；下面的 planner / board 命令是 manager agent 的内部调试面：

```bash
node scripts/sprint-board.mjs plan --json --max-parallel 3 > .va-auto-pilot/parallel-plan.json
npm run check:all && review-agent review --uncommitted && npm run validate:distribution
```

---

## 分发安装

```bash
# npm
npm i -g va-auto-pilot

# 通用 CLI Agent 路径
npx va-auto-pilot init .
npm install

# 然后捕获目标并查看人类控制面
node scripts/auto-pilot.mjs goal --text "发布一个可靠版本" --json

# 高能力 CLI Agent 在内部运行治理闭环。
# 下面这行是粘贴给 Agent 的自然语言提示，不是 shell 命令：
# $va-auto-pilot 在当前仓库执行一轮最高标准闭环；人类只判断目标、风险和证据

# Agent 集成示例：Claude Code command
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md \
  -o .claude/commands/va-auto-pilot.md
```

---

## 路线图

### v0.3

- 持久化 — SQLite 存储冲刺状态和陷阱
- 推送式异步 — 用事件驱动通知替代轮询
- Web 仪表盘 — 实时冲刺可视化

### 未来

- REST / gRPC 适配器
- 多语言 SDK（Python、Go）
- 分布式编排

下一代 Harness + Loop 路线图：
`docs/operations/next-gen-harness-loop-roadmap.md`

---

## 文档索引

- 重新开源：`docs/articles/reopen-va-auto-pilot-harness-loop.zh.md`
- 理念文章：`docs/articles/va-auto-pilot-why-this-is-the-future.zh.md`
- 协议：`docs/operations/va-auto-pilot-protocol.md`
- 公共叙事规范：`docs/operations/public-narrative-spec.md`
- 开源准备清单：`docs/operations/open-source-readiness-checklist.md`
- 故障注入耐久测试：`docs/operations/fault-injection-soak.md`
- 下一代路线图：`docs/operations/next-gen-harness-loop-roadmap.md`
- 启动提示：`docs/operations/start-va-auto-pilot-prompt.md`
- 分发说明：`docs/operations/distribute-skill.md`
- 理念文章：`docs/human-on-the-loop.md`
- Ralph 对比：`docs/comparisons/va-auto-pilot-vs-ralph.zh.md`

---

## 官网

`website/` 为独立静态站点，包含中英切换、交互式状态机、动画执行演示、SEO 与 OG 元信息。

```bash
cd website && python3 -m http.server 4173
```

---

## 校验命令

```bash
npm run check:all
npm run check:fault-injection
npm run validate:distribution
```

---

## 作者与致谢

由 **Vadaski** 创建，在前沿级编程 Agent 协助下开发，并在 VA Auto-Pilot 自身工程闭环中持续吃狗粮验证。

致谢：**Vera 项目**

## 许可证

MIT
