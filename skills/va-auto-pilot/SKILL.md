---
name: va-auto-pilot
description: Bootstrap and operate the VA Auto-Pilot engineering loop in any repository. Use when users ask for autonomous delivery flow, sprint/human boards, quality gates, or /va-auto-pilot mode.
metadata:
  version: 3.0.0
---

# VA Auto-Pilot Skill

## Trigger

Use this skill when the user asks to:

- initialize an autonomous engineering workflow
- adopt sprint state machine + human override board
- enforce build/review/acceptance gates
- run a manager-style multi-agent loop
- enable `/va-auto-pilot` operating mode

## Workflow

1. Confirm target repository root (default: current directory).
2. Install scaffold:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 https://github.com/Vadaski/va-auto-pilot "$tmp/va-auto-pilot"
node "$tmp/va-auto-pilot/bin/va-auto-pilot.mjs" init <target-dir>
cd <target-dir>
npm install yaml
rm -rf "$tmp"
```

3. Read and align these files:

- `.va-auto-pilot/config.yaml`
- `.va-auto-pilot/sprint-state.json`
- `.va-auto-pilot/quality-gates.yaml` — project-specific gates
- `docs/todo/sprint.md`
- `docs/todo/human-board.md`
- `docs/todo/run-journal.md`
- `docs/operations/va-auto-pilot-protocol.md`

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

Adaptive: when bugs escape gates, create new gates that would catch them.

5. Start the loop:

- read human-board.md
- read run-journal.md (Codebase Signals first)
- resolve next with `node scripts/sprint-board.mjs next`
- execute task by objective + constraints
- **run ALL gates from quality-gates.yaml**
- update state + journal

## Quality Gate Protocol

Before every commit:
1. Read .va-auto-pilot/quality-gates.yaml
2. Run every required gate
3. Fail → fix → re-run (never commit with failing gates)
4. New failure pattern → add new gate + record pitfall

When delegating, always include gate commands in acceptance criteria.

Cross-project: inherit proven gates from similar projects.

## Output Contract

Report: changes, gate results, next task, stop conditions, new gates created.
