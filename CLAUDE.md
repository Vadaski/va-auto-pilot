# va-auto-pilot — Autonomous Sprint Executor

## Identity
Self-driving development loop. Takes a sprint plan and executes it autonomously — dispatching tasks to CLI agents, verifying results, and iterating until done.

## Stack Position
```
va-wish-engine          → wish → TaskUnit
va-ultimate-amplifier   → grand vision → wish DAG
va-agent-protocol       → task dispatch, evidence, communication protocol
va-auto-pilot          → autonomous sprint execution  ← THIS
va-hub                 → central hub (kanban, inbox, webhooks)
CLI agents (codex, claude, gemini, kimi, glm) → bottom-layer execution
```

## Code Conventions
- TypeScript 5.7+, strict mode, ES2022 target, ESM only
- Node.js >= 20
- Biome for formatting/linting
- Vitest for testing
- Named exports only

## Orchestrated Mode (default for session agents)

Session agents (Cursor / Claude Code) act as **Manager**; the CLI is **Executor**. Each phase exits immediately — no long-running loop.

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface cursor
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate plan
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs orchestrate approve-plan
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs orchestrate await-workers
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-XXX
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate close   # when backlog empty / stale run
```

Tactical overrides: `node scripts/auto-pilot.mjs intervene …` → `.va-auto-pilot/orchestration/directives.json`. Strategic goals stay in `docs/todo/human-board.md`.

## Quality Gate

Quality gates are **pluggable per project** — see `docs/operations/va-auto-pilot-protocol.md` Quality Gates section.
If the repo manages docs through ManagedDocStore, also follow [`README.md` → Managed DocStore](README.md#managed-docstore) for `init`, `adopt`, hook install, and mode handling.

For va-auto-pilot itself (TypeScript):
```bash
npm run build && npm run lint && npm run check:units
```

For target projects, gates are defined in `.va-auto-pilot/config.yaml` under `qualityGate` or auto-detected:
- `package.json` → `npm run check:all`
- `project.godot` → `godot --headless --script tests/validate_all_scripts.gd`
- `Cargo.toml` → `cargo check && cargo test`
- `pyproject.toml` → `pytest`

## Parallel Execution & Delegation Doctrine

**You are a manager, not a soldier.** Never do mechanical work yourself — delegate to CLI agents.

### Core Principles
1. **能并发就并发** — If tasks are independent, run them in parallel. Research, implementation, and verification can ALL happen concurrently.
2. **能委派就委派** — Codex CLI, Gemini CLI, Kimi CLI, OpenCode (default: glm/glm-5). Delegate mechanical work.
3. **大任务必须拆分** — Break large tasks into independent subtasks. Dispatch each to the best-fit agent via va-agent-protocol Colony.
4. **Three-phase parallelism** — For any non-trivial task:
   - **Research phase**: Launch multiple agents to explore different aspects simultaneously
   - **Implementation phase**: Parallelize independent modules/files across agents
   - **Verification phase**: Run build, lint, test concurrently where possible

### Anti-patterns (NEVER do these)
- Writing 100+ lines of boilerplate yourself when an agent can do it
- Sequential execution of independent tasks
- Reading 10 files one-by-one when you can dispatch an Explore agent
- Running build → lint → test sequentially when they could overlap

## Commit Convention
```
<type>: <one-line WHY>

type: feat | fix | refactor | docs | test | chore

Co-Authored-By: Claude <noreply@anthropic.com>
```
