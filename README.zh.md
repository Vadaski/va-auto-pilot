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

如果要接入已有仓库，使用 `npx va-auto-pilot init .`。

---

## 它在 Agent Stack 里的位置

VA Auto-Pilot 不是另一个连接协议，也不是 MCP/A2A 的竞争者。它位于连接和消息之上，治理长链路工程任务如何被拆解、执行、审查、恢复和验收。

```text
Model / CLI Agent
  -> Harness：工具、约束、记忆、审查、门禁、权限
  -> Loop：状态机、计划、委派、恢复、提交、下一任务
  -> Task Protocol：va-agent-protocol 可组合任务契约
  -> Connectors：MCP、A2A、本地 CLI、CI、包管理器、外部工具
```

> **一句话** — MCP/A2A 解决如何连接；VA Auto-Pilot 解决连接之后如何可靠完成长任务。

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

- **证据门禁防止幻觉** — 模型不能自我认证。CLI 命令产生客观的通过/失败信号。"我觉得做完了"不等于"确实做完了"。
- **陷阱复利防止重蹈覆辙** — 过往运行中的结构化失败元数据作为硬约束注入后续委派。系统随时间越来越难被愚弄。
- **对抗性审查打破自我验证闭环** — 全新上下文的审查员只看 diff，不看意图。这在结构上防止了自治循环最常见的失败模式：对越来越错的输出越来越有信心。

> **一句话：** 信任模型的推理力，用确定性机制兜底盲区。

---

## 与 va-agent-protocol 的关系

VA Auto-Pilot 是一个**冲刺执行引擎**——它运行自治工程闭环。[va-agent-protocol](https://github.com/Vadaski/va-agent-protocol) 是**通用任务协议**——将任何 CLI Agent 包装成可组合单元的标准化契约。

VA Auto-Pilot 可以独立运行，也可以作为 va-agent-protocol 的 reference engine / managed agent。协议是任务契约，Auto-Pilot 是满足这个契约的一种执行引擎。

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

质量门禁通过确定性 CLI 命令执行。`npm run check:all` 只有两种结果：通过或不通过。模型无法宣称自己完成了，无法用言辞绕过去，无法自我认证质量。

这建立了一个客观的同步点，把"我认为做好了"和"确实做好了"分开。

### 3. 管理者委派，而不是实现

管理 Agent 的价值在于知道*什么*必须为真，而不是*怎么*把它变成真。实现总是委派给带完整上下文的子 Agent：目标、约束、硬限制和完成门禁。

### 4. 战略拆解先于战术执行

高层目标不由人工拆解成任务。框架运行一次并行维度扫描：每个子 Agent 独立审计问题的一个维度，各维度之间不交叉污染。

### 5. 对抗性冲刺收尾审查是一级门禁

每个冲刺结束时，都有一个全新上下文的对抗性审查员——他只看到了 diff，看不到意图。他的工作是找到冲刺团队视而不见的东西。

### 6. 失败知识会复利

陷阱指南记录结构化的失败元数据——不只是错误字符串，还有假设和缺失的上下文。未来的委派会把相关陷阱作为硬约束注入。系统随时间越来越难被愚弄。

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

初始化后先通过 agent-facing intent 通道捕获目标，再查看 cockpit 摘要：

```bash
node scripts/auto-pilot.mjs goal --text "把这个项目推进到可发布状态" --json
```

cockpit 是日常控制面：人类只需要判断目标是否仍然正确、风险是否可接受、验收证据是否可信。
sprint-state、run-journal、pitfall、quality gate 和 orchestration phase 都是 agent 的可审计内部机制。
journal 证据会先压缩成最近完成项、失败项、gate 和决策摘要，gate 可信度会压缩成证据风险信号，再呈现给人类。
过期 placeholder gate 由 agent 通过 `va-auto-pilot gates audit` 和 `va-auto-pilot gates maintain --apply` 维护。

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
- 将 `review-agent` 替换为你环境中配置的 reviewer 命令或包装器

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

# 高能力 CLI Agent 在内部运行治理闭环
$va-auto-pilot 在当前仓库执行一轮最高标准闭环；人类只判断目标、风险和证据

# Agent 集成示例：Claude Code command
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md \
  -o .claude/commands/va-auto-pilot.md
```

---

## 路线图

### v0.2

- 持久化 — SQLite 存储冲刺状态和陷阱
- 推送式异步 — 用事件驱动通知替代轮询
- Web 仪表盘 — 实时冲刺可视化

### v0.3

- REST / gRPC 适配器
- 治理 — 成本护栏 + 权限范围

### 未来

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
npm run validate:distribution
```

---

## 作者与致谢

由 **Vadaski** 创建，在前沿级编程 Agent 协助下开发，并通过 VA Auto-Pilot 自身工程闭环验证。

致谢：**Vera 项目**

## 许可证

MIT
