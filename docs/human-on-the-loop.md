# human on the loop

## 摘要

我们做的不是“让 Agent 帮人写点代码”，而是把软件工程流程本身变成一个可执行系统：
人类只给终极目标与边界条件，frontier model 负责路径规划、执行、复盘和持续推进。

`human on the loop` 的核心不是“不要人类”，而是“人类不再给 how，只给 what + constraints + acceptance”。
它明确依赖前沿级编程模型能力。

---

## 1. 问题定义：为什么传统 AI 协作会卡住

大多数 AI 开发协作卡在三个地方：

1. 人类仍在逐步指挥，模型只能当高级 IDE。
2. 缺少状态机，任务切换靠记忆，系统不可恢复。
3. 缺少强制验收，产出变成“看起来完成”。

结果是：效率提升有限，且质量不稳定。

---

## 2. 设计原则：把工程流程变成“闭环机器”

我们抽象出五条可泛化原则：

1. 目标驱动，不给步骤
人类只定义目标、优先级、约束、验收标准。

2. Agent 是管理者，不是码农
Agent 优先通过 CLI 委派、执行、验收，而不是手工逐行操作。

3. 状态机先于聪明
所有行动必须可落在状态机上：`Backlog -> In Progress -> Review -> Testing -> Done`。

4. 质量门禁不可绕过
任何任务都必须经过 `实现 -> review -> 验收 -> 提交`。

5. 能力门槛必须前置声明
该闭环不是“普适降级”系统。低于前沿级编程模型能力时，不承诺稳定质量。

---

## 3. 系统架构：七个模块

### 3.1 Cockpit + Intent（人类判断入口）

人类控制面不应该要求用户理解状态文件、日志、pitfall 或 phase。
默认入口是：

- `cockpit`：把内部状态压缩成目标、风险、证据三个判断问题
- `intent`：把人类的目标、约束、风险、验收和 override 写入系统

`docs/todo/human-board.md` 仍然存在，但它是 agent 管理的内部意图投影，而不是最终用户每天手改的工作面。
这让人类从“实时遥控”变成“高带宽异步控制”。

### 3.2 Sprint Board（状态机）

`sprint.md` 是唯一任务真源。
每次循环先读板，再决策，不允许脱离看板执行。

### 3.3 Delegation Contract（委派协议）

每次委派只给：

- 任务目标
- 相关上下文
- 不可违背约束
- 完成标准

明确禁止给 step-by-step，最大化 frontier model 的自主规划能力。

### 3.4 Multi-Perspective Review（多视角审查）

不是固定角色列表，而是“约束驱动”的视角生成：

1. 先提取当前变更的真实约束与锚点
2. 再生成最小必要审查视角（例如安全、性能、领域正确性等）
3. 在收尾阶段追加 fresh-context adversarial reviewer（仅看 diff）

只有通过结构化审查，任务才允许进入 Testing；对抗审查发现 CRITICAL 时必须回流 Backlog。

### 3.5 Acceptance Runner（验收执行器）

YAML 测试流 + CLI runner。

验收规则：

- MUST = 100%
- SHOULD >= 80%

把“感觉可用”变成“机器可判定可用”。

### 3.6 Stop Conditions（停机条件）

自动化不是蛮干。满足以下任一必须停机：

- 同一任务连续失败 3 次
- 需要外部资源权限
- 需要高影响架构决策
- 需要破坏性操作

### 3.7 Structured Sprint State（结构化状态源）

新增 `.va-auto-pilot/sprint-state.json` + `scripts/sprint-board.mjs`：

- `sprint-state.json`：机器可读状态真源（便于自动选择下一步）
- `sprint.md`：从状态源渲染的可读投影（不手工改表格）
- `run-journal.md`：append-only 的执行记忆与可复用信号

这样可以把“看板读取、状态推进、复盘记忆”都变成可命令化动作，减少 Markdown 手工同步误差。

### 3.8 Model Capability Baseline（模型能力基线）

这套方法论默认运行在前沿级编程模型能力区间。

原因不是“品牌偏好”，而是任务形态决定：

1. 需要从目标+约束直接规划执行路径（而不是跟随细粒度步骤）
2. 需要并发轨道协同与跨上下文一致性
3. 需要在自审与对抗审查中维持稳定推理质量

低能力模型可完成局部任务，但难以稳定完成“长链路自治 + 质量门禁 + 自我纠错”的完整闭环。

---

## 4. 为什么强调 CLI-first

很多系统失败在“Agent 太会写，太不会管”。

我们要求 Agent 优先做四件事：

1. 调命令
2. 读输出
3. 做判断
4. 更新状态

也就是：把 Agent 从“执行者”升级为“工程经理”。

CLI-first 的收益：

- 可审计：每一步有命令和输出
- 可复现：同命令可在 CI / 本地复跑
- 可扩展：可以接入任意工具链
- 可治理：能明确失败点和责任边界

---

## 5. Skill 设计：不是 Prompt 技巧，而是协议工程

我们把 Skill 视为“可移植流程模块”，而不是文本片段。

一个可复用 Skill 至少包含：

1. 模式识别：setup / start
2. 资产模板：board、protocol、runner、flows
3. 决策循环：失败恢复与优先级策略
4. 门禁定义：build/review/test
5. 停机规则：何时等待人类

换句话说，Skill 的本质是“把工程组织经验编码成执行协议”。

---

## 6. 从理念到落地：`/va-auto-pilot` 开源仓库结构

```text
va-auto-pilot/
├── bin/va-auto-pilot.mjs                # CLI：注入模板到任意项目
├── skills/va-auto-pilot/                # 可分发 skill（多 Agent 集成示例）
├── templates/
│   ├── .va-auto-pilot/config.yaml       # 参数化配置
│   ├── docs/todo/sprint.md
│   ├── docs/todo/human-board.md        # internal intent projection
│   ├── docs/operations/va-auto-pilot-protocol.md
│   ├── scripts/test-runner.ts
│   └── test-flows/feature-smoke.yaml
├── website/                           # 项目门面（GitHub Pages）
├── docs/human-on-the-loop.md
└── README.md
```

初始化后，任何项目都能快速获得完整闭环骨架。

---

## 7. 可泛化策略：如何避免“只能在一个项目里好用”

为了可开源复用，我们做了三件事：

1. 参数化
命令、任务前缀、领域角色、API 端点都走配置，不写死。

2. 解耦业务语义
保留流程结构，去掉私有 Prompt、隐私策略、业务字段。

3. 把“约束”前置
先定义不可做什么，再给模型自由度。

这能在不同技术栈、不同产品域下保持一致的方法论。

---

## 8. 风险与边界

`human on the loop` 不是“无监督自治”。

必须持续保留三层边界：

1. 安全边界：权限最小化、敏感操作显式确认
2. 质量边界：三重门禁不可跳过
3. 治理边界：停机条件触发后必须回到人类决策
4. 模型边界：低于能力基线时不承诺闭环质量，必须降级为人工主导模式

只有在边界清晰时，自治才可持续。

---

## 9. 结论

frontier model 的真正价值，不在“写得更快”，而在“能不能在约束下持续逼近最终目标”。

`human on the loop` 是一种工程组织方式：

- 人类定义终局
- Agent 自主推进
- 系统保证质量

当流程本身可执行、可验证、可恢复时，Agent 才不是插件，而是生产系统的一部分。

在前沿级编程模型上，这种闭环已经从“实验性玩法”进入“可工程化复用”的阶段；这正是它面向未来的根本原因。

---

## 10. 新补充：分发能力也必须被协议化

仅有“能跑起来”的工程协议还不够，开源项目还需要“能被别人快速装起来”。  
因此本仓库新增了分发门禁：

1. 独立官网（`website/`）作为统一入口，解释价值与安装路径。
2. Skill 分发目录（`skills/va-auto-pilot/`）可直接分享给 Agent。
3. GitHub Pages 自动发布，保证入口长期可访问。

这意味着 `done` 不再只是代码通过测试，而是用户从发现项目到安装调用的整条链路都可用。
