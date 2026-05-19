Enter VA Auto-Pilot **orchestrated** mode.

You are the **session manager** (Claude Code, Cursor, or Codex). The CLI executor runs one phase and exits; you keep global control.

Read `docs/operations/va-auto-pilot-protocol.md` — section **Orchestrated Execution Mode**.

## Manager loop (each cycle)

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface <cursor|claude|codex>
node scripts/auto-pilot.mjs orchestrate plan --max-parallel 3
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-plan          # required
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate await-workers
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-XXX   # required
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate journal
node scripts/auto-pilot.mjs orchestrate close
```

Tactical changes: `node scripts/auto-pilot.mjs intervene ...` → `.va-auto-pilot/orchestration/directives.json` (not human-board).

Strategic intent: `docs/todo/human-board.md`.

## Hard rules

- Explicit **approve-plan** before dispatch; explicit **approve-commit** before commit.
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

- Run quality gate: `{{BUILD_COMMAND}}`.
- Run review gate: `{{REVIEW_COMMAND}}`.
- Run project test command: `{{PROJECT_TEST_COMMAND}}`.
- Run acceptance gate: `{{TEST_COMMAND}}`.

Begin: `orchestrate init`, then `observe --json`.
