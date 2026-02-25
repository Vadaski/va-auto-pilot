# VA Auto-Pilot

[中文文档](./README.zh.md)

## The Design Bet

Most agent frameworks are built to compensate for model weakness — they break tasks into small steps, prescribe exactly what the model should do, and constrain autonomy to keep weak models on track.

VA Auto-Pilot makes the opposite bet.

**This framework is built for the strongest models, by design.** It sets a goal, states constraints, and specifies acceptance criteria — then trusts the model to find the path. There are no step-by-step instructions to follow. There is no role list to pick from. There is only: here is what must be true when you are done.

If you use a weak model, it will fail. Not because the framework is broken — because you are using the wrong tool. This is intentional. A framework that scales down to weak models must design for weakness. This one designs for strength. As frontier models get more capable, the framework gets better with no changes required.

That is the bet.

---

## Core Intellectual Contributions

### 1. Perspectives emerge from constraints and anchors — never from role lists

Most multi-agent review frameworks prescribe perspectives: "security reviewer," "QA engineer," "architecture reviewer." The problem is that generic roles expose generic failure modes. Real failure modes are specific to the change.

VA Auto-Pilot uses a different model. Before any review, the manager identifies:
- **Constraints**: what hard boundaries govern this change?
- **Anchors**: what invariants must hold after this change?

Given those real constraints and anchors, the question becomes: *which expert views would expose the most critical failure modes for this specific change?* The perspectives emerge from the analysis — they are never assigned from a fixed list.

This is why reviews sharpen over time. The model learns which viewpoints matter for each kind of change. A fresh-role-list never learns anything.

### 2. CLI-first is a correctness guarantee, not a style preference

Quality gates run via deterministic CLI commands. `npm run check:all` either passes or it does not. The model cannot declare success, argue its way through, or self-certify quality.

This creates an objective synchronization point that separates "I think it's done" from "it is done." Without this, autonomous loops collapse into self-validation — the model becomes increasingly confident about increasingly wrong outputs.

### 3. The manager delegates — it never implements

The manager agent's value is knowing *what* needs to be true, not *how* to make it true. Implementation is always delegated to sub-agents with full context: objective, constraints, hard limits, and completion gate. The sub-agent decides the path.

This matches how strong models actually work best. They reason well from objectives. They reason poorly from step-by-step instructions that second-guess their judgment.

### 4. Strategic decomposition before tactical execution

High-level goals ("bring this to commercial quality") are not decomposed by a human into tasks. The framework runs a parallel dimension scan: each sub-agent audits one axis of the problem independently, with no cross-contamination between dimensions. The findings converge into a prioritized backlog.

The model is a better project planner than most humans when given the right framing. The framework gives it that framing.

### 5. Adversarial post-sprint review as a first-class gate

Every sprint ends with a fresh-context adversarial reviewer who has seen only the diff — not what was intended, not what was discussed. Their job is to find what the sprint team was blind to.

This prevents the most common failure mode in autonomous loops: self-validation bias accumulating across sprints until a significant regression slips through. The adversarial reviewer is structurally unable to be fooled by good intentions.

### 6. Failure knowledge compounds

The pitfall guide captures structured failure metadata — not just error strings, but hypotheses and missing context. Future delegations inject relevant pitfalls as hard constraints. The system gets harder to fool over time. Each failure makes subsequent delegations more precise.

---

## When to Use VA Auto-Pilot

**Use it when:**
- You have access to Claude Opus 4.6 or gpt-5.3-codex class capability (or equivalent)
- Your goal is complex enough that a human would need to decompose it before executing
- You need guaranteed quality gates, not best-effort review
- You want an execution loop that gets better as models improve, not one you have to maintain

**Do not use it when:**
- You are running a mid-tier or weak model — the framework will not compensate, and the tasks will fail or produce poor output
- You want to control every implementation step — if you need to prescribe how, use a different tool
- Your task is small and bounded — a single well-written prompt is faster and more appropriate
- You want minimal ceremony — this framework has protocol; the value is in the guarantees

---

## What You Get

- `va-auto-pilot` CLI scaffold for any repository
- machine-readable sprint state (`.va-auto-pilot/sprint-state.json`)
- generated sprint board (`docs/todo/sprint.md`)
- human override board (`docs/todo/human-board.md`)
- append-only run memory (`docs/todo/run-journal.md`)
- protocol documents and start prompt
- acceptance flow runner (`scripts/test-runner.ts`)

---

## Quick Start

```bash
# local
node ./bin/va-auto-pilot.mjs init .

# bootstrap from GitHub (no npm registry dependency)
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

## Goal-First Delegation

The correct way to use this framework is to give it a goal, not a plan. The model figures out the plan.

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

Notice what is absent: no list of files to touch, no sequence of steps to follow, no prescribed approach. The model decides the path. You define the destination and the constraints. That is the entire contract.

---

## Concurrency Model

- One primary task is selected per cycle, and zero or more independent tracks can run in parallel.
- Synchronization happens at mandatory quality gates.
- State promotion is blocked until required gates pass.
- Concurrency decisions are runtime judgments made by the manager agent.
- Default path is model-native parallel tool orchestration.

Default model-native path:

```bash
node scripts/sprint-board.mjs plan --json --max-parallel 3 > .va-auto-pilot/parallel-plan.json
# manager agent executes tracks via native parallel tool calls
# synchronization barrier before state promotion
npm run check:all && codex review --uncommitted && npm run validate:distribution
```

Experimental helper (opt-in only):

```bash
node scripts/va-parallel-runner.mjs spawn --plan-file .va-auto-pilot/parallel-plan.json --agent-cmd "codex exec --task {taskId}"
```

---

## Distribution

Codex install:

```text
$skill-installer install https://github.com/Vadaski/va-auto-pilot/tree/main/skills/va-auto-pilot
```

Claude Code install:

```bash
mkdir -p .claude/commands
curl -fsSL https://raw.githubusercontent.com/Vadaski/va-auto-pilot/main/skills/va-auto-pilot/claude-command.md -o .claude/commands/va-auto-pilot.md
```

---

## Documentation

- Protocol: `docs/operations/va-auto-pilot-protocol.md`
- Start prompt: `docs/operations/start-va-auto-pilot-prompt.md`
- Distribution: `docs/operations/distribute-skill.md`
- Vision article: `docs/human-on-the-loop.md`
- Ralph comparison: `docs/comparisons/va-auto-pilot-vs-ralph.en.md`

---

## Website

`website/` is a standalone static site with:

- bilingual switch (EN / 中文)
- interactive state machine
- animated execution demo
- SEO + OG metadata

Local preview:

```bash
cd website
python3 -m http.server 4173
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
