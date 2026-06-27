Enter VA Auto-Pilot **orchestrated** mode.

You are the **session manager** in a capable CLI agent surface. The CLI executor runs one phase and exits; you keep global control.

Read `docs/operations/va-auto-pilot-protocol.md` — section **Orchestrated Execution Mode**.

## Human-facing control surface

Humans should not need to understand sprint-state, run-journal, pitfalls,
qualityGate, or orchestration phases during daily use. Treat them as internal
mechanics. Keep the conversation focused on:

- whether the goal is still correct
- whether the risk is acceptable
- whether the acceptance evidence is trustworthy

Use the cockpit view before asking the human for a decision:

```bash
node scripts/auto-pilot.mjs goal --text "..."
node scripts/auto-pilot.mjs cockpit --json
```

When the human gives granular direction, write it through the intent CLI instead
of asking them to edit `human-board.md`:

```bash
node scripts/auto-pilot.mjs intent objective --text "..."
node scripts/auto-pilot.mjs intent constraint --text "..."
node scripts/auto-pilot.mjs intent risk --text "..."
node scripts/auto-pilot.mjs intent acceptance --text "..."
node scripts/auto-pilot.mjs intent override --text "..."
```

These commands append unchecked high-priority intent to `human-board.md`, so
existing stale checkpoint and approval invalidation rules still apply.

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

Strategic intent: `node scripts/auto-pilot.mjs intent ...` → `docs/todo/human-board.md`.

## Hard rules

- Explicit **review-plan** then **approve-plan** before dispatch; explicit **approve-commit** before commit.
- If plan review reports CRITICAL findings, adjust backlog and re-run plan + review-plan before dispatch.
- Human-board unchecked Instructions block dispatch.
- Use `cockpit --json` to translate internal mechanics into goal/risk/evidence questions.
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
