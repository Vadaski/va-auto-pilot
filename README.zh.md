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
│  typecheck · lint · test · codex-review · acceptance  │
├──────────────────────────────────────────────────────┤
│        陷阱指南（失败知识会复利）                        │
└──────────────────────────────────────────────────────┘
```

### 立即体验

```bash
npx va-auto-pilot init .
```

---

## 协议对比

VA Auto-Pilot 与 MCP 和 A2A 的关系是**互补**，而非竞争：

| 维度 | MCP (Anthropic) | A2A (Google) | VA Auto-Pilot |
|------|----------------|-------------|---------------|
| **定位** | 工具级上下文 | Agent 发现 + 协调 | 长任务执行 + 证据验证 |
| **任务类型** | 短同步工具调用 | 发现 + 路由 | 长任务 + 自动拓扑 + 调度器 |
| **时间模型** | 同步 | 异步 (push) | 异步 (polling; v0.2 push) |
| **验证机制** | 返回值 = 结果 | 弱 | CLI 门禁 + 模型评估 + 陷阱 |
| **编排** | 无 | 基础路由 | 拓扑排序 + 能力匹配 + 并发控制 |
| **失败学习** | 无 | 无 | 陷阱复利 |
| **互操作** | — | MCP 兼容 | 与 MCP/A2A 互补 |

> **一句话** — MCP 把模型连接到工具。A2A 把 Agent 连接到 Agent。VA Auto-Pilot 确保事情真正做对。

---

## 这个框架在押什么赌注

大多数 Agent 框架是为弥补模型能力不足而设计的——把任务拆成细碎的步骤，精确规定模型该做什么，用强约束把能力弱的模型圈在可控范围内。

VA Auto-Pilot 押的是反向的赌注。

**这个框架生来就是为最强模型而建。** 它给出目标、约束和验收标准，然后把路径完全交给模型。没有要遵循的步骤清单，没有要扮演的角色列表，只有：这件事做完之后必须满足哪些条件。

如果你用的是能力较弱的模型，它会失败。不是框架有问题，是你用错了工具。这是有意为之的设计。一个要适配弱模型的框架，必须为弱点做设计。而这个框架为强度做设计。随着前沿模型越来越强，这个框架会变得越来越好，不需要任何改写。

这就是这个赌注。

---

## 为什么前沿模型需要这个

2026 前沿模型（Claude Opus 4.6、GPT-5.3-codex 或同等级）带来了非凡能力：自主多步推理、百万 token 上下文窗口、原生工具调用。VA Auto-Pilot 旨在**放大这些优势**并**防御残余弱点**。

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

VA Auto-Pilot 是一个**冲刺执行框架**——它运行自治工程闭环。[va-agent-protocol](https://github.com/Vadaski/va-agent-protocol) 是**通用任务协议**——将任何 CLI Agent（包括 VA Auto-Pilot）包装成可组合单元的标准化契约。

VA Auto-Pilot 是为 va-agent-protocol 构建的第一个适配器。你可以独立使用 Auto-Pilot，也可以在协议编排器内将它作为被管理的 Agent。

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
- 你有前沿级别的模型（Claude Opus 4.6 或 GPT-5.3-codex 级别，或同等能力）
- 你的目标足够复杂，人类也需要先拆解才能执行
- 你需要有保证的质量门禁，而不是尽力而为的审查
- 你希望有一个随模型进步而变强的执行闭环

**不适合使用的场景：**
- 你用的是中等或较弱的模型——框架不会替你补能力
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

初始化后渲染看板：

```bash
node scripts/sprint-board.mjs render
```

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
- codex review 无阻断问题
- 验收流 MUST 100%，SHOULD >= 80%
```

没有要修改哪些文件，没有要遵循的步骤顺序，没有规定的实现方式。你定义终局和约束，这是全部的契约。

---

## 并发模型

- 每轮先选一个主任务，同时可并发启动 0 到多个独立轨道
- 强制门禁是并发轨道的同步屏障
- 未通过门禁不得推进状态
- 默认路径是模型原生并发工具调用

```bash
node scripts/sprint-board.mjs plan --json --max-parallel 3 > .va-auto-pilot/parallel-plan.json
npm run check:all && codex review --uncommitted && npm run validate:distribution
```

---

## 分发安装

```bash
# npm
npm i -g va-auto-pilot

# Claude Code
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

---

## 文档索引

- 重新开源：`docs/articles/reopen-va-auto-pilot-harness-loop.zh.md`
- 理念文章：`docs/articles/va-auto-pilot-why-this-is-the-future.zh.md`
- 协议：`docs/operations/va-auto-pilot-protocol.md`
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

- 共创作者：**Vadaski**、**Codex**、**Claude**
- 致谢：**Vera 项目**

## 许可证

MIT
