# VA Auto-Pilot Public Narrative Spec

This document is the canonical public-positioning source for README, website,
articles, protocol docs, package metadata, and release copy.

Use it before editing any public surface. If a public surface needs different
wording, keep the relationship and banned-expression rules intact.

## Canonical One-Liner

VA Auto-Pilot is a CLI-first autonomous engineering loop for turning goals,
constraints, and acceptance criteria into reviewed, tested, and recoverable
software delivery.

Chinese:

VA Auto-Pilot 是一个 CLI-first 自主工程闭环，把目标、约束和验收标准转成可审查、可测试、可恢复的软件交付过程。

## Core Positioning

VA Auto-Pilot is:

- a standalone Loop Engineering engine
- a Harness Engineering reliability layer around frontier coding agents
- a reference engine / managed-agent implementation for va-agent-protocol
- a project-local operating system for sprint state, gates, delegation,
  recovery, review, and evidence

VA Auto-Pilot is not:

- a prompt template library
- a model benchmark
- a vendor-specific Codex or Claude wrapper
- a replacement for MCP, A2A, or va-agent-protocol
- a guarantee that weak or poorly tooled models can execute long autonomous work

## Stack Relationship

Use this layer model when explaining relationships:

```text
Model / CLI agent
  -> Harness: tools, constraints, memory, review, gates, permissions
  -> Loop: state machine, planning, delegation, recovery, commits, next task
  -> Task protocol: va-agent-protocol contract for composable managed agents
  -> Connectors: MCP, A2A, local CLIs, CI, package managers, external tools
```

Canonical relationship wording:

> VA Auto-Pilot can run standalone. It can also operate as a reference engine
> for va-agent-protocol. The protocol is the task contract; Auto-Pilot is one
> execution engine that satisfies it.

Chinese:

> VA Auto-Pilot 可以独立运行，也可以作为 va-agent-protocol 的 reference
> engine。协议是任务契约，Auto-Pilot 是满足这个契约的一种执行引擎。

MCP/A2A wording:

> MCP and A2A are complementary connection layers. VA Auto-Pilot sits above
> connection and messaging: it governs how long-running engineering work is
> decomposed, executed, reviewed, recovered, and accepted.

Chinese:

> MCP 和 A2A 是互补的连接层。VA Auto-Pilot 位于连接和消息之上：它治理长链路工程任务如何被拆解、执行、审查、恢复和验收。

## Harness + Loop Definitions

Harness:

- defines the agent's operating environment
- injects constraints, skills, tools, memory, and project context
- turns subjective completion claims into deterministic evidence
- catches drift with review gates, acceptance tests, and pitfall memory

Loop:

- decides the next highest-leverage task
- manages sprint state and dependencies
- dispatches work to suitable CLI agents
- classifies failure and chooses recovery strategy
- commits verified work and continues to the next cycle

Short form:

> Harness makes each agent execution reliable. Loop turns many executions into
> sustained delivery.

Chinese:

> Harness 让每一次 Agent 执行可靠。Loop 把多次执行连成持续交付。

## Required Public Claims

Every primary public surface should make these claims clear:

1. Goal-first: users provide goals, constraints, acceptance, and boundaries.
2. CLI-first: evidence comes from executable commands, not self-report.
3. Human-on-the-loop: humans govern objective, risk, and stop conditions.
4. Failure compounding: failures become reusable pitfall memory.
5. Fresh review: completion needs review that is not trapped in the implementer's
   intent.
6. Agent-neutral: any capable CLI agent can participate if it can read context,
   run tools, and report evidence.

## Banned Or Risky Expressions

Avoid these in public-facing docs unless quoting historical material with
explicit context.

| Avoid | Use Instead | Why |
|---|---|---|
| Codex/Claude as co-creators | Built by Vadaski with assistance from frontier coding agents | Avoids vendor ownership confusion |
| Codex-only / Claude-only defaults | configured reviewer agent / capable CLI agent | Keeps agent-neutral positioning |
| VA Auto-Pilot vs MCP/A2A | VA Auto-Pilot complements MCP/A2A | Avoids false layer competition |
| MCP is sync / A2A is weak validation | MCP/A2A are connection and messaging layers | Avoids inaccurate protocol claims |
| weak model will fail | long autonomous loops require strong planning, tooling, and verification capability | Avoids unnecessary gatekeeping tone |
| protocol engineering as the core label | Harness + Loop Engineering | Aligns with current public language |
| prompt workflow as the main contrast | manual prompt/result/error/retry loop | More precise critique |
| superlatives like "two versions ahead" | early language for a now clearer category | More credible open-source tone |
| "Powered by va-agent-protocol" without clarification | standalone loop and va-agent-protocol reference engine | Avoids runtime dependency confusion |
| old template paths such as templates/scripts | package scripts/ copied by init; templates hold project templates | Matches current package architecture |

Chinese equivalents to avoid:

- "共创作者：Vadaski、Codex、Claude"
- "超越时代两个版本"
- "MCP/A2A 的竞争者"
- "弱模型会失败"
- "不是 prompt engineering，而是 protocol engineering" as the main thesis
- "基于 va-agent-protocol" without standalone clarification

## Preferred Replacement Copy

Credits:

> Created by Vadaski. Developed with assistance from frontier coding agents and
> validated through VA Auto-Pilot's own engineering loop.

Chinese:

> 由 Vadaski 创建，在前沿级编程 Agent 协助下开发，并通过 VA Auto-Pilot 自身工程闭环验证。

Model capability:

> VA Auto-Pilot is designed for capable coding agents with strong planning,
> tool-use, and verification behavior. Smaller models can still participate in
> bounded tracks, but the full autonomous loop assumes frontier-grade execution
> quality.

Chinese:

> VA Auto-Pilot 面向具备强规划、工具使用和验证能力的编程 Agent。较小模型可以参与边界清晰的子任务，但完整自治闭环默认需要前沿级执行质量。

Reopen article framing:

> The category language has caught up: what looked unusual before can now be
> described precisely as Harness + Loop Engineering.

Chinese:

> 行业语言追上来了：过去看起来不像传统工具的东西，现在可以被更准确地描述为 Harness + Loop Engineering。

## Acceptance Search Checks

Run these before closing any public narrative cleanup task:

```bash
rg -n "Co-creators|共创作者|超越时代两个版本|protocol engineering|weak model|弱模型|MCP .*A2A|vs MCP|vs A2A|Codex-only|Claude-only|Powered by va-agent-protocol" README.md README.zh.md website docs --glob '!docs/todo/**' --glob '!docs/operations/public-narrative-spec.md'
rg -n "Claude Opus|GPT-5|gpt-5\\.[0-9]|composer-2\\.5|templates/scripts|human-out-of-the-loop" README.md README.zh.md website docs --glob '!docs/todo/**' --glob '!docs/operations/public-narrative-spec.md'
rg -n "Codex|Claude" README.md README.zh.md website docs/operations docs/articles --glob '!docs/todo/**' --glob '!docs/operations/public-narrative-spec.md'
```

The last command is not a zero-match rule. Remaining vendor mentions must be one
of:

- install examples clearly labeled as one option among several
- historical source titles in references
- development collaborator acknowledgements that do not imply ownership,
  exclusivity, or runtime dependency

## Sustainable Decomposition Rule

For strategic reopen work, do not dispatch broad "clean all public docs" tasks.
Use this sequence:

1. define or update this narrative spec
2. clean README as the canonical reader path
3. mirror website from README
4. update long-form articles and protocol docs
5. run cross-surface consistency synthesis
6. add readiness checklist and roadmap tasks
7. rerun stale-expression checks and package validation

If a task touches more than one public surface, it must either produce a shared
spec or perform a consistency check. It should not be a broad rewrite.

## Initial Stale Surface Inventory

As of June 26, 2026, the known cleanup targets are:

- README / README.zh: model-capability wording, credits, and MCP/A2A layer
  framing.
- website: metadata, install tabs, demo copy, credits, and "Powered by"
  dependency wording.
- reopen article: title, vendor-name trend framing, and human-out-of-the-loop
  contrast.
- future article: "protocol engineering" thesis and model-capability wording.
- protocol/start prompts: default reviewer and manager examples should be
  configured-agent wording, with vendor-specific commands labeled as examples.
