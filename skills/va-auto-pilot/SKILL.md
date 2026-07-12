---
name: va-auto-pilot
description: Bootstrap and operate the VA Auto-Pilot engineering loop in any repository. Use when users ask for autonomous delivery flow, sprint/human boards, quality gates, /va-auto-pilot mode, or an explicitly installed /auto-pilot alias.
metadata:
  version: 5.0.0
---

# VA Auto-Pilot Skill

## Trigger

Use this skill when the user asks to:

- initialize an autonomous engineering workflow
- adopt sprint state machine + human override board
- enforce build/review/acceptance gates
- run a manager-style multi-agent loop
- enable `/va-auto-pilot` operating mode, or an explicitly installed `/auto-pilot` alias

## Workflow

1. Confirm target repository root (default: current directory).
2. Install scaffold. Prefer the published package when available:

```bash
npx va-auto-pilot init <target-dir>
cd <target-dir>
npm install
```

If the npm package is not available yet, install from GitHub source:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init <target-dir>
cd <target-dir>
npm install
rm -rf "$tmp"
```

Maintainers working inside the source checkout may set `VA_AUTO_PILOT_ROOT` and run `node "$VA_AUTO_PILOT_ROOT/bin/va-auto-pilot.mjs" init <target-dir>`.

3. Read and align these files:

- `.va-auto-pilot/config.yaml`
- `.va-auto-pilot/sprint-state.json`
- `.va-auto-pilot/config.yaml` `qualityGate` section — project-specific gates
- `.va-auto-pilot/constraints/` — typed constraint library (YAML)
- `docs/todo/sprint.md`
- `docs/todo/human-board.md`
- `docs/todo/run-journal.md`
- `docs/operations/va-auto-pilot-protocol.md`

Treat these as Auto-Pilot internal control surfaces. In normal user-facing
operation, keep the human conversation focused on three judgments: whether the
goal is still correct, whether the risk is acceptable, and whether the
acceptance evidence is trustworthy.
Use `cockpit.humanJudgment.evidence.summary` for the evidence view; it
prioritizes validated current-run task manifests under `structured`, including
run/task and event-log bindings, artifact size/hash identity, required gate results, outcomes, and declared
review counts when present. Journal summaries are fallback context only when no bundle exists. Its
`gateTrust` field summarizes missing or weak evidence gates so the human can
judge evidence trust without reading `qualityGate` internals.

Use the cockpit and intent commands as the daily agent-facing interface:

```bash
node scripts/auto-pilot.mjs goal --text "..."
node scripts/auto-pilot.mjs plan-from-goal --json
node scripts/auto-pilot.mjs plan-from-goal --apply --json
node scripts/auto-pilot.mjs cockpit --json
node scripts/auto-pilot.mjs gates audit --json
node scripts/auto-pilot.mjs gates maintain --apply --json
node scripts/auto-pilot.mjs intent objective --text "..."
node scripts/auto-pilot.mjs intent constraint --text "..."
node scripts/auto-pilot.mjs intent risk --text "..."
node scripts/auto-pilot.mjs intent acceptance --text "..."
node scripts/auto-pilot.mjs intent override --text "..."
```

`goal` writes objective intent; `plan-from-goal` turns unchecked objective intent
into `.va-auto-pilot/orchestration/candidate-backlog.json`. With `--apply`, it
writes candidate items into sprint state and marks consumed intent handled.
`orchestrate plan` performs this conversion automatically when unchecked
objective intent exists.
`intent` writes to the human override channel without requiring the user to edit
`human-board.md`; stale approval invalidation still applies.
`gates maintain --apply` is agent-internal cleanup for resolved placeholder
adaptive gates; unresolved weak gates remain evidence-risk signals.

4. **Configure quality gates** (pluggable + adaptive):

Gates are NOT hardcoded. Auto-detect by project type:

| File | Type | Default gate |
|------|------|-------------|
| package.json | TypeScript | npm run check:all |
| project.godot | Godot | godot --headless --script tests/validate_all_scripts.gd |
| Cargo.toml | Rust | cargo check && cargo test |
| pyproject.toml | Python | pytest |
| go.mod | Go | go build ./... && go test ./... |
| Unknown | Any | Investigate + create gates BEFORE delegating |

Adaptive: `node scripts/sprint-board.mjs suggest-gate` reads unresolved pitfalls and outputs YAML gate suggestions. Human confirms before writing to `.va-auto-pilot/config.yaml`.

5. Start orchestrated mode (interactive — session agent is the manager):

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface cursor
node scripts/auto-pilot.mjs cockpit --json
node scripts/auto-pilot.mjs goal --text "..."
node scripts/auto-pilot.mjs plan-from-goal --json
node scripts/auto-pilot.mjs plan-from-goal --apply --json
node scripts/auto-pilot.mjs orchestrate plan
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate review-plan    # Codex/read-only plan review; approvalPolicy may auto-approve
node scripts/auto-pilot.mjs orchestrate approve-plan   # explicit when approvalPolicy requires human judgment
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs orchestrate await-workers
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-XXX # explicit when approvalPolicy requires human judgment
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate recover --json     # diagnose stale/crashed run state
```

Unattended only: `node scripts/auto-pilot-loop.mjs --max-cycles 50` or `orchestrate run-unattended --waive-approvals`.

## Key Features

### Auto-Restart Loop
- Runs multiple cycles automatically (default 50)
- Re-reads human-board and run-journal at each cycle boundary
- `--single-cycle` for single-shot execution
- Stops on: empty backlog, 3 failures on same task, human board block

### Auto-Commit
- After quality gates pass, auto-stages task files and commits
- Baseline dirty files get a separate "chore: sync" commit
- On commit failure, task rolls back to Failed (with completedAt/verification cleared)
- `--no-commit` to disable

### Parallel Execution (default)
- `--parallel` (default): dispatches independent tasks concurrently via `plan --json`
- `--no-parallel`: serialize all tasks
- `--max-parallel <n>`: control concurrency (default: 3)
- Optional worktree isolation maps each queued track to `.va/worktrees/<taskId>`
  when `worktreeIsolation.enabled: true`; manager squash-merges approved track
  commits during `orchestrate commit`.

### Risk-Based Approval Policy
- `approvalPolicy` in `.va-auto-pilot/config.yaml` can auto-approve only low-risk
  categories when configured conditions hold.
- Recommended shape: `docsOnly: auto-if-gates-trusted`,
  `testsOnly: auto-if-gates-trusted`, `smallRefactor:
  auto-if-no-risk-signals`, and `apiChange` / `securityChange` /
  `researchClaimChange`: `human-required`.
- Without `approvalPolicy`, interactive runs remain human-required for
  `approve-plan` and `approve-commit`.
- Plan-review output must end with exactly one unambiguous `PLAN REVIEW STATUS:
  PASS|FAIL` marker; empty or conflicting output is a failure, and review waivers require
  `--waive-review-with-reason`.
- Commit approval is context-bound. If approved files, isolated-worktree
  commits, evidence references, or integration `HEAD` change, rerun
  `approve-commit` before committing.

### Error Recovery
- Failures are classified: build/lint/test/review/dispatch/commit
- Severity mapped: transient/fixable/critical
- Recovery strategy selected: retry-immediately, retry-with-fix, escalate-model, create-fix-task, stop
- Classification is journaled on every failure
- `orchestrate recover --json` diagnoses interrupted runs; `--apply` only performs conservative state repair (clear dead locks, settle tracks with no live worker, return stale checkpoints to plan approval, close no-pending-work runs). If run/tracks durably reached `done` before shutdown cleanup, `--apply` immediately replays claim release, checkpoint/review cleanup, and active-run removal without waiting for claim TTL; `halted`, `error`, or live/recent worker state does not use this shortcut. Spawn workers cross a READY→persist→GO barrier, own their deadline independently of the manager, and persist run/tracks through a hash-checked transaction intent. Corrupt or ambiguous identity fails closed; orchestrated `await-workers` currently forces this spawn lifecycle instead of Colony routing.

### Structured Review Pipeline
- Review output parsed for CRITICAL/BUG/P0/P1/P2/WARNING/STYLE findings
- Blocking findings auto-create fix tasks in backlog
- Original task set to depend on fix tasks (prevents premature retry)
- BUG and P0 normalized to CRITICAL

### Sprint Completion Review
- When backlog empties, spawns isolated read-only codex session
- Reviewer gets ONLY the git diff — no run-journal or sprint context
- Dynamic perspective selection based on changed files (CLI→CI dev, auth→security eng, protocol→adopter, tests→QA)
- CRITICAL findings create new backlog tasks, sprint continues
- `--skip-sprint-review` to bypass

### Adaptive Quality Gates
- `node scripts/sprint-board.mjs suggest-gate` — outputs YAML gate suggestions from unresolved pitfalls
- Does NOT auto-write `.va-auto-pilot/config.yaml` gate changes without an explicit command/human confirmation.
- Pitfall-to-gate suggestions are journaled after failure recording

### Managed DocStore
Optional subsystem for managing design / decision / process docs through a typed store.

```bash
node ./scripts/doc-store-cli.mjs init                    # one-time bootstrap
node ./scripts/doc-store-cli.mjs adopt <path> --kind=design --title="..."
node ./scripts/doc-store-cli.mjs install-hook            # pre-commit enforcement
node ./scripts/doc-store-cli.mjs doctor                  # health check
node ./scripts/doc-store-cli.mjs enforce-staged --base main
```

Modes: `legacy` (off) / `mixed` (configured roots strict, rest free) / `managed` (all strict).
When DocStore is active, do NOT hand-edit files under `.docstore/*` or `INDEX.json` — use the CLI or SDK.

### Constraint Library
Typed YAML constraints under `.va-auto-pilot/constraints/` (dispatch, review-gate, adopt, mode-enforcement, state-race, ...). Constraint-bridge loads active relevant entries at loop start and injects them under **Hard constraints**. Resolving a pitfall can auto-synthesize a YAML rule, but learned rules enter `probation` and stay out of hard prompts until explicitly promoted with evidence. Active learned rules decay from their last validation; effective feedback refreshes them, ineffective feedback retires them, and an explicit conflict declaration quarantines both rules when both would otherwise be injectable. Curated rules do not decay.

## Quality Gate Protocol

Before every commit:
1. Read `.va-auto-pilot/config.yaml` `qualityGate`
2. Run every required gate
3. Fail → fix → re-run (never commit with failing gates)
4. New failure pattern → add new gate + record pitfall + run suggest-gate

When delegating, always include gate commands in acceptance criteria.

Cross-project: inherit proven gates from similar projects.

## CLI Reference

```bash
# Autonomous loop (primary)
node scripts/auto-pilot.mjs cockpit [--json]
node scripts/auto-pilot.mjs goal --text "..."
node scripts/auto-pilot.mjs plan-from-goal [--apply] [--json]
node scripts/auto-pilot.mjs intent objective --text "..."
node scripts/auto-pilot-loop.mjs [--max-cycles 50] [--no-parallel] [--skip-sprint-review]
node scripts/auto-pilot.mjs orchestrate recover [--apply] [--json]

# Sprint board management
node scripts/sprint-board.mjs next [--json] [--strict]
node scripts/sprint-board.mjs plan --json --max-parallel 3
node scripts/sprint-board.mjs add --title "..." --priority P1
node scripts/sprint-board.mjs update --id AP-001 --state "In Progress"
node scripts/sprint-board.mjs journal --task AP-001 --summary "..."
node scripts/sprint-board.mjs pitfall --task AP-001 --failure-type gate --attempted "..." --hypothesis "..."
node scripts/sprint-board.mjs pitfall --list --unresolved
node scripts/sprint-board.mjs pitfall --resolve PF-NNN --resolution "..."
node scripts/sprint-board.mjs pitfall --promote PF-NNN --evidence "..."
node scripts/sprint-board.mjs pitfall --feedback PF-NNN --outcome effective --evidence "..."
node scripts/sprint-board.mjs pitfall --conflict PF-NNN --with PF-MMM --evidence "..."
node scripts/sprint-board.mjs suggest-gate [--pitfalls-file <path>]
node scripts/sprint-board.mjs summary

# Managed DocStore (optional)
node scripts/doc-store-cli.mjs init | adopt | install-hook | doctor | enforce-staged --base main
```

## Output Contract

Report: changes, gate results, next task, stop conditions, new gates created, review findings summary, commit hashes.
