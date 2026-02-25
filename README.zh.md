# VA Auto-Pilot

[English README](./README.md)

## 这个框架在押什么赌注

大多数 Agent 框架是为弥补模型能力不足而设计的——把任务拆成细碎的步骤，精确规定模型该做什么，用强约束把能力弱的模型圈在可控范围内。

VA Auto-Pilot 押的是反向的赌注。

**这个框架生来就是为最强模型而建。** 它给出目标、约束和验收标准，然后把路径完全交给模型。没有要遵循的步骤清单，没有要扮演的角色列表，只有：这件事做完之后必须满足哪些条件。

如果你用的是能力较弱的模型，它会失败。不是框架有问题，是你用错了工具。这是有意为之的设计。一个要适配弱模型的框架，必须为弱点做设计。而这个框架为强度做设计。随着前沿模型越来越强，这个框架会变得越来越好，不需要任何改写。

这就是这个赌注。

---

## 核心设计贡献

### 1. 视角从约束与锚点中浮现，而不是从角色列表中分配

大多数多智能体审查框架预设了视角："安全审查员""QA 工程师""架构审查员"。问题在于，通用角色只能暴露通用失败模式，而真正的失败模式往往是这次具体变更特有的。

VA Auto-Pilot 采用不同的模型。在任何评审开始之前，管理 Agent 首先识别：
- **约束**：这次变更有哪些硬边界？
- **锚点**：变更之后，哪些不变量必须依然成立？

确定了真实的约束与锚点之后，问题就变成了：*针对这次特定变更，哪些专家视角能暴露最关键的失败模式？* 视角从分析中浮现——而不是从固定列表中指派。

这就是为什么审查会随时间变得更精准。模型会学会哪些视角对哪类变更最有价值。一个固定角色列表永远不会学到任何东西。

### 2. CLI 优先是正确性保证，而不是风格偏好

质量门禁通过确定性 CLI 命令执行。`npm run check:all` 只有两种结果：通过或不通过。模型无法宣称自己完成了，无法用言辞绕过去，无法自我认证质量。

这建立了一个客观的同步点，把"我认为做好了"和"确实做好了"分开。没有这个机制，自治循环会坍塌成自我验证——模型对越来越错的输出越来越有把握。

### 3. 管理者委派，而不是实现

管理 Agent 的价值在于知道*什么*必须为真，而不是*怎么*把它变成真。实现总是委派给带完整上下文的子 Agent：目标、约束、硬限制和完成门禁。子 Agent 决定路径。

这与强模型的实际工作方式一致。它们从目标出发推理得很好。从步骤清单出发推理则效果很差，因为步骤清单在替它们做判断。

### 4. 战略拆解先于战术执行

高层目标（"把这个做到商业质量"）不由人工拆解成任务。框架运行一次并行维度扫描：每个子 Agent 独立审计问题的一个维度，各维度之间不交叉污染。所有发现汇聚成一个有优先级的任务待办。

给出正确的框架时，模型在项目规划上比大多数人类做得更好。这个框架就是给它那个正确框架。

### 5. 对抗性冲刺收尾审查是一级门禁

每个冲刺结束时，都有一个全新上下文的对抗性审查员——他只看到了 diff，看不到意图是什么，也看不到过程中的讨论。他的工作是找到冲刺团队视而不见的东西。

这防止了自治循环中最常见的失败模式：自我验证偏差在冲刺间累积，直到一个重大回归悄悄通过。对抗性审查员在结构上无法被好意所蒙蔽。

### 6. 失败知识会复利

陷阱指南记录结构化的失败元数据——不只是错误字符串，还有假设和缺失的上下文。未来的委派会把相关陷阱作为硬约束注入进去。系统随时间越来越难被愚弄。每一次失败都让后续委派更加精准。

---

## 什么时候用 VA Auto-Pilot

**适合使用的场景：**
- 你有前沿级别的模型（Claude Opus 4.6 或 gpt-5.3-codex 级别，或同等能力）
- 你的目标足够复杂，人类也需要先拆解才能执行
- 你需要有保证的质量门禁，而不是尽力而为的审查
- 你希望有一个随模型进步而变强的执行闭环

**不适合使用的场景：**
- 你用的是中等或较弱的模型——框架不会替你补能力，任务会失败或产出质量低下
- 你想控制每一个实现步骤——如果你需要规定怎么做，用别的工具
- 你的任务小而明确——一个写得好的单条提示词更快、更合适
- 你希望流程轻量——这个框架有协议开销，价值在于保证质量，而不是快

---

## 你会得到什么

- 可复用 CLI 脚手架：`va-auto-pilot`
- 机器可读状态源：`.va-auto-pilot/sprint-state.json`
- 可读看板投影：`docs/todo/sprint.md`
- 人类控制面：`docs/todo/human-board.md`
- 追加式运行记忆：`docs/todo/run-journal.md`
- 协议文档与启动提示
- 验收流执行器：`scripts/test-runner.ts`

---

## 快速开始

```bash
# 本地
node ./bin/va-auto-pilot.mjs init .

# 从 GitHub 引导（不依赖 npm registry）
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

使用这个框架的正确方式是给它一个目标，而不是一个计划。模型自己想出计划。

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

注意缺失了什么：没有要修改哪些文件，没有要遵循的步骤顺序，没有规定的实现方式。模型决定路径，你定义终局和约束。这是全部的契约。

---

## 并发推进模型

- 每轮先选一个主任务，同时可并发启动 0 到多个独立轨道。
- 强制门禁是并发轨道的同步屏障。
- 未通过门禁不得推进状态。
- 并发策略由管理 Agent 在实时上下文中决策。
- 默认路径是模型原生并发工具调用。

并发规划命令：

```bash
node scripts/sprint-board.mjs plan --json --max-parallel 3 > .va-auto-pilot/parallel-plan.json
# 由管理 Agent 使用原生并发工具调用执行各轨道
# 状态推进前在门禁处同步
npm run check:all && codex review --uncommitted && npm run validate:distribution
```

实验性辅助器（仅在明确需要时启用）：

```bash
node scripts/va-parallel-runner.mjs spawn --plan-file .va-auto-pilot/parallel-plan.json --agent-cmd "codex exec --task {taskId}"
```

---

## 分发安装

Codex 安装：

```text
$skill-installer install https://github.com/Vadaski/va-auto-pilot/tree/main/skills/va-auto-pilot
```

说明：仓库当前未发布 npm 包，安装必须走 GitHub 源码路径。

若环境不支持 `skill-installer`，可用源码回退安装：

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
# VA Auto-Pilot 运行时依赖
npm install yaml
rm -rf "$tmp"
```

Claude Code 安装：

```bash
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md -o .claude/commands/va-auto-pilot.md
```

---

## 文档索引

- 协议：`docs/operations/va-auto-pilot-protocol.md`
- 启动提示：`docs/operations/start-va-auto-pilot-prompt.md`
- 分发说明：`docs/operations/distribute-skill.md`
- 理念文章：`docs/human-on-the-loop.md`
- Ralph 对比：`docs/comparisons/va-auto-pilot-vs-ralph.zh.md`

---

## 官网

`website/` 为独立静态站点，包含：

- 中英切换
- 交互式状态机
- 动画执行演示
- SEO 与 OG 元信息

本地预览：

```bash
cd website
python3 -m http.server 4173
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
