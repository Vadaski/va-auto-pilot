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

2. Read these files in order before taking action:

- `docs/operations/va-auto-pilot-protocol.md`
- `docs/todo/human-board.md`
- `docs/todo/run-journal.md`
- `docs/todo/sprint.md`

3. Follow the state machine strictly:

`Backlog -> In Progress -> Review -> Testing -> Done`

4. Resolve and update state via CLI:

- `node scripts/sprint-board.mjs next`
- `node scripts/sprint-board.mjs plan --json --max-parallel 3` (when parallel tracks are possible)
- `node scripts/sprint-board.mjs update ...`
- `node scripts/sprint-board.mjs journal ...`

5. Always run gates from `.va-auto-pilot/config.yaml`:

- `qualityGate.buildCommand`
- `qualityGate.reviewCommand`
- `qualityGate.acceptanceTestCommand`

6. Never skip gate failures. Fix, re-run, then update state.
7. If stop condition is hit, pause and ask human for decision.
8. Default to model-native CLI orchestration for parallel tracks.
9. Use `scripts/va-parallel-runner.mjs` only if human explicitly requests the experimental external runner path.
10. Report concise status after each loop: task, state change, gate results, next action.
