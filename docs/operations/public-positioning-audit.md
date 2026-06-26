# Public Positioning Audit

Date: 2026-06-26

This audit verifies that the public VA Auto-Pilot surfaces now describe the
project as Harness + Loop Engineering without vendor lock-in, protocol-layer
confusion, or stale reopen-era language.

## Surfaces Reviewed

- `README.md`
- `README.zh.md`
- `website/app.js`
- `website/index.html`
- `docs/articles/reopen-va-auto-pilot-harness-loop.zh.md`
- `docs/articles/va-auto-pilot-why-this-is-the-future.zh.md`
- `docs/human-on-the-loop.md`
- `docs/operations/va-auto-pilot-protocol.md`
- `docs/operations/start-va-auto-pilot-prompt.md`
- `docs/operations/quality-gate-examples.md`
- `docs/agent-usage.md`

## Consistency Verdict

The public surfaces are aligned enough for reopen preparation.

The canonical message is now:

> VA Auto-Pilot is a CLI-first autonomous engineering loop and Harness
> Engineering reliability layer for capable coding agents. It can run
> standalone, and it can also act as a reference engine for va-agent-protocol.

Chinese:

> VA Auto-Pilot 是 CLI-first 自主工程闭环，也是面向高能力编程 Agent 的
> Harness Engineering 可靠性层。它可以独立运行，也可以作为
> va-agent-protocol 的 reference engine。

## Alignment Checks

### Harness + Loop

README, website, and reopen articles now use Harness + Loop Engineering as the
primary category. The protocol docs preserve operational detail but do not use
older category labels as the public thesis.

### Standalone vs va-agent-protocol

README and website both say Auto-Pilot can run standalone and can also operate
as a va-agent-protocol reference engine. This avoids implying a hard runtime
dependency while still preserving the protocol relationship.

### MCP / A2A Layering

Public copy now frames MCP and A2A as complementary connection and messaging
layers. Auto-Pilot is described as the layer governing long-running execution,
state transition, review, recovery, and acceptance.

### Agent Neutrality

Primary positioning no longer presents Auto-Pilot as a Codex-only or
Claude-only wrapper. Remaining vendor mentions are installation examples,
distribution examples, or historical references.

### Review Gate Wording

Public command examples use `review-agent` as an environment-specific reviewer
placeholder, with explicit instructions to replace it with the configured local
review command.

### Human Role

The human role is consistently "on the loop": humans govern objective, risk,
boundaries, and stop conditions. The system is not presented as unsupervised
autonomy.

## Reopen Readiness Rules

Before any public release announcement, run:

```bash
npm run check:all
rg -n "Co-creators|共创作者|超越时代两个版本|protocol engineering|weak model|弱模型|vs MCP|vs A2A|MCP \\(Anthropic\\)|A2A \\(Google\\)|返回值 = 结果|验证机制.*弱|Codex-only|Claude-only|Powered by va-agent-protocol|Claude Opus|GPT-5|gpt-5\\.[0-9]|composer-2\\.5|templates/scripts|human-out-of-the-loop|codex review|Codex & Claude|Built by Vadaski|default: Codex|<review-agent>" README.md README.zh.md website docs --glob '!docs/todo/**' --glob '!docs/operations/public-narrative-spec.md' --glob '!docs/operations/public-positioning-audit.md'
```

The second command should return no matches.

Then manually inspect any remaining `Codex` or `Claude` mentions:

```bash
rg -n "Codex|Claude" README.md README.zh.md website docs/operations docs/articles --glob '!docs/todo/**' --glob '!docs/operations/public-narrative-spec.md'
```

Allowed remaining mentions:

- clearly labeled install examples
- clearly labeled invocation examples
- historical article references
- acknowledgements that do not imply ownership, exclusivity, or runtime
  dependency

## Remaining Risk

The main remaining risk is not wording drift; it is overpromising autonomous
execution without enough context about model capability, quality gates, and
human stop conditions. Keep those three qualifiers near any strong claim about
"goal in, delivery out".
