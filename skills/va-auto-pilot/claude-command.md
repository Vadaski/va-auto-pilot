---
description: Bootstrap and run the VA Auto-Pilot manager loop for the current repository.
---

Operate in VA Auto-Pilot mode for this repository.

Execution rules:

1. If `.va-auto-pilot/config.yaml` is missing, run:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
rm -rf "$tmp"
```

2. **Preferred: use the autonomous loop.**

```bash
node scripts/auto-pilot-loop.mjs --max-cycles 10
```

This automates the full Decision Loop: human-board check → pitfall load → next task → dispatch → quality gates → state update → journal.

Options:
- `--dry-run` — print plan without executing
- `--max-cycles <n>` — limit iterations (default: 20)
- `--no-colony` — skip Colony, use raw spawn
- `--agent-template <cmd>` — agent command (default: "claude --task {taskId}")
- `--json` — machine-readable output

3. **Manual fallback** (when you need fine-grained control):

Read these files in order before taking action:
- `docs/operations/va-auto-pilot-protocol.md`
- `docs/todo/human-board.md`
- `docs/todo/run-journal.md`
- `docs/todo/sprint.md`

Follow the state machine strictly: `Backlog -> In Progress -> Review -> Testing -> Done`

Resolve and update state via CLI:
- `node scripts/sprint-board.mjs next`
- `node scripts/sprint-board.mjs plan --json --max-parallel 3`
- `node scripts/sprint-board.mjs update ...`
- `node scripts/sprint-board.mjs journal ...`

4. Always run gates from `.va-auto-pilot/config.yaml`:
- `qualityGate.buildCommand`
- `qualityGate.reviewCommand`
- `qualityGate.acceptanceTestCommand`

5. Never skip gate failures. Fix, re-run, then update state.
6. If stop condition is hit, pause and ask human for decision.
7. Default to model-native CLI orchestration for parallel tracks.
8. Report concise status after each loop: task, state change, gate results, next action.
