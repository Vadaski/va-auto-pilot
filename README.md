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
│  typecheck · lint · test · codex-review · acceptance  │
├──────────────────────────────────────────────────────┤
│         Pitfall Guide (failure knowledge compounds)   │
└──────────────────────────────────────────────────────┘
```

### Try it now

```bash
npx va-auto-pilot init .
```

---

## The Design Bet

Most agent frameworks are built to compensate for model weakness — they break tasks into small steps, prescribe exactly what the model should do, and constrain autonomy to keep weak models on track.

VA Auto-Pilot makes the opposite bet.

**This framework is built for the strongest models, by design.** It sets a goal, states constraints, and specifies acceptance criteria — then trusts the model to find the path. There are no step-by-step instructions to follow. There is no role list to pick from. There is only: here is what must be true when you are done.

If you use a weak model, it will fail. Not because the framework is broken — because you are using the wrong tool. This is intentional. A framework that scales down to weak models must design for weakness. This one designs for strength. As frontier models get more capable, the framework gets better with no changes required.

That is the bet.

---

## Why Frontier Models Need This

2026 frontier models (Claude Opus 4.6, GPT-5.3-codex, or equivalent) bring extraordinary capabilities: autonomous multi-step reasoning, million-token context windows, and native tool calling. VA Auto-Pilot is designed to **amplify these strengths** and **guard against remaining weaknesses**.

### Amplifying strengths

- **Objective-driven delegation** — The manager gives goals, constraints, and acceptance criteria. No micromanagement. The model's reasoning ability is fully unleashed.
- **Parallel autonomous tracks** — Frontier models handle complex parallel tool orchestration natively. The framework leans into this instead of serializing everything.
- **Long-context awareness** — Sprint state, pitfall guides, and run journals are designed for models that can hold an entire project in context.

### Guarding against weaknesses

- **Evidence gates prevent hallucination** — The model cannot self-certify. CLI commands produce objective pass/fail signals. "I think it's done" is not the same as "it is done."
- **Pitfall compounding prevents repeated mistakes** — Structured failure metadata from past runs is injected into future delegations as hard constraints. The system gets harder to fool over time.
- **Adversarial review breaks self-validation loops** — A fresh-context reviewer sees only the diff, never the intent. This structurally prevents the most common autonomous loop failure: growing confidence in growing errors.

> **One sentence:** Trust the model's reasoning power; use deterministic mechanisms to catch its blind spots.

---

## Relationship to va-agent-protocol

VA Auto-Pilot is a **sprint execution framework** — it runs the autonomous engineering loop. [va-agent-protocol](https://github.com/Vadaski/va-agent-protocol) is the **universal task protocol** — the standardized contract that wraps any CLI agent (including VA Auto-Pilot) into a composable unit.

VA Auto-Pilot was the first adapter built for va-agent-protocol. You can use Auto-Pilot standalone or as a managed agent inside the protocol's orchestrator.

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

Quality gates run via deterministic CLI commands. `npm run check:all` either passes or it does not. The model cannot declare success, argue its way through, or self-certify quality.

This creates an objective synchronization point that separates "I think it's done" from "it is done."

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
- You have access to Claude Opus 4.6 or GPT-5.3-codex class capability (or equivalent)
- Your goal is complex enough that a human would need to decompose it before executing
- You need guaranteed quality gates, not best-effort review
- You want an execution loop that gets better as models improve

**Do not use it when:**
- You are running a mid-tier or weak model — the framework will not compensate
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

Render board after initialization:

```bash
node scripts/sprint-board.mjs render
```

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
- codex review reports no blocking findings
- acceptance flow MUST 100%, SHOULD >= 80%
```

No list of files. No sequence of steps. No prescribed approach. You define the destination and the constraints. That is the entire contract.

---

## Concurrency Model

- One primary task per cycle, zero or more independent tracks in parallel
- Synchronization at mandatory quality gates
- State promotion blocked until required gates pass
- Default path is model-native parallel tool orchestration

```bash
node scripts/sprint-board.mjs plan --json --max-parallel 3 > .va-auto-pilot/parallel-plan.json
npm run check:all && codex review --uncommitted && npm run validate:distribution
```

---

## Distribution

```bash
# npm
npm i -g va-auto-pilot

# Claude Code
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md \
  -o .claude/commands/va-auto-pilot.md
```

---

## Roadmap

### v0.2

- Persistence — SQLite-backed sprint state and pitfall storage
- Push-based async — replace polling with event-driven notifications
- Web Dashboard — real-time sprint visualization

### v0.3

- Governance — cost guardrails + permission scoping
- REST / gRPC adapter for non-CLI integrations

### Future

- Multi-language SDK (Python, Go)
- Distributed orchestration across machines

---

## Documentation

- Protocol: `docs/operations/va-auto-pilot-protocol.md`
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

- Co-creators: **Vadaski**, **Codex**, **Claude**
- Acknowledgements: **Vera project**

## License

MIT
