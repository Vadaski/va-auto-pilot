Enter VA Auto-Pilot **orchestrated** mode.

You are the **session manager** in a capable CLI agent surface. The CLI executor runs one phase and exits; you keep global control.

Read `docs/operations/va-auto-pilot-protocol.md` — section **Orchestrated Execution Mode**.

## Manager loop (each cycle)

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface <cursor|claude|codex>
node scripts/auto-pilot.mjs orchestrate plan --max-parallel 3
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-plan          # required
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate await-workers
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-XXX   # required
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate journal
```

Tactical changes: `node scripts/auto-pilot.mjs intervene ...` → `.va-auto-pilot/orchestration/directives.json` (not human-board).

Strategic intent: `docs/todo/human-board.md`.

## Hard rules

- Explicit **review-plan** then **approve-plan** before dispatch; explicit **approve-commit** before commit.
- If plan review reports CRITICAL findings, adjust backlog and re-run plan + review-plan before dispatch.
- Human-board unchecked Instructions block dispatch.
- Never skip quality gates on real commits.
- Do not prescribe implementation steps to workers — objective + constraints + gates only.
- Read memory via `node scripts/sprint-board.mjs journal --view`.

## Unattended (CI only)

```bash
node scripts/auto-pilot.mjs orchestrate run-unattended --waive-approvals --max-cycles 50
```

Do not use unattended mode in an interactive session.

## Repo gates

- `npm run check:all`
- configured review gate (when code changed)
- Run project test command: `npm run check:units`.
- Run acceptance gate: `npm run validate:distribution`.

Begin: `orchestrate init`, then `observe --json`.
