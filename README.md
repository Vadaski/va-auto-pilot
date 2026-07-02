# VA Auto-Pilot

[![CI](https://github.com/Vadaski/va-auto-pilot/actions/workflows/ci.yml/badge.svg)](https://github.com/Vadaski/va-auto-pilot/actions)
[![npm](https://img.shields.io/npm/v/va-auto-pilot)](https://www.npmjs.com/package/va-auto-pilot)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/Vadaski/va-auto-pilot?style=social)](https://github.com/Vadaski/va-auto-pilot)

**CLI-first autonomous multi-agent engineering loop — set a goal, the model finds the path.**

[中文文档](./README.zh.md)

```
┌──────────────────────────────────────────────────────┐
│                    Manager Agent                     │
│  Objective → Constraints → Anchors → Perspectives    │
├──────────┬──────────┬──────────┬─────────────────────┤
│ Worker A │ Worker B │ Worker C │  ...parallel tracks  │
│ (impl)   │ (impl)   │ (review) │                     │
├──────────┴──────────┴──────────┴─────────────────────┤
│          CLI Quality Gates (deterministic)            │
│  typecheck · lint · test · review · acceptance        │
├──────────────────────────────────────────────────────┤
│         Pitfall Guide (failure knowledge compounds)   │
└──────────────────────────────────────────────────────┘
```

### Try it now

```bash
npx va-auto-pilot init ./auto-pilot-demo --demo
cd ./auto-pilot-demo
npm install
npm run check:demo
```

Use `npx va-auto-pilot init .` when adding the loop to an existing repository.

Before dispatching tasks, configure the CLI agent you want to use. The default template is a vendor-neutral placeholder that exits with a clear error; set `--agent-template` or worker overrides so tasks can actually run.

---

## The Design Bet

Most agent frameworks are built to reduce autonomy: they break tasks into small steps, prescribe exactly what the model should do, and keep the agent close to a human-maintained script.

VA Auto-Pilot makes the opposite bet.

**This framework is built for capable coding agents, by design.** It sets a goal, states constraints, and specifies acceptance criteria — then lets the agent find the path. There are no step-by-step instructions to follow. There is no role list to pick from. There is only: here is what must be true when you are done.

Long autonomous loops require strong planning, tool-use, and verification behavior. Smaller models can still participate in bounded tracks, but the full loop assumes frontier-grade execution quality.

That is the bet.

---

## Why Frontier Models Need This

2026 frontier coding models bring extraordinary capabilities: autonomous multi-step reasoning, large context windows, and native tool calling. VA Auto-Pilot is designed to **amplify these strengths** and **guard against remaining weaknesses**.

### Amplifying strengths

- **Objective-driven delegation** — The manager gives goals, constraints, and acceptance criteria. No micromanagement. The model's reasoning ability is fully unleashed.
- **Parallel autonomous tracks** — Frontier models handle complex parallel tool orchestration natively. The framework leans into this instead of serializing everything.
- **Long-context awareness** — Sprint state, pitfall guides, and run journals are designed for models that can hold an entire project in context.

### Guarding against weaknesses

- **Evidence gates prevent hallucination** — CLI commands produce objective pass/fail signals that the model cannot argue around. "I think it's done" is not the same as "it is done." The gates catch obvious placeholder cheating and force observable evidence; they do not cryptographically prove that a test is meaningful.
- **Pitfall compounding prevents repeated mistakes** — Structured failure metadata from past runs is injected into future delegations as hard constraints. The system gets harder to fool over time.
- **Adversarial review breaks self-validation loops** — A fresh-context reviewer sees only the diff, never the intent. This structurally prevents the most common autonomous loop failure: growing confidence in growing errors.

> **One sentence:** Trust the model's reasoning power; use deterministic mechanisms to catch its blind spots.

---

## Relationship to va-agent-protocol

VA Auto-Pilot is a **sprint execution engine** — it runs the autonomous engineering loop. [va-agent-protocol](https://github.com/Vadaski/va-agent-protocol) is the **universal task protocol** — the standardized contract that wraps any CLI agent into a composable unit.

VA Auto-Pilot can run standalone. It can also operate as a reference engine / managed agent for va-agent-protocol. The protocol is the task contract; Auto-Pilot is one execution engine that satisfies it.

The event-driven Colony dispatcher in `scripts/lib/colony-bridge.mjs` can use `va-agent-protocol` when it is resolvable from a local sibling checkout (`../../../va-agent-protocol/dist/index.js`). If the protocol is not present, Auto-Pilot falls back to raw agent spawn, so external users still get a working loop without needing the monorepo layout.

MCP and A2A are complementary connection layers. VA Auto-Pilot sits above connection and messaging: it governs how long-running engineering work is decomposed, executed, reviewed, recovered, and accepted.

## Harness + Loop Engineering

In current industry language, VA Auto-Pilot is a **Loop Engineering** system built on a **Harness Engineering** reliability layer.

- **Harness**: constraints, skills, CLI tools, quality gates, adversarial review, pitfall memory, and deterministic feedback around the model.
- **Loop**: sprint state, manager/worker dispatch, plan review, parallel tracks, recovery strategy, auto-commit, and next-cycle selection.

The loop keeps work moving. The harness prevents that motion from amplifying mistakes.

---

## Core Intellectual Contributions

### 1. Perspectives emerge from constraints and anchors — never from role lists

Most multi-agent review frameworks prescribe perspectives: "security reviewer," "QA engineer," "architecture reviewer." The problem is that generic roles expose generic failure modes. Real failure modes are specific to the change.

VA Auto-Pilot uses a different model. Before any review, the manager identifies:
- **Constraints**: what hard boundaries govern this change?
- **Anchors**: what invariants must hold after this change?

Given those real constraints and anchors, the question becomes: *which expert views would expose the most critical failure modes for this specific change?* The perspectives emerge from the analysis — they are never assigned from a fixed list.

### 2. CLI-first is a correctness guarantee, not a style preference

Quality gates run via deterministic CLI commands. `npm run check:all` either passes or it does not. The model cannot declare success or argue its way through a failing gate.

This creates an objective synchronization point that separates "I think it's done" from "it is done." The gate itself can still be gamed by a sufficiently cooperative agent, so the framework also compounds pitfalls and runs adversarial review to raise the cost of cheating.

### 3. The manager delegates — it never implements

The manager agent's value is knowing *what* needs to be true, not *how* to make it true. Implementation is always delegated to sub-agents with full context: objective, constraints, hard limits, and completion gate.

### 4. Strategic decomposition before tactical execution

High-level goals are not decomposed by a human into tasks. The framework runs a parallel dimension scan: each sub-agent audits one axis of the problem independently, with no cross-contamination between dimensions.

### 5. Adversarial post-sprint review as a first-class gate

Every sprint ends with a fresh-context adversarial reviewer who has seen only the diff — not what was intended, not what was discussed. Their job is to find what the sprint team was blind to.

### 6. Failure knowledge compounds

The pitfall guide captures structured failure metadata — not just error strings, but hypotheses and missing context. Future delegations inject relevant pitfalls as hard constraints. The system gets harder to fool over time.

---

## When to Use VA Auto-Pilot

**Use it when:**
- You have access to frontier coding model capability
- Your goal is complex enough that a human would need to decompose it before executing
- You need guaranteed quality gates, not best-effort review
- You want an execution loop that gets better as models improve

**Do not use it when:**
- You cannot provide an agent with strong planning, tool-use, and verification behavior
- You want to control every implementation step
- Your task is small and bounded — a single well-written prompt is faster
- You want minimal ceremony — this framework has protocol; the value is in the guarantees

---

## Quick Start

```bash
# Install globally
npm i -g va-auto-pilot

# Or run directly with npx
npx va-auto-pilot init .
```

Bootstrap from GitHub (no npm dependency):

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
rm -rf "$tmp"
```

Try the default human workflow:

```bash
va-auto-pilot init ./auto-pilot-demo --demo
cd ./auto-pilot-demo
va-auto-pilot goal --text "Ship this project to a releasable state"
va-auto-pilot plan-from-goal --json
va-auto-pilot plan-from-goal --apply --json
va-auto-pilot cockpit
```

To actually dispatch tasks, configure an agent. Examples:

```bash
# Claude Code
va-auto-pilot run . --agent-template 'claude -p --output-format text "Implement task {taskId} in this project"'

# Codex CLI
va-auto-pilot run . --agent-template 'codex exec --full-auto -C . "Implement task {taskId}"'

# Kimi CLI
va-auto-pilot run . --agent-template 'kimi -w . --quiet -p "Implement task {taskId}"'
```

The cockpit is the daily control surface. It keeps human attention on whether
the goal is still right, whether risk is acceptable, and whether the evidence is
trustworthy. Sprint state, run journals, pitfalls, quality gates, and
orchestration phases remain auditable internals for the agent. Journal evidence
is summarized into recent completions, failures, gates, and decisions before it
is shown to humans, with gate trust compressed into evidence-risk signals.
Agents can maintain stale placeholder gates with `va-auto-pilot gates audit` and
`va-auto-pilot gates maintain --apply`. The explicit goal path is
`goal -> plan-from-goal -> candidate backlog -> orchestrate plan -> review-plan`;
`orchestrate plan` also consumes unchecked objective intent automatically.

Default cockpit output starts with the decisions a human needs:

```text
Goal Cockpit
Objective: Ship this project to a releasable state (human goal; needs-human-intent-processing)
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

Use `va-auto-pilot cockpit --json` when a manager agent or debugger needs the
machine-readable audit surface and executable `nextCommands`.

---

## Managed DocStore

VA Auto-Pilot can manage design, decision, and process documents through `ManagedDocStore`. When a repo tracks `.docstore/*`, use the DocStore CLI for writes instead of editing managed artifacts by hand.

### Init / repair

```bash
node ./scripts/doc-store-cli.mjs init
node ./scripts/doc-store-cli.mjs init --force --mode=mixed --managed-roots=.docstore/designs,.docstore/decisions,.docstore/process
```

- `init` is safe to rerun. On a healthy store it falls through to `doctor`.
- Use `--force` when you intentionally change `mode` or `managedRoots`. Existing journal state, archive artifacts, and registered extensions are retained.
- If `doctor` reports pending journal recovery or config/index drift, repair through `init` or the ManagedDocStore APIs instead of hand-editing `.docstore/INDEX.json`.

### Adopt legacy docs

```bash
node ./scripts/doc-store-cli.mjs adopt docs/designs/doc-store-api-draft.md --kind=design --title="DocStore API Draft"
```

- `adopt` moves an existing file into `.docstore/` and prefers `git mv` so history stays attached when the repo supports it.
- Outside a git worktree it falls back to a normal move, so local sandboxes and tests still work.

### Install hook

```bash
node ./scripts/doc-store-cli.mjs install-hook
node ./scripts/doc-store-cli.mjs uninstall-hook
```

- `install-hook` is idempotent.
- `uninstall-hook` is safe to rerun; if a preserved hook exists it is restored, otherwise the command exits cleanly.
- If `.git/hooks/pre-commit` already exists, DocStore preserves it as `pre-commit.doc-store-prev` and chains to it before running `enforce-staged`.

### Modes

- `legacy` — permissive rollout mode; managed-path enforcement is off.
- `mixed` — legacy paths stay editable, but configured `.docstore/*` roots must be written through DocStore.
- `managed` — configured managed roots are strict; manual adds, edits, or deletes are rejected unless the staged `INDEX.json` change matches the artifact change.
- Change `mode` or `managedRoots` through `doc-store-cli init --force ...` so config and index stay in sync.

This repository currently uses `mixed` mode with `.docstore/designs`, `.docstore/decisions`, and `.docstore/process` as managed roots.

---

## Goal-First Delegation

The correct way to use this framework is to give it a goal, not a plan.

```text
$va-auto-pilot

Objective:
Ship onboarding v2 with measurable activation lift.

Constraints:
- Keep architecture boundaries unchanged.
- No security regressions.
- Keep critical path latency under 300ms.

Acceptance:
- typecheck, lint, tests pass
- configured review gate reports no blocking findings
- acceptance flow MUST 100%, SHOULD >= 80%
```

No list of files. No sequence of steps. No prescribed approach. You define the destination and the constraints. That is the entire contract.

---

## Concurrency Model

- One primary task per cycle, zero or more independent tracks in parallel
- Synchronization at mandatory quality gates
- State promotion blocked until required gates pass
- Default path is model-native parallel tool orchestration
- Replace `review-agent` with your configured reviewer command or wrapper (the example below is a placeholder)

Humans normally see this through the default `cockpit` output. Manager agents
and debuggers can use `cockpit --json`; the planner and board commands below
are internal/debug surfaces:

```bash
node scripts/sprint-board.mjs plan --json --max-parallel 3 > .va-auto-pilot/parallel-plan.json
npm run check:all && review-agent review --uncommitted && npm run validate:distribution
```

---

## Distribution

```bash
# npm
npm i -g va-auto-pilot

# Generic CLI agent path
npx va-auto-pilot init .
npm install

# Then capture the goal and inspect the human-facing cockpit
node scripts/auto-pilot.mjs goal --text "Ship a reliable release"
node scripts/auto-pilot.mjs cockpit

# A capable CLI agent can then run the governed loop internally.
# The line below is a natural-language prompt you paste into your agent,
# not a shell command:
# $va-auto-pilot run one full loop in this repo with highest standards; keep humans on goal, risk, and evidence

# Agent integration example: Claude Code command
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md \
  -o .claude/commands/va-auto-pilot.md
```

---

## Roadmap

### v0.3

- Persistence — SQLite-backed sprint state and pitfall storage
- Push-based async — replace polling with event-driven worker notifications
- Web Dashboard — real-time sprint visualization

### Future

- REST / gRPC adapter for non-CLI integrations
- Multi-language SDK (Python, Go)
- Distributed orchestration across machines

See the next-gen Harness + Loop roadmap:
`docs/operations/next-gen-harness-loop-roadmap.md`

---

## Documentation

- Protocol: `docs/operations/va-auto-pilot-protocol.md`
- Public narrative spec: `docs/operations/public-narrative-spec.md`
- Open-source readiness checklist: `docs/operations/open-source-readiness-checklist.md`
- Next-gen roadmap: `docs/operations/next-gen-harness-loop-roadmap.md`
- Start prompt: `docs/operations/start-va-auto-pilot-prompt.md`
- Distribution: `docs/operations/distribute-skill.md`
- Vision article: `docs/human-on-the-loop.md`
- Ralph comparison: `docs/comparisons/va-auto-pilot-vs-ralph.en.md`

---

## Website

`website/` is a standalone static site with bilingual switch (EN / 中文), interactive state machine, animated execution demo, and SEO + OG metadata.

```bash
cd website && python3 -m http.server 4173
```

---

## Verification

```bash
npm run check:all
npm run validate:distribution
```

---

## Credits

Created by **Vadaski**. Developed with assistance from frontier coding agents and dogfooded through VA Auto-Pilot's own engineering loop.

Acknowledgements: **Vera project**

## License

MIT
