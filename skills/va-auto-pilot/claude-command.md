---
description: Bootstrap and run the VA Auto-Pilot autonomous engineering loop for the current repository.
---

Operate in VA Auto-Pilot mode for this repository.

Execution rules:

1. If `.va-auto-pilot/config.yaml` is missing, install the scaffold:

```bash
npx va-auto-pilot init .
npm install
```

If the npm package is not available yet:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init .
npm install
rm -rf "$tmp"
```

2. **Preferred: orchestrated mode (you are the manager).**

You stay in the session loop. The executor runs one phase and exits. You **must** explicitly approve plan and commit.

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface claude
node scripts/auto-pilot.mjs orchestrate plan --max-parallel 3
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-plan
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate await-workers
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-XXX
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate journal
```

Tactical course corrections: `node scripts/auto-pilot.mjs intervene ...` → writes `.va-auto-pilot/orchestration/directives.json` (separate from `human-board.md`).

3. **Unattended only (CI / overnight):**

```bash
node scripts/auto-pilot.mjs orchestrate run-unattended --waive-approvals --max-cycles 50
# or legacy: node scripts/auto-pilot-loop.mjs --max-cycles 50
```

4. **Manual sprint-board** (fine-grained control without orchestrate):

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

4. Always run gates from `.va-auto-pilot/config.yaml`:
- `qualityGate.buildCommand`
- `qualityGate.reviewCommand`
- `qualityGate.acceptanceTestCommand`

5. Never dispatch without a passing `orchestrate review-plan` result bound to the current plan.
6. Never skip gate failures. The loop auto-classifies failures and logs recovery strategies. Fix, re-run, then update state.
7. If stop condition is hit (3 failures on same task), pause and ask human for decision.
8. Default to parallel execution for independent tasks via `plan --json`.
9. If the repo uses Managed DocStore (`.docstore/*` present), route doc writes through `doc-store-cli.mjs` — never hand-edit `INDEX.json` or managed paths.
10. Report concise status after each cycle: tasks executed, state changes, gate results, auto-commit hashes, next action.
