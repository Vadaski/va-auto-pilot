---
description: Bootstrap and run the VA Auto-Pilot autonomous engineering loop for the current repository.
---

Operate in VA Auto-Pilot mode for this repository.

Execution rules:

1. If `.va-auto-pilot/config.yaml` is missing, run from the local va-auto-pilot source checkout (source-install mode — no remote clone):

```bash
: "${VA_AUTO_PILOT_ROOT:=$HOME/vadaski/Code/va-auto-pilot}"
node "$VA_AUTO_PILOT_ROOT/bin/va-auto-pilot.mjs" init .
```

2. **Preferred: use the autonomous loop.**

```bash
node scripts/auto-pilot-loop.mjs --max-cycles 50
```

This runs the full autonomous loop: human-board → pitfall load → constraint load → plan → dispatch (parallel by default) → quality gates → auto-commit → state update → journal. The loop restarts automatically while backlog has tasks.

Options:
- `--max-cycles <n>` — max task cycles (default: 50)
- `--max-parallel <n>` — parallel track count (default: 3)
- `--parallel` — enable multi-track execution (default)
- `--no-parallel` — serialize all tasks
- `--single-cycle` — run exactly one cycle then exit
- `--dry-run` — print plan without executing
- `--no-commit` — skip auto-commit after gates pass
- `--no-colony` — skip Colony, use raw spawn
- `--skip-sprint-review` — bypass sprint completion review gate
- `--strict` — treat unchecked human-board instructions as hard block
- `--json` — machine-readable output

3. **Manual fallback** (when you need fine-grained control):

Read these files in order before taking action:
- `docs/operations/va-auto-pilot-protocol.md`
- `docs/todo/human-board.md`
- `docs/todo/run-journal.md`
- `docs/todo/sprint.md`
- `.va-auto-pilot/constraints/` (typed constraints injected into delegation)

Follow the state machine strictly: `Backlog -> In Progress -> Review -> Testing -> Done`

Resolve and update state via CLI:
- `node scripts/sprint-board.mjs next [--json]`
- `node scripts/sprint-board.mjs plan --json --max-parallel 3`
- `node scripts/sprint-board.mjs update --id AP-XXX --state "In Progress"`
- `node scripts/sprint-board.mjs journal --task AP-XXX --summary "..."`
- `node scripts/sprint-board.mjs pitfall --task AP-XXX --failure-type gate --attempted "..." --hypothesis "..."`
- `node scripts/sprint-board.mjs pitfall --resolve PF-NNN --resolution "..."` (can auto-synthesize constraint YAML)
- `node scripts/sprint-board.mjs suggest-gate` — output gate suggestions from unresolved pitfalls

4. Always run gates from `.va-auto-pilot/config.yaml` and `quality-gates.yaml`:
- `qualityGate.buildCommand`
- `qualityGate.reviewCommand`
- `qualityGate.acceptanceTestCommand`

5. Never skip gate failures. The loop auto-classifies failures and logs recovery strategies. Fix, re-run, then update state.
6. If stop condition is hit (3 failures on same task), pause and ask human for decision.
7. Default to parallel execution for independent tasks via `plan --json`.
8. If the repo uses Managed DocStore (`.docstore/*` present), route doc writes through `doc-store-cli.mjs` — never hand-edit `INDEX.json` or managed paths.
9. Report concise status after each cycle: tasks executed, state changes, gate results, auto-commit hashes, next action.
