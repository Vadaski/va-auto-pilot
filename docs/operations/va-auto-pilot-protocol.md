# VA Auto-Pilot Protocol

> Behavioral specification for autonomous multi-agent project execution.
> Read this before running a VA Auto-Pilot loop.

---

## Core Principles

1. You are the manager of outcomes, not the implementer of steps.
2. Humans manage judgment: goal correctness, risk acceptability, and evidence trustworthiness.
3. Agents manage mechanics: sprint-state, generated boards, run-journal, pitfalls, quality gates, and orchestration phases.
4. `.va-auto-pilot/sprint-state.json` is the machine task source of truth.
5. `docs/todo/sprint.md` is a generated board view (`node scripts/sprint-board.mjs render`).
6. `docs/todo/run-journal.md` is append-only execution memory; summarize it before showing humans.
7. `docs/todo/human-board.md` is an internal projection of human intent and always overrides automatic decisions.
8. Execute one primary task per cycle; optional parallel tracks are allowed when independent.
9. Goal-first delegation: define objective + constraints + acceptance. Do not prescribe implementation steps.
10. CLI-first execution: prefer deterministic commands over manual operations.
11. Frontier model first: use the strongest available model for high-impact tasks.
12. Closed-loop quality is mandatory: build -> review -> acceptance -> commit.
13. Perspectives emerge from constraints and anchors — never from fixed role lists. Wrong perspectives mean wrong anchors; change both.
12. This repository and skill distribution do not depend on a published npm package; installation/distribution is expected to come from GitHub sources (for example via `skill-installer` path install or direct `git clone` + `va-auto-pilot.mjs init`).

---

## Orchestrated Execution Mode (default for interactive sessions)

When you work in a capable CLI agent surface (for example Claude Code, Cursor, or Codex), the **session agent is the manager**. The auto-pilot CLI is an **executor** that runs one phase at a time and exits. The manager reads global state, approves high-leverage steps, and may intervene between phases.

The final user-facing split is:

| Concern | Owner |
| --- | --- |
| Goal correctness | Human, with agent clarification |
| Risk acceptability | Human, with agent synthesis |
| Acceptance evidence trust | Human, with agent presentation |
| Sprint state, run journal, pitfalls, gates, orchestration phases | Auto-Pilot internals managed by the session agent |

Use `node scripts/auto-pilot.mjs cockpit --json` to translate internal state
into the three human judgments. Use `node scripts/auto-pilot.mjs intent ...` to
write human objectives, constraints, risk notes, acceptance expectations, and
overrides without requiring the human to edit internal files directly.
Cockpit evidence must be shown through `humanJudgment.evidence.summary`, which
compresses journal memory into recent completions, failures, gates, and critical
decisions.
Its `gateTrust` field summarizes whether configured gates look trustworthy
enough for acceptance, including maintenance notes for deliberately disabled
optional gates such as smoke tests. Humans see this as risk and evidence-trust
context, not as raw `qualityGate` mechanics.
The session agent may run `node scripts/auto-pilot.mjs gates audit --json` to
inspect gate trust and `node scripts/auto-pilot.mjs gates maintain --apply --json`
to downgrade resolved placeholder adaptive gates from required to advisory.
`recommendedActions` must stay semantic and human-readable; executable phase
commands belong in `nextCommands[].argv` for the session agent.

### Roles

| Role | Who | Responsibility |
|------|-----|----------------|
| Manager | Session frontier agent | Plan, **explicit approve-plan / approve-commit**, observe, intervene |
| Executor | `auto-pilot orchestrate *` | Run a single phase; update orchestration files; exit |
| Worker | CLI agents (codex, claude, …) | Implement tasks |

### Control plane files

| File | Purpose |
|------|---------|
| `docs/todo/human-board.md` | Internal projection of strategic intent written by `auto-pilot intent` or the manager |
| `.va-auto-pilot/orchestration/directives.json` | **Tactical** directives for the active run only (halt, replan, supersede-plan) — **not** merged into human-board |
| `.va-auto-pilot/orchestration/run.json` | Active run phase, approved plan id, approved commit tasks and commit-manifest hash |
| `.va-auto-pilot/orchestration/tracks.json` | Per-track execution status |
| `.va-auto-pilot/orchestration/candidate-backlog.json` | Explicit goal-to-backlog proposal generated from unprocessed intent |
| `.va-auto-pilot/orchestration/checkpoint.json` | Snapshot at last `approve-plan` (invalidates dispatch if stale) |
| `.va-auto-pilot/orchestration/snapshot.json` | Read-only aggregate for `observe --json`, including `recommendedActions` text and executable `nextCommands[].argv` suggestions |

### Goal-to-backlog gate

`goal` captures durable objective intent. `plan-from-goal` turns unchecked intent into `.va-auto-pilot/orchestration/candidate-backlog.json`. `plan-from-goal --apply` writes candidate items into sprint state and marks the consumed human-board intent `[x]`. `orchestrate plan` performs this conversion automatically when unchecked objective intent exists.

### Approval gates

1. **`review-plan`** — required after `plan`, before `dispatch`. Manager runs a **read-only** configured reviewer agent on `candidatePlan` + human-board context. Writes `.va-auto-pilot/orchestration/plan-review.json` bound to `planHash`. The last non-empty output line must be exactly `PLAN REVIEW STATUS: PASS` or `PLAN REVIEW STATUS: FAIL`; structured `CRITICAL` / `WARNING` / `SUGGESTION` findings precede it. Missing or conflicting status markers fail closed. **Do not dispatch or implement until review passes** (no CRITICAL findings). Record summary in run-journal.
2. **`approve-plan`** — required after `review-plan`, before `dispatch` unless `approvalPolicy` auto-approves the reviewed plan. Records checkpoint (sprint-state, human-board, runtime-config, candidate-plan, worker-selection hashes, plus git HEAD for isolated execution trees). Blocks if `plan-review.json` is missing, stale, or reports CRITICAL. Emergency: `--waive-review-with-reason "..."` (journaled).
3. **`approve-commit --tasks AP-001,...`** — required after workers settle and gates pass, before `commit` unless `approvalPolicy` auto-approves the completed work. Approval binds the exact tasks, settled tracks, approved file hashes or isolated-worktree commits, evidence references, and integration `HEAD`; any drift requires approval again.

`approvalPolicy` is risk based. Safe examples: `docsOnly: auto-if-gates-trusted`, `testsOnly: auto-if-gates-trusted`, `smallRefactor: auto-if-no-risk-signals`. High-risk categories such as `apiChange`, `securityChange`, and `researchClaimChange` should remain `human-required`.

### Worktree isolation

When a run uses an isolated execution tree (the default for shared workspaces), `dispatch` maps each track to `.va/worktrees/<runId>/<taskId>`. Workers execute and gate inside their own git worktree. If a track reaches Done, Auto-Pilot creates a track-local result commit. During `orchestrate commit`, the manager squash-merges the approved track commit into the main worktree under a workspace-level commit lock, then creates the final governed commit.

### Multi-Run Concurrency

Multiple agents can run auto-pilot in the same project simultaneously. Two isolation primitives compose to keep them from interfering:

- **Run** isolates orchestration state (phase, tracks, checkpoint) under `.va-auto-pilot/orchestration/runs/<runId>/`. Each run is a self-contained execution instance.
- **Workspace** isolates the task backlog (sprint-state + board/journal/pitfalls). Runs bind to a workspace.

Two workspace modes cover the two collaboration patterns:

| Mode | Backlog | Execution tree | Use when |
|------|---------|----------------|----------|
| **Shared (协作)** | one backlog at project root, all runs consume it | each run gets its own git worktree (isolated-tree) | splitting one sprint across N agents — parallel task consumption |
| **Isolated (独立)** | each run has its own backlog under `.va-auto-pilot/workspaces/<name>/` | each run in its own worktree | independent sprint lines that must not touch each other's tasks |

**Task claiming prevents two runs from grabbing the same task.** `orchestrate plan` claims the plan's task set atomically (file-lock CAS). `findNextTask`/`buildParallelPlan` skip tasks actively claimed by another run. Claims carry a TTL (`max(60min, 2×trackTimeout)`); an expired claim can be lazily stolen by the next run with an audit trail (`previousClaimedBy`/`reclaimedAt`). `orchestrate recover --apply` releases claims held by nonterminal runs whose lease expired and that have no live track. A run durably at `done` bypasses the TTL only when neither a live process nor a fresh `starting | running` track heartbeat remains: recovery idempotently releases any remaining claims, clears checkpoint/review state, then removes the active-run entry last. `halted`, `error`, and `migrated` do not use this shortcut. This ordering keeps every interrupted shutdown discoverable and fail-closed.

**Starting a second run.** The first run is zero-config (`orchestrate init` works as before). Once an active run exists, a bare `init` is rejected with `INIT_AMBIGUOUS` and prints the explicit options:

```bash
# join the shared backlog (协作)
node scripts/auto-pilot.mjs orchestrate init --workspace default
# start an independent sprint line (独立)
node scripts/auto-pilot.mjs orchestrate init --workspace <name> --isolated
# bind to a specific existing run
node scripts/auto-pilot.mjs orchestrate init --run-id <id>
```

List active runs: `node scripts/auto-pilot.mjs orchestrate list-runs --json`.

**Commit safety.** On a shared workspace, commits are serialized through a workspace-level `commit.lock`; the squash-merge retries if HEAD moved while waiting. The checkpoint binds its staleness policy to the approval-time execution tree: an isolated-tree approval is invalidated by HEAD drift (worktrees build from HEAD, so drift means unreviewed code); a shared-tree approval tolerates HEAD movement (expected sibling commits).

### Manager loop (one cycle)

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface cursor
node scripts/auto-pilot.mjs goal --text "..."
node scripts/auto-pilot.mjs plan-from-goal --json
node scripts/auto-pilot.mjs plan-from-goal --apply --json
node scripts/auto-pilot.mjs orchestrate plan --max-parallel 3
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate review-plan
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-plan
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate await-workers
node scripts/auto-pilot.mjs observe --json
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-001
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate journal
node scripts/auto-pilot.mjs orchestrate recover --json     # diagnose stale/crashed run state
node scripts/auto-pilot.mjs orchestrate close
```

Between steps the manager may run `intervene` (writes `directives.json`) or capture durable intent with `node scripts/auto-pilot.mjs intent ...`. If checkpoint is stale after intent changes, run `approve-plan` again before `dispatch`.

### Recovery / Resume

Use `node scripts/auto-pilot.mjs orchestrate recover --json` after an interrupted
or ambiguous long run. The command diagnoses stale checkpoints, dead executor
locks, dead running tracks or tracks with no live process whose last heartbeat
expired, halted runs, and run phases that no
longer match sprint state. It returns issues, conservative mutations, and
executable next commands.

`recover` is read-mostly by default. Add `--apply` only when the proposed
mutations are acceptable; it can clear dead executor locks, settle stale tracks,
return a stale approved plan to plan-review/approval, or close a run that has no
pending sprint work. Spawn-backed workers use a READY→persist→GO launcher
barrier: the agent command cannot start until its PID, dispatch identity, and
token heartbeat are durable. If the manager dies before GO, the launcher exits
without running the agent; after GO it supervises the process tree to completion.
The launcher owns the absolute worker deadline, so manager death cannot turn a
bounded task into an immortal worker. `run.json` and `tracks.json` publish through
a durable hash-checked transaction intent that the next command replays before
reading mixed state; malformed run/track/directive/heartbeat files block rather
than being interpreted as empty state. Orchestrated `await-workers` therefore
uses the crash-safe spawn lifecycle even when Colony is installed.
Recovery and expired-lease claim cleanup acquire the same executor lock as
`await-workers`, then reread state before mutating it. A live token heartbeat is
never requeued, concurrent halt state survives late worker settlement, and
terminal tracks clear active PID/token fields only after exit is verified.
Stale, corrupt, or post-GO ambiguous identities remain attached and block
destructive operations for manual inspection. It does not dispatch workers,
approve plans, or commit code.

Process-group cleanup is best-effort containment, not an OS sandbox. A command
that deliberately creates a new POSIX session/process group can escape it;
agent templates must not daemonize, and hostile workloads need a stronger
external sandbox/cgroup/Job Object boundary.

### Unattended mode (CI / overnight only)

```bash
node scripts/auto-pilot.mjs orchestrate run-unattended --waive-approvals --max-cycles 50
```

Or legacy: `node scripts/auto-pilot-loop.mjs --max-cycles 50`. Do **not** use these in an interactive session where the manager should stay in control.

---

## State Machine

```
Backlog -> In Progress -> Review -> Testing -> Done
                 ^                     |
                 +------ Failed <------+
```

### State Semantics

- `Backlog`: not started
- `In Progress`: implementation running
- `Review`: implementation done, quality review pending
- `Testing`: review passed, acceptance tests running
- `Failed`: acceptance failed or blocking issue
- `Done`: all gates passed and committed

---

## Human Intent Contract

At the start of each cycle:

1. Run `node scripts/auto-pilot.mjs cockpit --json`.
2. If the human gives new direction, capture it with `node scripts/auto-pilot.mjs intent <type> --text "..."`.
3. Treat unchecked projected intent in `docs/todo/human-board.md` as a hard override.
4. Fold accepted feedback into backlog updates or current task context.
5. Mark handled projected intent items as `[x]`.

Never delete human-written content.

---

## Operational Memory Contract

At the start of each cycle:

1. Read operational memory via `node scripts/sprint-board.mjs journal --view`.
2. Query pitfalls via `node scripts/sprint-board.mjs pitfall --list --unresolved` — identify unresolved entries relevant to the current task (by task ID match, failure type, or keyword overlap). Inject matching unresolved pitfalls into delegation prompts under **Hard constraints**.
3. Check `Codebase Signals` first.
4. Reuse existing signals before inventing new conventions.
5. Append one execution entry at the end of each cycle.

---

## Decision Loop

```bash
# 1. Cockpit — always first
node scripts/auto-pilot.mjs cockpit --json
# -> translate internal mechanics into goal/risk/evidence questions

# 2. Human intent + operational memory
# Capture new human direction through intent, not by asking users to edit internals.
node scripts/auto-pilot.mjs intent objective --text "..."
node scripts/sprint-board.mjs journal --view
node scripts/sprint-board.mjs pitfall --list --unresolved

# 3. Resolve next task
node scripts/sprint-board.mjs next --json
# -> returns task ID, state, and metadata

# 4. Branch on task state:
#    Failed     → fix root cause, re-run gates, advance or re-fail
#    Testing    → npm run validate:distribution
#    Review     → node scripts/sprint-board.mjs review
#    In Progress → continue delegation
#    Backlog    → start via Delegation Contract
#    none       → node scripts/sprint-board.mjs summary → Sprint Complete, stop

# 5. Optional parallel tracks
node scripts/sprint-board.mjs plan --json --max-parallel 3
# -> execute independent tracks via model-native tool calls
```

### Task Pick Strategy

- Priority order: P0 > P1 > P2 > P3
- Tie-breaker: earliest creation date
- Skip tasks requiring unavailable external resources
- The `next --json` output is the execution trigger — not manual inspection of the board

---

## Strategic Decomposition

When the user's goal is high-level or vague — e.g. "bring this to commercial quality", "make this production-ready", "get this ready to ship" — a direct jump to tactical tasks is premature. The goal must first be decomposed into concrete dimensions before the normal sprint loop begins.

### Detecting Strategic vs Tactical Goals

A goal is **strategic** when it:
- Names a desired state rather than a specific change (e.g. "production-ready" vs "add rate limiting to the auth endpoint")
- Spans multiple independent quality axes simultaneously
- Cannot be expressed as a single bounded task without loss of scope

A goal is **tactical** when it names a concrete, bounded change. Tactical goals enter the normal Decision Loop directly.

If ambiguous, treat the goal as strategic. A false positive costs one decomposition cycle; a false negative produces an incomplete sprint.

### Parallel Dimension-Scan Phase

When a strategic goal is detected:

1. **Determine dimensions from the goal.** The model identifies which quality axes are implicated by examining the goal statement, the codebase state, and the intended users or operators. Dimensions are not drawn from a fixed list — they emerge from what the goal actually demands. Each dimension must be independent: it has its own failure modes, its own evidence, and its own remediation space.

2. **Launch concurrent dimension-scan sub-agents.** Assign one sub-agent per dimension. Each sub-agent receives:
   - Its dimension name and a goal-derived framing of what "done" looks like for that dimension
   - The relevant file paths and codebase context for that dimension
   - An independent constraint set specific to its dimension
   - A mandate to perform a current-state audit: assess actual state, identify gaps, and produce concrete findings

   Concurrency follows the same Concurrency Contract as the rest of the protocol: model-native tool orchestration by default. The experimental parallel runner (`va-parallel-runner.mjs`) requires explicit human opt-in. If model-native concurrency is unavailable, serialize the dimension scans — the independence constraint still holds; just run them sequentially without letting earlier results influence later ones.

3. **Constraint: no dimension may consult another dimension's findings during the scan.** Independence is the source of value. Cross-contamination produces correlated blind spots.

4. **Each sub-agent returns a structured audit report:**

   ```
   Dimension: <name>
   Current state: <honest assessment>
   Gaps:
     - CRITICAL: <finding> — <concrete remediation>
     - WARNING: <finding> — <concrete remediation>
     - PASS: <finding>
   Proposed tasks: <ordered list of concrete, bounded tasks>
   ```

### Convergence Step

After all dimension scans complete:

1. Aggregate all proposed tasks from all dimensions into a single candidate backlog.
2. Deduplicate tasks that address the same underlying gap from different angles — keep the most precise formulation.
3. Assign priorities based on: severity of gap (CRITICAL > WARNING), cross-dimension leverage (a task that unblocks multiple dimensions rises), and irreversibility (state that becomes harder to fix later rises).
4. Produce a prioritized backlog of concrete, bounded tasks ready to enter the normal sprint loop.
5. Record the decomposition in `run-journal.md` using this structure:

   ```
   Strategic decomposition: <goal statement>
   Dimensions scanned: <list>
   Aggregate finding: <one sentence per dimension — CRITICAL/WARNING/PASS>
   Priority rationale: <how the final ordering was determined>
   Backlog tasks added: <count and IDs>
   ```

### Transition Back to Tactical Loop

After convergence, the sprint backlog is populated with concrete tasks. The normal Decision Loop resumes from the top. No special mode persists — strategic decomposition is a one-time bootstrap phase triggered by goal type, not a recurring state.

> **Guard**: If the convergence step cannot reduce the candidate backlog to a finite ordered list, the goal scope is too large for one sprint. Partition the goal into sequential milestones and decompose only the first milestone.

---

## Concurrency Contract

Parallel execution is encouraged when tasks are independent.

Rules:

1. Let the manager agent decide concurrency dynamically at runtime.
2. Parallelize where dependency graph allows; serialize where it does not.
3. Use quality gates as synchronization barriers before state promotion.
4. Never bypass acceptance to "speed up" parallel tracks.
5. Record concurrency decisions and tradeoffs in `run-journal.md`.

When planning concurrency, produce a machine-readable plan:

```json
{
  "primaryTaskId": "AP-001",
  "parallelTracks": ["AP-002", "AP-003"],
  "dependencyGraph": {
    "AP-001": [],
    "AP-002": [],
    "AP-003": ["AP-002"]
  },
  "syncPoints": ["quality-gates"]
}
```

Execution path preference:

1. Default: model-native tool orchestration + gate synchronization.
2. Experimental opt-in only (explicit human request): `node scripts/va-parallel-runner.mjs spawn --plan-file ...`.

---

## State Update Contract

Use deterministic updates only:

```bash
node scripts/sprint-board.mjs update --id AP-001 --state "In Progress"
node scripts/sprint-board.mjs journal --task AP-001 --summary "what changed"
```

Rules:

1. Do not hand-edit generated rows in `docs/todo/sprint.md`.
2. Update `.va-auto-pilot/sprint-state.json` through CLI whenever possible.
3. Keep `run-journal.md` append-only.
4. When marking a task `Failed`, record a pitfall entry alongside the state update:
   ```bash
   node scripts/sprint-board.mjs update --id AP-001 --state "Failed" \
     --failure-type <gate|acceptance|review> --attempted "..." --hypothesis "..."
   node scripts/sprint-board.mjs pitfall --task AP-001 \
     --failure-type <gate|acceptance|review> --attempted "..." --hypothesis "..." \
     [--missing-context "..."]
   ```
   The pitfall entry is the durable, queryable record. Resolve it when the failure is fixed:
   ```bash
   node scripts/sprint-board.mjs pitfall --resolve PF-001 --resolution "..."
   ```

---

## Delegation Contract

Delegation is a CLI-driven sequence: pick task, move state, delegate, gate, commit. Every manager action maps to a deterministic command.

### Delegation Invariants

The following invariants must hold for every delegation. The manager decides ordering and concurrency; the invariants are non-negotiable.

- **Before delegation begins**, the task must be in `In Progress` state.
- **Before delegation begins**, unresolved pitfalls must be queried and matching entries injected into the delegation prompt.
- **Before commit**, all quality gates defined in the Quality Gates section must pass.
- **After completion**, state and journal must be updated to reflect the outcome.
- **On failure**, a pitfall entry must be recorded alongside the state change to `Failed`.

Reference commands (satisfy the invariants above):

```bash
node scripts/sprint-board.mjs next --json
node scripts/sprint-board.mjs update --id AP-XXX --state "In Progress"
node scripts/sprint-board.mjs pitfall --list --unresolved
# delegate to sub-agent (see Delegation Prompt below)
# Run project-specific quality gates (see Quality Gates section)
# If .va-auto-pilot/config.yaml has a qualityGate section, run gates from there
# Otherwise fall back to defaults based on project type detection.
# Unknown stacks fail closed until qualityGate commands are configured.
# Example (TypeScript): npm run check:all && node scripts/sprint-board.mjs review
# Example (Godot): godot --headless --script tests/validate_all_scripts.gd && node scripts/sprint-board.mjs review
node scripts/sprint-board.mjs update --id AP-XXX --state "Done"
node scripts/sprint-board.mjs journal --task AP-XXX --summary "what changed and why"
# on failure:
node scripts/sprint-board.mjs update --id AP-XXX --state "Failed"
node scripts/sprint-board.mjs pitfall --task AP-XXX \
  --failure-type <gate|acceptance|review> --attempted "..." --hypothesis "..."
```

### Delegation Prompt

The prompt sent to a sub-agent must contain at least these sections:

1. **Task ID and objective** — the WHAT, from `next --json` output
2. **Relevant file paths** — scope the sub-agent's workspace
3. **Hard constraints** — architecture, security, naming, limits. If `pitfall --list --unresolved` returned entries matching this task (by ID, failure type, or keyword overlap), include them verbatim under a `Known pitfalls to avoid` heading
4. **Completion gates** — "Pass all gates defined in the Quality Gates section of this protocol."
5. **No-how clause** — "Do not prescribe implementation steps. Decide your own path to satisfy the objective and pass the gates."

The manager defines WHAT must be true and HOW to verify it. The sub-agent decides HOW to make it true.

---

## Quality Gates

Quality gates are **pluggable** — each project defines its own gate commands. The protocol defines the gate *types* and *semantics*; the project provides the *commands*.

### Gate Configuration

Projects declare their gates in `.va-auto-pilot/config.yaml` under `qualityGate` (or fall back to recognized stack defaults):

```yaml
# .va-auto-pilot/config.yaml
gates:
  build:
    command: "npm run check:all"          # TypeScript default
    required: true
    description: "Build and static quality check"
  review:
    command: "node scripts/sprint-board.mjs review"
    required: true
    description: "Code review"
  acceptance:
    command: "npm run validate:distribution"
    required: false
    description: "Distribution validation"
  eval:
    command: "node scripts/eval-fixtures.mjs"
    required: false
    description: "Fixture or rubric evaluation"
```

Unknown stacks are fail-closed. The scaffolded commands must exit non-zero until the manager investigates the project and writes real `qualityGate` commands. `va-auto-pilot init --allow-placeholder-gates` exists only for scaffold experiments where non-blocking TODO gates are intentional.

Adaptive gates are agent-maintained. Resolved pitfalls may leave historical
placeholder gates behind; the manager should audit them with
`auto-pilot gates audit` and use `auto-pilot gates maintain --apply` to downgrade
resolved weak placeholders to advisory. Unresolved weak gates remain risk
signals until the pitfall is resolved or a real command is configured.
Constraint YAML synthesized from a resolved pitfall is marked `probation` and is
reported but not injected as a hard rule. Curated constraint sets remain active;
promotion or retirement of a learned rule is an explicit governance decision.

#### Example: TypeScript Project (default)

```yaml
gates:
  build:
    command: "npm run check:all"
    required: true
  review:
    command: "node scripts/sprint-board.mjs review"
    required: true
  acceptance:
    command: "npm run validate:distribution"
    required: false
```

See [quality-gate-examples.md](./quality-gate-examples.md) for stack-specific examples (Godot, Python, mixed stacks, validation scripts, and the Fate Weaver learning sequence). See [eval-gates.md](./eval-gates.md) for eval output semantics.

### Gate Resolution

1. If `.va-auto-pilot/config.yaml` has `qualityGate` → use it
2. If `package.json` exists with `check:all` script → use TypeScript defaults
3. If `project.godot` exists → use Godot defaults
4. If another recognized stack exists (`Cargo.toml`, `go.mod`, `pyproject.toml`, etc.) → use that stack's defaults
5. Otherwise → fail closed with a message requiring explicit `qualityGate` configuration before delegation

### Gate Semantics

Regardless of configuration, all gates share these semantics:

#### Gate: Build (required)

The build gate verifies that all source code compiles/parses without errors. This is the **minimum bar** — nothing proceeds without it.

- **TypeScript**: `npm run check:all` (tsc + biome + vitest)
- **GDScript**: `godot --headless --script tests/validate_all_scripts.gd`
- **Python**: `python -m py_compile + ruff/mypy`
- **Rust**: `cargo check`

#### Gate: Review (required)

```bash
node scripts/sprint-board.mjs review
```

Review findings policy:

- `CRITICAL` / `BUG` / `VIOLATION`: must fix and re-review
- style-only nits: optional, non-blocking

This gate is **technology-agnostic** — codex can review any language.
If the configured review runner times out, crashes, returns no output, or remains unstructured after retry, the review gate fails by default. Optional `qualityGate.reviewFallbackCommand` runs only on hard primary failure (missing binary / crash / timeout) so generic agents can keep the loop moving with deterministic local checks — it is continuity, not multi-perspective proof. Advisory review is opt-in only (`qualityGate.allowAdvisoryReview: true`, `qualityGate.reviewRequired: false`, or `qualityGate.review.required: false`) and must be treated as a conscious governance downgrade. See `docs/operations/quality-gate-examples.md` → Review gate for generic CLI agents.

#### Gate: Acceptance (optional)

Project-specific acceptance criteria. Examples:

- **TypeScript**: `npm run validate:distribution`
- **Godot**: `godot --headless --quit-after 120` (runs 120 frames without crash)
- **API service**: `curl -sf http://localhost:3000/health`

Pass criteria:

- MUST assertions: 100% pass
- SHOULD assertions: >= 80% pass

### Fallback Defaults by Project Type

| Detected file | Project type | Default build gate |
|---------------|-------------|-------------------|
| `package.json` | Node/TypeScript | `npm run check:all` |
| `project.godot` | Godot | `godot --headless --quit` |
| `Cargo.toml` | Rust | `cargo check && cargo test` |
| `pyproject.toml` / `setup.py` | Python | `python -m pytest` |
| `go.mod` | Go | `go build ./... && go test ./...` |

### Adaptive Quality Gates

Static gate configuration covers known scenarios. But the manager agent encounters unknown technology stacks and novel failure patterns. The adaptive protocol handles both.

#### Principle: Gates are Learnable

Quality gates are not only configured — they are **discovered, created, and refined** by the manager agent during execution. The gate configuration file is a living document that the agent updates.

#### Trigger 1: Unknown Technology Stack (Setup Phase)

When the manager encounters a project with no configured `qualityGate` and no recognized project files, it must **investigate before delegating**:

```
1. Scan project root for build system indicators:
   - Makefile, CMakeLists.txt, build.gradle, mix.exs, Gemfile, etc.
2. Read README/CONTRIBUTING for build instructions
3. Ask: "What command verifies this project compiles without errors?"
4. Ask: "What command runs tests?"
5. Update `.va-auto-pilot/config.yaml` with discovered `qualityGate` commands
6. Record reasoning in run-journal.md
```

The manager does NOT skip quality gates for unknown stacks — it **creates them first**.

#### Trigger 2: Failure Pattern → New Gate (Runtime Learning)

When a task fails due to a bug category not caught by existing gates, the manager must:

```
1. Classify the failure:
   - Compilation error not caught → build gate is incomplete
   - Runtime crash → need runtime stability gate
   - Type error → need stricter type checking gate
   - Resource reference broken → need asset integrity gate
   - Performance regression → need perf benchmark gate

2. Create or update the gate:
   gates:
     asset-integrity:                          # ← NEW gate
       command: "godot --headless --script tests/validate_resources.gd"
       required: true
       description: "Added after broken .tscn references caused crash (PF-003)"
       added_by: "auto-pilot learning"
       triggered_by: "pitfall PF-003"

3. Record in pitfall + run-journal:
   pitfall: "GDScript .get() returns Variant → Godot 4.6 treats as error"
   resolution: "Added build gate: validate_all_scripts.gd"
   learning: "config.yaml qualityGate updated with new gate"
```

#### Trigger 3: Manager Judgment (Proactive)

The manager should proactively add gates when it recognizes risk patterns:

| Pattern observed | Gate to add |
|-----------------|-------------|
| Agent generates file references (paths, imports) | Asset/import integrity check |
| Project uses dynamic typing (GDScript, Python, JS) | Stricter lint/type check |
| Project has UI/visual output | Screenshot comparison gate |
| Project has network/API calls | Integration test gate |
| Project mixes multiple languages | Per-language build gate |
| Large delegation (>5 files changed) | Smoke test gate |

The manager adds these **before delegating**, not after failure.

#### Gate Lifecycle

```
Discovery → Creation → Validation → Refinement → Retirement

1. Discovery: Agent encounters new stack or failure pattern
2. Creation: Agent writes gate command + adds to yaml
3. Validation: Gate runs and catches real issues (or false positives)
4. Refinement: Gate command adjusted based on experience
5. Retirement: Gate removed when no longer relevant (stack changed)
```

#### Cross-Project Gate Inheritance

When a manager starts a new project of a known type, it should check if similar projects have proven `qualityGate` settings and inherit them:

```
New Godot project → check existing Godot projects for qualityGate settings
  → Inherit: validate_all_scripts.gd + runtime stability + asset integrity
  → Skip: project-specific acceptance tests
```

This is how the system **accumulates knowledge** — not in documentation, but in executable gate configurations.

---

## Multi-Perspective Review

### Design Philosophy

Perspectives are not predetermined roles — they are views from specific constraint intersections that expose distinct failure modes. The right perspectives emerge from identifying real constraints and anchors first. A fixed list of roles is valid only if each role was derived from the constraint and anchor analysis for this task and each exposes failure modes the others miss.

When a review stall occurs, the problem is most often in anchor or perspective selection, not the implementation. See [When Review Cycles Stall](#when-review-cycles-stall) for the bounded procedure governing anchor revision.

### Dynamic Perspective Selection

The model determines which perspectives to apply for each task.

**Step 1: Identify real constraints**

What hard boundaries govern this task? Examples: security invariants, performance budgets, API contracts, backward compatibility, data privacy, state-machine integrity.

**Step 2: Identify anchors**

What must remain true after this change? An anchor is the invariant that cannot be violated. Anchor selection determines whether subsequent analysis converges. A weak or misspecified anchor is the most common cause of false assurance.

> **Guard**: If no clear anchor can be identified after applying the constraint list, stop and request human clarification before beginning review. Do not start a review cycle without a confirmed anchor.

**Step 3: Let perspectives emerge**

Given the constraints and anchors, ask: which expert views would expose the most critical failure modes? Perspectives must be specific to this task, not generic role labels. Each must probe failure modes the others miss.

**Perspective count heuristic**: Start with 2. Add one perspective for each: external API surface affected, security boundary crossed, persistent state modified, multiple components touched. Cap at 5.

Examples — table entries are category-level sketches; instantiate each with task-specific framing in the actual review prompt (e.g., not "Threat modeler" but "Threat modeler focused on the new token refresh endpoint's exposure to replay attacks"):

| Change type | Possible perspectives |
|-------------|----------------------|
| CLI tool update | Correctness auditor, API consumer, Operator (failure modes) |
| Auth/security change | Threat modeler, Compliance reviewer, Regression auditor |
| Data pipeline | Data integrity auditor, Privacy/compliance, SRE |
| UX feature | Accessibility engineer, Performance auditor, Product consistency |
| Protocol/spec change | Adopter (downstream impact), Implementer (ambiguity), Adversarial reader |

**Step 4: Anchor-grounded review prompt**

Every review prompt must explicitly state:

1. What changed and why (the git diff scope and design rationale)
2. The hard constraints that apply
3. The anchor — the invariant that must hold
4. The reviewer's specific perspective and the concrete failure modes they are probing

### Review Completion Condition

Review is complete when all of the following are true:
- All selected perspectives have been applied
- No `CRITICAL`, `BUG`, or `ANCHOR VIOLATION` findings remain open
- Every `WARNING` / `RISK` finding has a recorded disposition (fixed or explicitly accepted with rationale)

**Iteration cap**: If `CRITICAL` findings persist after 3 complete review cycles (each cycle = all perspectives re-applied), stop and escalate to human.

### Finding Policy

- `CRITICAL` / `BUG` / `ANCHOR VIOLATION`: must fix, then re-run the full perspective set before proceeding
- `WARNING` / `RISK`: record and decide — fix or document accepted risk
- Style / preference: non-blocking

### When Review Cycles Stall

If the review completion condition is met but the model cannot confirm it with confidence:

1. Re-examine the anchor — it may be too weak or misspecified
2. Re-examine the constraint set — a missing constraint is the most common source of false assurance
3. Add a perspective that directly challenges the anchor
4. If the completion condition still cannot be confirmed after three re-anchoring attempts, treat remaining uncertainty as irreducible and escalate to human

---

## Sprint Completion Gate

Before declaring any sprint Done, an independent adversarial review must run. This gate exists to prevent self-validation bias: the sprint team, having implemented the changes, is structurally blind to certain failure modes. A fresh-context adversarial reviewer closes that gap.

### Reviewer Setup

Launch a new sub-agent with no prior context about what was done this sprint. The reviewer receives only:

1. The git diff of the sprint (all changes since the sprint started)
2. The current state of every file that was modified

The reviewer must not be told what the sprint intended to accomplish. The diff is the only evidence.

### Perspective Assignment

The manager must assign a specific adversarial perspective based on what the sprint actually changed — not a generic "code reviewer". The perspective is derived by examining the diff and asking: who would be most damaged by a latent flaw here, and what would they be watching for?

Examples:
- Sprint added a new CLI command → perspective: "a developer who will automate this command in a CI pipeline and has been burned by silent failures before"
- Sprint modified auth or token handling → perspective: "a security engineer doing a post-incident review after a credentials leak"
- Sprint changed a public-facing protocol or spec → perspective: "an adopter who built a tool on top of this protocol and just had a dependency break without warning"
- Sprint updated documentation or guidelines → perspective: "a new team member following these instructions on their first day, with no existing context to fill gaps"

The perspective must name a real stake the reviewer has in the output. "Adversarial reviewer" is not a valid perspective — it is a structural role. The perspective specifies the viewpoint from which the reviewer attacks.

### Reviewer Mandate

The adversarial reviewer must:

1. Read the diff and changed files with the assigned perspective held in mind
2. Assume the sprint team was competent but blind to something specific — find what
3. Return a structured finding report:

   ```
   Perspective: <specific assigned perspective>
   CRITICAL findings:
     - <finding> — <why it matters from this perspective> — <what must change>
   WARNING findings:
     - <finding> — <risk> — <recommended action>
   PASS:
     - <what was checked and found sound>
   ```

### Gate Enforcement

- **CRITICAL findings block sprint completion.** They re-enter the task loop as new `Backlog` tasks tagged with the sprint ID, and the sprint state remains `In Progress` until resolved.
- **WARNING findings** must have a recorded disposition: fixed, or explicitly accepted with rationale written into `run-journal.md`.
- **PASS with no CRITICAL or unresolved WARNING** = gate clears. Sprint may advance to Done.

> **Guard**: The adversarial reviewer must be a genuinely fresh context — it must not have access to the sprint team's reasoning, intent statements, or prior chat. If the review is being run by the same agent that implemented the sprint, the agent must reason exclusively from the diff and changed files, deliberately suppressing implementation knowledge. Flag in `run-journal.md` when this condition is met imperfectly. **When flagged, treat all PASS findings from that review as WARNING pending a genuinely fresh-context review** — the flag is not a disclosure, it is a control downgrade.

---

## Commit Policy

Commit immediately after required gates pass.

Rules:

1. One completed task = one commit (parallel tracks commit independently after gates)
2. Stage only task-related files
3. Commit message describes intent
4. Never force push unless explicitly approved
5. Never commit secrets

---

## Stop Conditions

Stop and wait for human when:

1. Backlog is empty
2. Same task failed three times
3. External resources are required
4. High-impact architecture decision is needed
5. Destructive operation is required

Record stop reason in `sprint-state.json` and `run-journal.md`.

---

## Bootstrap Checklist

- [ ] `.va-auto-pilot/sprint-state.json` exists and backlog is populated
- [ ] `docs/todo/sprint.md` can be rendered via `scripts/sprint-board.mjs`
- [ ] `docs/todo/human-board.md` exists
- [ ] `docs/todo/run-journal.md` exists
- [ ] `scripts/test-runner.ts` runs
- [ ] at least one file under `test-flows/`
- [ ] review command is runnable

For public distribution repositories, also verify:

- [ ] `website/` exists and reflects the current protocol
- [ ] `skills/va-auto-pilot/` exists and links are shareable
- [ ] GitHub Pages workflow is present

Once all required items are true, start the loop.
