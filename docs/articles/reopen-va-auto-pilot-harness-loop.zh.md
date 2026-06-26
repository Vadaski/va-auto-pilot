# 是时候重新开源 VA Auto-Pilot 了

四个月前，我开源过一次 VA Auto-Pilot。

很快我又把它闭源了。

原因不复杂：当时大家还不太知道这是什么。它看起来不像一个普通的 AI coding tool，也不像一个 prompt 模板库，更不像一个传统 agent framework。它有 sprint state，有 human board，有 quality gates，有 pitfall guide，有 manager / worker / reviewer，有自动循环，有失败复利。

很多人会问：这到底是工具，还是流程？是脚手架，还是 agent？是 CI，还是项目管理？

现在回头看，这些问题本身并没有错。只是当时行业还没有给这类东西一个共同语言。

最近，两个词开始变热：**Harness Engineering** 和 **Loop Engineering**。

我觉得，VA Auto-Pilot 是时候再次放出来了。

---

## 1. 从 Prompt 到 Harness

过去两年，很多人把 AI 工程的重点放在 prompt 上。

这很自然。早期模型能力有限，你必须把话说清楚，把上下文塞进去，把步骤拆细，把输出格式规定好。Prompt engineering 是那个阶段最直接的杠杆。

但 coding agent 变强之后，问题发生了变化。

真正决定 agent 能不能干活的，已经不只是那一条 prompt，而是模型周围的整个环境：

- 它能读什么？
- 它能调用什么工具？
- 它怎么知道项目约束？
- 它怎么验证自己做对了？
- 它失败之后，失败知识会不会留下？
- 它能不能被另一个干净上下文的 agent 审查？
- 它能不能在进入人类视野之前自我修正？

这就是 Harness Engineering 的核心。

一个 agent 不只是 model。更准确地说：

> Agent = Model + Harness

模型提供智能，harness 提供边界、工具、反馈、记忆和验证。

没有 harness，强模型也会变成一个会写很多代码但不一定知道自己错在哪里的黑箱。有了 harness，模型的能力才会被稳定地导向工程结果。

VA Auto-Pilot 从一开始就在做这件事。

它有 CLI-first 的质量门禁。模型不能说“我觉得好了”，它必须通过 typecheck、lint、test、review、acceptance。

它有 constraints。每次委派不是只给任务，还给硬边界。

它有 pitfall guide。失败不是一次性日志，而是会被结构化沉淀，变成下一次委派的约束。

它有 adversarial sprint review。最后审查者只看 diff，不看意图，防止团队在同一个错误叙事里互相增强信心。

这些都属于 harness。

但 VA Auto-Pilot 不止是 harness。

---

## 2. 从 Harness 到 Loop

Harness 解决的是：单个 agent 如何在一个可靠环境里工作。

Loop 解决的是另一个问题：谁来持续驱动 agent 工作？

过去，人类自己就是 loop。

我们写一个 prompt，等 agent 改代码。跑测试，失败了，把错误贴回去。它再改，我们再看。它漏了需求，我们提醒。它忘了上下文，我们补。它说完成了，我们检查。它没完成，我们继续推。

表面上是 agent 在工作，实际上是人在维持循环。

Loop Engineering 的转变，是把这个循环工程化。

一个真正的 loop 会自己做这些事：

1. 发现当前最高优先级任务。
2. 读取项目状态和约束。
3. 分派 worker agent。
4. 等待执行结果。
5. 跑确定性质量门禁。
6. 触发 reviewer。
7. 失败时分类、恢复、重试或升级。
8. 成功时提交。
9. 记录经验。
10. 进入下一轮。

这不是“写一个更长的 prompt”。这是把提示、执行、验证、记忆、恢复、继续，做成一个控制系统。

VA Auto-Pilot 的主体正是这个 loop。

它不是一个让你手动调用的 agent。它是一个 autonomous multi-agent engineering loop。

给它目标、约束和验收标准，它自己规划路径、分派任务、运行门禁、处理失败、推进状态。

---

## 3. 为什么四个月前大家不理解

四个月前，把 VA Auto-Pilot 直接开源出去，其实有点早。

当时大家还在讨论：

- 哪个模型写代码更强？
- prompt 应该怎么写？
- agent 要不要多角色？
- 上下文怎么塞？
- 是否应该让 AI 直接改文件？

这些问题都重要，但它们还停留在“如何使用 agent”的层面。

VA Auto-Pilot 问的是另一个问题：

> 如果未来大部分代码都由 agent 写，人类工程师真正应该设计什么？

我的答案是：

人类不应该只设计 prompt。人类应该设计目标、约束、反馈、状态机、验证系统和失败复利机制。

也就是：设计 loop，设计 harness。

当时这个说法听起来可能太抽象。现在，行业开始自己走到这里了。

OpenAI 在讲 harness engineering。Anthropic / Claude Code 圈子在讲 loop。Addy Osmani 在讲 designing systems that prompt agents。LangChain 在讲同一个模型只改 harness，benchmark 表现大幅提升。

这些讨论把语言补上了。

VA Auto-Pilot 终于可以被更准确地理解了。

---

## 4. VA Auto-Pilot 到底是什么

如果用今天的语言描述：

> VA Auto-Pilot 是一个以 Loop Engineering 为骨架、以 Harness Engineering 为可靠性层的 CLI-first autonomous engineering framework。

它的核心不是“让 AI 帮你写代码”。

这个说法太小了。

它真正做的是：

> 把软件工程从人工推动的 prompt workflow，转成由状态机、质量门禁、多 agent 分工和失败知识驱动的自治交付循环。

这里有几个设计判断。

### 4.1 Manager 不实现

Manager 的价值不是亲自写代码，而是理解目标、约束、锚点和验收条件，然后把任务交给 worker。

这接近真实工程组织：优秀 manager 不应该抢每一个 implementation detail，而应该保证方向、边界、质量和节奏。

VA Auto-Pilot 明确要求 manager 负责治理，而不是进入代码细节里替 worker 完成实现。

### 4.2 模型不能自证完成

AI 最危险的地方不是它会失败，而是它会很有信心地宣称失败的东西已经完成。

所以 VA Auto-Pilot 强制使用 CLI gates。测试就是测试，lint 就是 lint，review finding 就是 finding。语言不能覆盖证据。

这也是 CLI-first 的真正含义。

CLI-first 不是命令行情怀，而是正确性机制。它把“看起来完成”变成“机器可判定完成”。

### 4.3 失败必须复利

很多 agent 系统最大的问题是反复犯同一个错。

今天踩坑，明天忘记。

这不是因为模型笨，而是因为系统没有记忆。

VA Auto-Pilot 把 failure pattern 记录成 pitfall，再把 pitfall 注入后续委派。

失败不是浪费，失败是训练 harness。

### 4.4 审查必须隔离意图

实现者知道自己想做什么，所以很容易看见自己希望看见的东西。

冲刺结束时，fresh-context reviewer 只看 diff，不看过程、不看解释、不看自我辩护。

这是为了打破自治系统里最常见的坏循环：错误越跑越自洽。

### 4.5 人类在 Loop 之上，而不是 Loop 之中

VA Auto-Pilot 不是 human-out-of-the-loop。

它更接近 human-on-the-loop。

人类不消失。人类定义目标、边界、验收、优先级和停止条件。只是人类不再手动维持每一次 prompt / result / error / retry。

系统跑循环，人类治理循环。

---

## 5. Harness 和 Loop 在 VA Auto-Pilot 里的对应关系

如果把 VA Auto-Pilot 拆开看，它正好落在这两个概念的交叉点。

### 5.1 Harness 层

Harness 层负责让 agent 在一个可靠环境里做事：

- `.va-auto-pilot/constraints/`：项目约束库
- `.va-auto-pilot/quality-gates.yaml`：质量门禁配置
- `docs/todo/run-journal.md`：运行日志
- pitfall guide：失败知识沉淀
- review parser：把审查发现转成可执行阻断
- fresh-context adversarial review：隔离意图的收尾审查
- CLI gates：typecheck、lint、test、distribution validation

这些机制共同回答一个问题：

> Agent 做事时，什么是边界，什么是证据，什么是不能绕过的验证？

### 5.2 Loop 层

Loop 层负责让系统持续推进：

- `auto-pilot-loop.mjs`：自动循环入口
- `sprint-board.mjs plan`：任务选择与并行计划
- `orchestrate dispatch`：分派 worker
- `orchestrate await-workers`：等待并汇总结果
- `approve-plan` / `approve-commit`：人类治理点
- failure classification：失败分类
- recovery strategy：重试、修复、升级、创建 fix task
- stop conditions：空 backlog、连续失败、human board 阻塞

这些机制共同回答另一个问题：

> 谁来驱动下一步，什么时候继续，什么时候停止，失败后如何恢复？

### 5.3 二者的关系

Harness 是可靠性基础。Loop 是自治控制流。

没有 harness，loop 会把错误自动放大。没有 loop，harness 只是静态规则，无法形成持续交付能力。

VA Auto-Pilot 的设计点就在这里：

> 用 harness 约束每一次 agent 执行，用 loop 把多次执行连成可恢复、可验证、可复利的工程系统。

---

## 6. 为什么现在重新开源

因为现在大家终于开始讨论正确的问题了。

不是“怎么写一个神奇 prompt”。而是“怎么设计 agent 能可靠工作的环境”。

不是“怎么让 AI 回答我”。而是“怎么让 AI 在我不逐轮推动的情况下持续交付”。

不是“AI 能不能写代码”。而是“当 AI 写大量代码时，工程系统如何保持质量、方向和可维护性”。

VA Auto-Pilot 正好在这个交叉点上。

它不是为了证明某个模型很强。它默认强模型会越来越强。

它关心的是：模型越强以后，我们需要什么样的工程结构来承接这种能力。

我相信未来的软件工程会越来越像这样：

1. 人类定义目标和约束。
2. Agent 执行、验证、修复和提交。
3. 系统记录失败并改进下一轮。
4. 工程师主要设计 harness 和 loop，而不是手动维持每一次交互。

VA Auto-Pilot 是我对这个未来的一个具体实现。

四个月前，它可能显得太早。

现在，它刚好到了可以被理解的时候。

所以我准备重新开源它。

不是因为它已经完成。

而是因为这个方向已经开始变成共识，而一个真正有用的工程 loop，应该在真实使用、真实失败、真实反馈里继续长出来。

---

## 7. 重新开源之后，我希望大家看见什么

我不希望大家只把 VA Auto-Pilot 看成一个“自动跑任务”的 CLI。

更值得看的，是它背后的几个问题：

1. 当模型足够强时，工程师应该把控制权放在哪里？
2. 什么样的验证信号足够硬，能压住 agent 的自我确认偏差？
3. 长任务系统如何跨会话保存状态？
4. 多 agent 系统如何避免互相放大错误？
5. 失败经验如何从日志变成下一次执行的硬约束？
6. 人类如何从 loop 里的手动操作者，变成 loop 之上的治理者？

这些问题比单个工具更重要。

VA Auto-Pilot 是一个答案，但不是最终答案。

我重新开源它，是希望这个答案进入真实世界，接受真实使用的摩擦。

如果它错了，错误会暴露出来。

如果它对了，失败会复利，协议会进化，loop 会变得越来越稳。

这正是这个项目自己的信念：

> Trust the model's reasoning power; use deterministic mechanisms to catch its blind spots.

信任模型的推理力，用确定性机制兜底盲区。

---

## 8. 相关语境

- [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/)
- [Harness engineering for coding agent users](https://martinfowler.com/articles/harness-engineering.html)
- [Loop Engineering](https://addyosmani.com/blog/loop-engineering/)
- [Improving Deep Agents with harness engineering](https://www.langchain.com/blog/improving-deep-agents-with-harness-engineering)
- [human on the loop](../human-on-the-loop.md)
- [VA Auto-Pilot：为什么这是面向 Opus 4.6 / gpt-5.3-codex 时代的工程未来](./va-auto-pilot-why-this-is-the-future.zh.md)
