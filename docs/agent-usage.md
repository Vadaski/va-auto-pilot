# va-auto-pilot -- Agent 使用指南

> 一句话：CLI-first 自主多 Agent 工程执行引擎。把高维目标拆解成 Sprint，管理 Agent 委派、并行执行、质量门控、失败复盘。
>
> **职责边界**：
> - IS: Sprint 管理（看板状态机）、任务委派（CLI-driven delegation）、并行执行（va-parallel-runner）、质量门控（build/review/acceptance）、失败复盘（pitfall guide）、多视角 Review、战略分解（Strategic Decomposition）、Colony 桥接（ColonyBridge）
> - IS NOT: 任务调度协议（用 va-agent-protocol）、任务分解（用 va-wish-engine）、看板中枢（用 va-hub）、具体工具实现（用 va-tool-*）

**Version**: `0.1.1`
**Node requirement**: `>=20`
**Main scripts**: `sprint-board.mjs`, `va-parallel-runner.mjs`, `smoke-test-runner.mjs`

---

## 0. 前置条件

```bash
# Clone or navigate to the project
cd /path/to/va-auto-pilot

# Install dependencies
npm install

# Verify installation
node ./bin/va-auto-pilot.mjs --help
node ./scripts/sprint-board.mjs --help
node ./scripts/va-parallel-runner.mjs --help
```

Ensure at least one CLI agent is installed and on `$PATH` (needed for delegation and ColonyBridge):

```bash
# Claude Code CLI
claude --version

# OpenAI Codex CLI
codex --version

# Gemini CLI
gemini --version
```

### Required file structure

Before running the loop, verify these files exist:

```
.va-auto-pilot/
  config.yaml              # Project configuration (sprint paths, quality gates)
  sprint-state.json        # Machine source of truth for tasks
  pitfalls.json            # (auto-created) Failure memory
docs/todo/
  sprint.md                # Generated board view (do NOT hand-edit)
  human-board.md           # Human writes objectives here
  run-journal.md           # Append-only execution memory
```

If bootstrapping a new project, use `va-auto-pilot init`:

```bash
node ./bin/va-auto-pilot.mjs init /path/to/target-project
```

### Environment variables (all optional)

| Variable | Default | Description |
|----------|---------|-------------|
| `AUTO_PILOT_SPRINT_STATE_FILE` | `.va-auto-pilot/sprint-state.json` | Override state file path |
| `AUTO_PILOT_SPRINT_BOARD_FILE` | `docs/todo/sprint.md` | Override board file path |
| `AUTO_PILOT_RUN_JOURNAL_FILE` | `docs/todo/run-journal.md` | Override journal file path |
| `VA_TASK_ID` | (set by runner) | Injected into subprocess env by va-parallel-runner |

---

## 1. 烟雾测试 (< 30 秒)

```bash
# 1. Verify CLI is runnable
node ./bin/va-auto-pilot.mjs --help
# Expected: help output with "init", "upgrade" subcommands

# 2. Verify sprint-board commands work
node scripts/sprint-board.mjs summary
# Expected:
# Sprint Summary
# Backlog    : 0
# In Progress: 0
# Review     : 0
# Testing    : 0
# Failed     : 0
# Done       : 15
# Pitfalls   : 0 unresolved (0 total)
# Next Task  : none (backlog empty)
# Parallel   : none

# 3. Verify parallel runner is runnable
node scripts/va-parallel-runner.mjs --help
# Expected: help output with plan shape and options

# 4. Verify all quality gates pass
npm run check:all
# Expected: check + check:sprint + check:units + check:cli-flows + validate:distribution all pass
```

**SUCCESS**: All four commands produce expected output without errors.

**FAILURE**: If `npm run check:all` fails, run each sub-check individually to isolate the issue:
```bash
npm run check          # bin/va-auto-pilot.mjs --help
npm run check:sprint   # sprint-board.mjs summary
npm run check:units    # node:test unit tests
npm run check:cli-flows # YAML-defined CLI flow tests
npm run validate:distribution # distribution structure check
```

---

## 2. 主 Agent 外环（Orchestrated Mode）

会话里的 frontier agent 是 **Manager**；`scripts/auto-pilot.mjs` 是 **Executor**（每相位退出）。

```bash
node scripts/auto-pilot.mjs orchestrate init --manager-surface cursor
node scripts/auto-pilot.mjs orchestrate plan
node scripts/auto-pilot.mjs observe --json                    # 全局快照
node scripts/auto-pilot.mjs orchestrate approve-plan            # 显式批准（必须）
node scripts/auto-pilot.mjs orchestrate dispatch
node scripts/auto-pilot.mjs orchestrate await-workers           # 并行执行 queued tracks
node scripts/auto-pilot.mjs orchestrate approve-commit --tasks AP-062,AP-063
node scripts/auto-pilot.mjs orchestrate commit
node scripts/auto-pilot.mjs orchestrate journal
```

- 战术指令：`intervene` → `.va-auto-pilot/orchestration/directives.json`
- 战略意图：`docs/todo/human-board.md`
- 无人值守：`orchestrate run-unattended --waive-approvals` 或 `auto-pilot-loop.mjs --max-cycles 50`

详见 `docs/operations/va-auto-pilot-protocol.md` → Orchestrated Execution Mode。

---

## 3. 核心流程

### TC-01: Sprint Board -- 查看摘要和下一个任务

```bash
# View sprint summary (state counts + next task + parallel candidates)
node scripts/sprint-board.mjs summary

# Get next actionable task (human-readable)
node scripts/sprint-board.mjs next
# Expected: "AP-016 start-task\nImplement feature X"
# Or: "No actionable task found." if backlog is empty

# Get next task as JSON (for programmatic consumption)
node scripts/sprint-board.mjs next --json
# Expected: JSON with { state, action, task: { id, title, priority, ... } }
# Or: "null" if no actionable task
```

**`next` action values**:
- `start-task` -- task is in Backlog, ready to begin
- `continue-implementation` -- task is In Progress
- `run-review` -- task is in Review state
- `run-acceptance` -- task is in Testing state
- `fix-and-retest` -- task is Failed, needs root cause fix

**Task pick priority**: Failed > Testing > Review > In Progress > Backlog. Within each state: P0 > P1 > P2 > P3, then earliest creation date.

---

### TC-02: Sprint Board -- 添加和更新任务

```bash
# Add a new task to backlog
node scripts/sprint-board.mjs add \
  --title "Implement retry logic for API calls" \
  --priority P1 \
  --source "code review finding"
# Expected:
# Task added: AP-016
# State file: .va-auto-pilot/sprint-state.json
# Board file: docs/todo/sprint.md

# Add a task with dependencies
node scripts/sprint-board.mjs add \
  --title "Integration tests for retry logic" \
  --priority P2 \
  --depends-on AP-016
# Expected: Task added: AP-017

# Move task to In Progress
node scripts/sprint-board.mjs update --id AP-016 --state "In Progress"
# Expected: Task updated: AP-016 -> In Progress
# Side effect: startedAt is auto-set on first transition to In Progress

# Mark task as Done
node scripts/sprint-board.mjs update --id AP-016 --state Done \
  --verification "All tests pass, review complete"
# Expected: Task updated: AP-016 -> Done
# Side effect: completedAt is auto-set

# Mark task as Failed with structured failure metadata
node scripts/sprint-board.mjs update --id AP-017 --state Failed \
  --failure-type gate \
  --attempted "npm run check:all" \
  --hypothesis "TypeScript compilation error in new test file"
# Expected: Task updated: AP-017 -> Failed
# Side effects: failCount incremented, lastFailedAt set, failureDetail recorded
```

---

### TC-03: Sprint Board -- 生成并行计划

```bash
# Generate a parallel execution plan
node scripts/sprint-board.mjs plan --json --max-parallel 3
# Expected JSON:
# {
#   "generatedAt": "2026-02-27T...",
#   "primaryTaskId": "AP-016",
#   "primaryAction": "start-task",
#   "parallelTracks": ["AP-018", "AP-019"],
#   "dependencyGraph": { "AP-016": [], "AP-018": [], "AP-019": [] },
#   "syncPoints": ["quality-gates"]
# }

# Human-readable plan output
node scripts/sprint-board.mjs plan
# Expected:
# Primary    : AP-016 (start-task)
# Parallel   : AP-018, AP-019
# Sync Points: quality-gates
```

**Parallel track selection rules**:
- Only Backlog tasks with satisfied dependencies are candidates
- Tasks that depend on the primary task are excluded
- Tracks are capped at `--max-parallel` (default: 2)
- Non-parallelizable actions (fix-and-retest, run-review, run-acceptance) produce empty parallel tracks

---

### TC-04: 并行执行 -- va-parallel-runner spawn

```bash
# Step 1: Save the plan to a file
node scripts/sprint-board.mjs plan --json --max-parallel 3 > /tmp/plan.json

# Step 2: Dry-run to verify commands before execution
node scripts/va-parallel-runner.mjs spawn \
  --plan-file /tmp/plan.json \
  --agent-cmd 'claude -p "Implement task {taskId} in this project"' \
  --dry-run --json
# Expected: JSON with results array, each { taskId, command, success: true, dryRun: true }

# Step 3: Execute for real
node scripts/va-parallel-runner.mjs spawn \
  --plan-file /tmp/plan.json \
  --agent-cmd 'claude -p "Implement task {taskId} in this project"' \
  --max-workers 2 \
  --track-timeout 600000
# Expected:
# Primary: AP-016
# Tracks : AP-018, AP-019
# - AP-018: PASS (exit=0, 45s)
# - AP-019: PASS (exit=0, 62s)
# Sync   : quality-gates

# Step 4: Check JSON output
node scripts/va-parallel-runner.mjs spawn \
  --plan-file /tmp/plan.json \
  --agent-cmd 'echo "done for {taskId}"' \
  --json
# Expected: JSON with { primaryTaskId, results: [...], failedTracks: [] }
```

**Key behaviors**:
- Each track runs in a subprocess via `bash -lc <command>`
- `{taskId}` in `--agent-cmd` is replaced with the track's task ID
- `VA_TASK_ID` env var is injected into each subprocess
- Tracks with per-track `command` in the plan override `--agent-cmd`
- On success (exit 0): task moves to `Review` state
- On failure (exit != 0 or timeout): task moves to `Failed` state with reason
- Logs are written to `.va-auto-pilot/parallel-runs/<taskId>.log`
- Journal entry is appended to `docs/todo/run-journal.md`

**Timeout behavior**: Default 600,000ms (10 min). On timeout, SIGTERM is sent, then SIGKILL after 5s grace period. Task is marked Failed with reason `"parallel track timed out after <ms>ms"`.

---

### TC-05: ColonyBridge 模式 (--use-colony)

ColonyBridge integrates with `va-agent-protocol` Colony for intelligent agent routing instead of raw subprocess spawn.

```bash
# Enable Colony dispatch (requires va-agent-protocol built at ../va-agent-protocol/)
node scripts/va-parallel-runner.mjs spawn \
  --plan-file /tmp/plan.json \
  --agent-cmd 'implement task {taskId}' \
  --use-colony \
  --json
```

**How ColonyBridge works**:
1. On `init()`, it dynamically imports `va-agent-protocol` from `../va-agent-protocol/dist/index.js`
2. Auto-detects available CLI agents on `$PATH` (codex, claude, gemini)
3. Creates adapters for each detected agent and registers them with a Colony
4. `dispatch()` routes through Colony (smart agent selection) instead of raw spawn
5. If Colony is unavailable or no agents detected, falls back to raw spawn silently

**Fallback behavior**:
```bash
# If va-agent-protocol is not built or not present, --use-colony falls back gracefully:
# "Warning: --use-colony requested but Colony not available. Falling back to spawn."
```

**ColonyBridge result format**: Identical to raw spawn results -- `{ taskId, command, success, exitCode, signal, durationMs, timedOut, logFile }` plus optional `evidence` field from Colony.

---

### TC-06: 质量门控执行

Quality gates are defined in `.va-auto-pilot/config.yaml` and run as part of the protocol loop.

```bash
# Gate 1: Build and static quality
npm run check:all
# Runs: check + check:sprint + check:units + check:cli-flows + validate:distribution

# Gate 2: Code review
codex review --uncommitted
# Findings policy: CRITICAL/BUG = must fix, style nits = non-blocking

# Gate 3: Acceptance
npm run validate:distribution
# Checks: package structure, required files, skill installation paths

# Full gate sequence (as used in delegation)
npm run check:all && codex review --uncommitted && npm run validate:distribution
```

**Smoke tests** (if configured in `config.yaml`):

```bash
# Run smoke tests for configured critical paths
node scripts/smoke-test-runner.mjs --config .va-auto-pilot/smoke-config.yaml \
  --screenshot-dir .va-auto-pilot/screenshots \
  --timeout 30000
# Outputs JSON GateResult with per-step pass/fail and screenshot paths
# Requires puppeteer (npm install puppeteer) -- gracefully skips if missing
```

---

### TC-07: Pitfall 失败复盘系统

```bash
# Record a pitfall when a task fails
node scripts/sprint-board.mjs pitfall \
  --task AP-017 \
  --failure-type gate \
  --attempted "npm run check:units failed on retry.test.ts" \
  --hypothesis "Missing mock for HTTP client in test setup" \
  --missing-context "retry.test.ts depends on undocumented test fixture"
# Expected: Pitfall recorded: PF-001

# List all unresolved pitfalls (run at cycle start)
node scripts/sprint-board.mjs pitfall --list --unresolved
# Expected:
# 1 entries, 1 unresolved
# PF-001 [AP-017] [gate] unresolved
#   attempted: npm run check:units failed on retry.test.ts
#   hypothesis: Missing mock for HTTP client in test setup
#   missingContext: retry.test.ts depends on undocumented test fixture

# List as JSON (for programmatic consumption)
node scripts/sprint-board.mjs pitfall --list --unresolved --json

# Resolve a pitfall after fixing the issue
node scripts/sprint-board.mjs pitfall \
  --resolve PF-001 \
  --resolution "Added HTTP client mock to test/fixtures/setup.ts"
# Expected: Pitfall resolved: PF-001

# Reset fail count after fixing a failed task
node scripts/sprint-board.mjs update --id AP-017 --state "In Progress" --reset-fail-count
# Expected: Task updated: AP-017 -> In Progress (failCount reset to 0)
```

**Pitfall lifecycle**: Record on failure -> Query at cycle start -> Inject into delegation prompts -> Resolve after fix. Valid failure types: `gate`, `acceptance`, `review`.

---

### TC-08: 多视角 Review

Multi-perspective review is a protocol-level concept, not a CLI command. The manager agent executes it.

```bash
# Step 1: Task reaches Review state
node scripts/sprint-board.mjs update --id AP-016 --state Review

# Step 2: Manager identifies constraints, anchors, perspectives
# (This is model reasoning, not a CLI command)

# Step 3: Run code review gate
codex review --uncommitted
# Parse output for CRITICAL/BUG/WARNING findings

# Step 4: If all perspectives clear, advance to Testing
node scripts/sprint-board.mjs update --id AP-016 --state Testing

# Step 5: Run acceptance
npm run validate:distribution

# Step 6: If acceptance passes, mark Done
node scripts/sprint-board.mjs update --id AP-016 --state Done \
  --verification "3 perspectives: correctness auditor, API consumer, operator. 0 CRITICAL, 2 WARNING accepted."
```

**Perspective count heuristic**: Start with 2. Add one for each: external API surface affected, security boundary crossed, persistent state modified, multiple components touched. Cap at 5.

**Review completion**: All perspectives applied + no CRITICAL/BUG/ANCHOR VIOLATION open + all WARNING dispositioned. Iteration cap: 3 cycles before human escalation.

---

### TC-09: Journal 记录

```bash
# Append a journal entry after completing a task
node scripts/sprint-board.mjs journal \
  --task AP-016 \
  --summary "Implemented retry logic with exponential backoff" \
  --files "src/retry.ts,src/retry.test.ts" \
  --signals "setTimeout chaining pattern preferred over setInterval"
# Expected: Journal updated: docs/todo/run-journal.md

# The parallel runner also auto-appends journal entries after each run
# with track results and sync point information
```

---

### TC-10: Render 看板

```bash
# Regenerate the markdown board from sprint-state.json
node scripts/sprint-board.mjs render
# Expected: Sprint board rendered: docs/todo/sprint.md

# With custom paths
node scripts/sprint-board.mjs render \
  --state-file /tmp/test-state.json \
  --board-file /tmp/test-board.md
```

The board groups tasks by state: In Progress, Failed, Review, Testing, Done, Backlog. Each section has state-specific columns.

---

### TC-11: 完整委派循环 (Decision Loop)

This is the full cycle a manager agent executes:

```bash
# 1. Read human board (always first)
cat docs/todo/human-board.md
# Execute unchecked instructions, mark handled items [x]

# 2. Read operational memory
node scripts/sprint-board.mjs journal --view
node scripts/sprint-board.mjs pitfall --list --unresolved

# 3. Resolve next task
node scripts/sprint-board.mjs next --json
# Branch on action:
#   "start-task"                -> delegate to sub-agent
#   "continue-implementation"   -> continue delegation
#   "run-review"                -> execute multi-perspective review
#   "run-acceptance"            -> npm run validate:distribution
#   "fix-and-retest"            -> fix root cause, re-run gates

# 4. Move to In Progress
node scripts/sprint-board.mjs update --id AP-016 --state "In Progress"

# 5. Delegate to sub-agent (the agent decides HOW)
# Example: claude -p "Task AP-016: <objective>. Pass all quality gates."

# 6. Run quality gates
npm run check:all && codex review --uncommitted && npm run validate:distribution

# 7. On success: advance state + journal
node scripts/sprint-board.mjs update --id AP-016 --state Done \
  --verification "All gates pass"
node scripts/sprint-board.mjs journal --task AP-016 --summary "Implemented feature X"

# 8. On failure: record failure + pitfall
node scripts/sprint-board.mjs update --id AP-016 --state Failed \
  --failure-type gate --attempted "npm run check:units" --hypothesis "Missing import"
node scripts/sprint-board.mjs pitfall --task AP-016 \
  --failure-type gate --attempted "npm run check:units" --hypothesis "Missing import"
```

---

### TC-12: 战略分解 (Strategic Decomposition)

When the goal is high-level (e.g., "make this production-ready"), decompose first:

```bash
# 1. Detect that goal is strategic (names a desired state, not a specific change)

# 2. Identify dimensions from the goal (model reasoning)
# Example dimensions: test coverage, security, documentation, performance

# 3. Launch concurrent dimension-scan sub-agents
# Each sub-agent gets: dimension name, relevant file paths, independent constraints
# Each returns: Dimension / Current state / Gaps (CRITICAL/WARNING/PASS) / Proposed tasks

# 4. Converge: deduplicate, prioritize, produce backlog
# Add tasks via CLI:
node scripts/sprint-board.mjs add --title "Increase test coverage to 90%" --priority P1
node scripts/sprint-board.mjs add --title "Add rate limiting to API endpoints" --priority P0
node scripts/sprint-board.mjs add --title "Write deployment runbook" --priority P2

# 5. Record decomposition in journal
node scripts/sprint-board.mjs journal \
  --task STRATEGIC \
  --summary "Decomposed 'production-ready' into 3 dimensions: quality, security, ops. 3 tasks added."

# 6. Resume normal Decision Loop
node scripts/sprint-board.mjs next --json
```

---

## 3. 边界情况

### 空 Backlog -- 所有任务完成

```bash
node scripts/sprint-board.mjs next --json
# Expected: "null"
# summary output: "Next Task  : none (backlog empty)"
```

This is a stop condition. Record stop reason in journal and wait for human input.

### Backlog 全部被依赖阻塞

```bash
# All backlog tasks depend on unfinished tasks
node scripts/sprint-board.mjs next --json
# Expected: "null"
# summary output: "Next Task  : none (all backlog tasks are blocked by dependencies)"
```

### 依赖循环检测

```bash
# If tasks form a dependency cycle, plan command throws:
node scripts/sprint-board.mjs plan --json
# Expected stderr: "Error: [CYCLE_DETECTED] Dependency cycle(s) detected..."
# Exit code: 1
```

### 并行计划文件不存在

```bash
node scripts/va-parallel-runner.mjs spawn --plan-file /nonexistent/plan.json
# Expected stderr: "Error: File not found: /nonexistent/plan.json"
# Exit code: 1
```

### 空的并行计划 (0 tracks)

```bash
echo '{"primaryTaskId":"AP-001","parallelTracks":[]}' > /tmp/empty-plan.json
node scripts/va-parallel-runner.mjs spawn --plan-file /tmp/empty-plan.json
# Expected: "No parallel tracks in plan."
# Exit code: 0
```

### Track 超时

```bash
echo '{"primaryTaskId":"T1","parallelTracks":["T1"]}' > /tmp/timeout-plan.json
node scripts/va-parallel-runner.mjs spawn \
  --plan-file /tmp/timeout-plan.json \
  --agent-cmd 'sleep 999' \
  --track-timeout 2000 \
  --skip-state-update
# Expected after ~2s:
# - T1: TIMEOUT (exit=-1, 2s)
# Log file contains: "timeout after 2000ms - sending SIGTERM"
```

### 无效状态转换

```bash
# Done is terminal -- cannot move back
node scripts/sprint-board.mjs update --id AP-001 --state "In Progress"
# This succeeds at the sprint-board level (no state machine enforcement in sprint-board.mjs)
# State machine enforcement is in the PROTOCOL, not the CLI tool
# The manager agent must follow the protocol state machine
```

### Boolean flag 误用

```bash
# Boolean flags do not take values
node scripts/sprint-board.mjs summary --json false
# Expected stderr: "--json is a boolean flag and takes no value; got unexpected token 'false'..."
# Exit code: 1
```

### ColonyBridge -- va-agent-protocol 不可用

```bash
# If va-agent-protocol is not built or not at expected path:
node scripts/va-parallel-runner.mjs spawn \
  --plan-file /tmp/plan.json \
  --agent-cmd 'echo ok' \
  --use-colony
# Expected: "Warning: --use-colony requested but Colony not available. Falling back to spawn."
# Execution continues via raw subprocess spawn
```

---

## 4. 与其他 VA 工具的组合

### va-auto-pilot + va-agent-protocol (ColonyBridge)

```bash
# ColonyBridge in va-parallel-runner.mjs dynamically imports from va-agent-protocol.
# It uses Colony, CodexAdapter, ClaudeCodeAdapter, GeminiAdapter.
#
# Flow:
# 1. ColonyBridge.init() -> import va-agent-protocol -> detect CLI binaries on $PATH
# 2. Create adapters for detected agents -> colony.addAgent()
# 3. dispatch() -> colony.submitTasks() with trackToTaskUnit() conversion
# 4. Poll colony.getStatus() until task completes or times out
# 5. Convert colony result back to runner format via colonyResultToRunnerResult()
#
# Prerequisite: va-agent-protocol must be built
cd /path/to/va-agent-protocol && npm run build
# Then: --use-colony flag enables Colony dispatch in va-parallel-runner
```

### va-auto-pilot + va-hub

```bash
# va-hub's Awakener can trigger va-auto-pilot sprint tasks.
# va-hub reads its kanban board -> converts cards to TaskUnits -> dispatches via Colony.
# va-auto-pilot manages the sprint state and quality gates.
#
# They share the same task lifecycle concept but at different abstraction levels:
# - va-hub: project-level card management (backlog -> doing -> done)
# - va-auto-pilot: sprint-level task execution (Backlog -> In Progress -> Review -> Testing -> Done)
```

### va-auto-pilot + va-wish-engine

```bash
# va-wish-engine decomposes natural language into TaskUnit[].
# These can be fed into va-auto-pilot's sprint backlog:
#
# 1. va-wish-engine produces task list
# 2. For each task, add to sprint:
node scripts/sprint-board.mjs add --title "Task from wish-engine" --priority P1
# 3. va-auto-pilot's decision loop picks them up and delegates
```

### Delegation to specific CLI agents

```bash
# Delegate to Claude Code
claude -p "Task AP-016: Implement retry logic. File: src/retry.ts. \
  Acceptance: unit test passes, npm run check:all passes."

# Delegate to Codex
codex -p "Task AP-017: Write integration tests for retry. \
  File: src/retry.test.ts. Run npm run check:units to verify."

# Delegate to Gemini
gemini -p "Task AP-018: Review retry implementation for edge cases."

# Review via Codex
codex review --uncommitted
```

---

## 5. 配置参考

### .va-auto-pilot/config.yaml

```yaml
version: 1
projectPrefix: "AP"           # Task ID prefix (AP-001, AP-002, ...)

sprint:
  stateFile: ".va-auto-pilot/sprint-state.json"
  boardFile: "docs/todo/sprint.md"
  runJournalFile: "docs/todo/run-journal.md"

qualityGate:
  buildCommand: "npm run check:all"
  reviewCommand: "codex review --uncommitted"
  acceptanceTestCommand: "npm run validate:distribution"
  smokeTestCommand: "node scripts/smoke-test-runner.mjs --config"
  smokeTest:
    enabled: true              # Set to false to skip smoke tests
    timeout: 30000             # Per-path timeout in ms
    screenshotDir: ".va-auto-pilot/screenshots"
    criticalPaths: []          # Paths to YAML smoke-test config files
```

### .va-auto-pilot/sprint-state.json

```json
{
  "version": 1,
  "projectPrefix": "AP",
  "updatedAt": "2026-02-27T10:00:00.000Z",
  "tasks": [
    {
      "id": "AP-001",
      "title": "Task description",
      "priority": "P1",
      "state": "Backlog",
      "owner": "",
      "source": "human direction",
      "createdAt": "2026-02-27",
      "startedAt": "",
      "completedAt": "",
      "lastFailedAt": "",
      "failCount": 0,
      "reason": "",
      "verification": "",
      "notes": "",
      "review": {
        "implementer": "",
        "security": "",
        "qa": "",
        "domain": "",
        "architect": ""
      },
      "testing": {
        "flow": "",
        "mustPassRate": "",
        "shouldPassRate": ""
      },
      "dependsOn": [],
      "failureDetail": null
    }
  ]
}
```

### .va-auto-pilot/pitfalls.json

```json
{
  "version": 1,
  "entries": [
    {
      "id": "PF-001",
      "taskId": "AP-003",
      "failureType": "gate",
      "attempted": "npm run check:units",
      "hypothesis": "Missing import in test file",
      "missingContext": "",
      "resolution": "Added missing import",
      "resolvedAt": "2026-02-27T10:30:00.000Z",
      "createdAt": "2026-02-27T10:00:00.000Z"
    }
  ]
}
```

### Parallel plan JSON

```json
{
  "primaryTaskId": "AP-001",
  "primaryAction": "start-task",
  "parallelTracks": ["AP-002", {"taskId": "AP-003", "command": "custom-command"}],
  "dependencyGraph": {
    "AP-001": [],
    "AP-002": [],
    "AP-003": ["AP-001"]
  },
  "syncPoints": ["quality-gates"]
}
```

### sprint-board.mjs CLI 完整命令表

| Command | Description |
|---------|-------------|
| `summary` | Print state counts, next task, parallel candidates, pitfall stats |
| `next [--json]` | Return the highest-priority actionable task |
| `plan [--json] [--max-parallel N]` | Generate parallel execution plan |
| `render` | Regenerate `docs/todo/sprint.md` from state |
| `add --title T --priority P` | Add new task to Backlog |
| `update --id ID --state S` | Update task state and metadata |
| `journal --task ID --summary S` | Append journal entry |
| `pitfall --task ID --failure-type T --attempted A --hypothesis H` | Record failure |
| `pitfall --resolve PF-ID --resolution R` | Resolve a pitfall |
| `pitfall --list [--unresolved] [--json]` | List pitfall entries |

### va-parallel-runner.mjs 完整参数表

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--plan-file <path>` | string | **(required)** | Path to parallel plan JSON |
| `--agent-cmd <template>` | string | `""` | Command template, `{taskId}` replaced |
| `--max-workers <n>` | number | `4` | Max concurrent track workers |
| `--track-timeout <ms>` | number | `600000` | Per-track timeout (0 = unlimited) |
| `--log-dir <path>` | string | `.va-auto-pilot/parallel-runs` | Track log directory |
| `--state-file <path>` | string | from config | Sprint state file path |
| `--board-file <path>` | string | from config | Sprint board markdown path |
| `--journal-file <path>` | string | from config | Run journal path |
| `--skip-state-update` | flag | `false` | Do not write task state updates |
| `--dry-run` | flag | `false` | Print planned commands, do not execute |
| `--use-colony` | flag | `false` | Dispatch via va-agent-protocol Colony |
| `--json` | flag | `false` | Print result as JSON |

### Task state machine

```
Backlog -> In Progress -> Review -> Testing -> Done
                 ^                     |
                 +------ Failed <------+
```

| State | Semantics |
|-------|-----------|
| `Backlog` | Not started |
| `In Progress` | Implementation running |
| `Review` | Implementation done, quality review pending |
| `Testing` | Review passed, acceptance tests running |
| `Failed` | Gate or acceptance failed |
| `Done` | All gates passed and committed |

### Valid priorities

| Priority | Meaning | Sort weight |
|----------|---------|-------------|
| `P0` | Blocking | 0 (highest) |
| `P1` | Important | 1 |
| `P2` | Routine | 2 |
| `P3` | Optimization | 3 (lowest) |

### Valid failure types (pitfall)

| Type | When to use |
|------|-------------|
| `gate` | build/lint/typecheck/test command failed |
| `acceptance` | acceptance test or validate:distribution failed |
| `review` | code review found CRITICAL/BUG findings |

---

## 6. 注意事项 (Anti-Patterns)

### 1. 不要手动编辑 sprint.md

```bash
# WRONG: editing the generated board file directly
vim docs/todo/sprint.md  # changes will be overwritten on next render

# RIGHT: use sprint-board.mjs commands to update state
node scripts/sprint-board.mjs update --id AP-016 --state Done
# The board is auto-rendered after add/update commands
```

`docs/todo/sprint.md` is a **generated projection** of `.va-auto-pilot/sprint-state.json`. Any manual edits are overwritten by the next `render`, `add`, or `update` command.

### 2. 不要跳过质量门控来加速

```bash
# WRONG: moving directly to Done without running gates
node scripts/sprint-board.mjs update --id AP-016 --state Done

# RIGHT: run all gates before advancing
npm run check:all && codex review --uncommitted && npm run validate:distribution
# Only after all pass:
node scripts/sprint-board.mjs update --id AP-016 --state Done
```

The protocol requires build -> review -> acceptance before any commit. Skipping gates produces self-validation bias and accumulates technical debt.

### 3. 不要忘记在失败时记录 pitfall

```bash
# WRONG: just mark as Failed and move on
node scripts/sprint-board.mjs update --id AP-016 --state Failed

# RIGHT: record structured failure metadata AND create pitfall entry
node scripts/sprint-board.mjs update --id AP-016 --state Failed \
  --failure-type gate --attempted "npm run check:units" --hypothesis "Timeout in async test"
node scripts/sprint-board.mjs pitfall --task AP-016 \
  --failure-type gate --attempted "npm run check:units" --hypothesis "Timeout in async test"
```

Without pitfall records, the same failure will repeat. The pitfall guide is the durable, queryable memory that prevents recurring mistakes.

### 4. 不要在同一个 cycle 里跳过 human-board

```bash
# WRONG: go straight to next task
node scripts/sprint-board.mjs next --json

# RIGHT: always read human-board first
cat docs/todo/human-board.md
# Execute unchecked instructions immediately
# THEN resolve next task
node scripts/sprint-board.mjs next --json
```

`docs/todo/human-board.md` always overrides automatic decisions. An unchecked instruction from the human takes priority over any backlog task.

### 5. 不要在委派时规定实现步骤

```bash
# WRONG: prescribing HOW to implement
claude -p "Step 1: Create file src/retry.ts. Step 2: Add function retry(). Step 3: ..."

# RIGHT: define WHAT and verification, let the agent decide HOW
claude -p "Task AP-016: Implement retry logic for API calls. \
  Acceptance: retry(fn, maxAttempts) retries on failure with exponential backoff. \
  Unit test in src/retry.test.ts passes. npm run check:all passes. \
  Do not prescribe implementation steps. Decide your own path."
```

The manager defines WHAT must be true and HOW to verify it. The sub-agent decides HOW to make it true. This is the Delegation Contract.

### 6. 不要在三次失败后继续循环

```bash
# The protocol defines a stop condition: same task failed 3 times
# Check failCount before retrying:
node scripts/sprint-board.mjs next --json
# If task.failCount >= 3, STOP and escalate to human
# Do NOT keep retrying -- the problem likely requires human judgment

# To resume after human fixes the issue:
node scripts/sprint-board.mjs update --id AP-016 --state "In Progress" --reset-fail-count
```

### 7. 不要在并行 track 中运行有依赖关系的任务

```bash
# WRONG: manually constructing a plan with dependent tasks in parallel
echo '{"parallelTracks":["AP-016","AP-017"]}' > /tmp/bad-plan.json
# where AP-017 depends on AP-016 -- they will race and AP-017 may fail

# RIGHT: use sprint-board.mjs plan which respects the dependency graph
node scripts/sprint-board.mjs plan --json --max-parallel 3
# The planner automatically excludes tasks that depend on the primary task
```

### 8. 不要删除 human-board.md 中的内容

```bash
# WRONG: deleting processed instructions
# human-board.md rule: "Processed items must be marked [x], never deleted"

# RIGHT: mark as [x] and leave in place
# Before: - [ ] Add retry logic
# After:  - [x] Add retry logic
```

Human-written content is permanent record. Mark as processed but never delete.

### 9. 不要把 --json flag 当 key-value 用

```bash
# WRONG: --json is a boolean flag
node scripts/sprint-board.mjs next --json true
# Error: "--json is a boolean flag and takes no value"

# RIGHT: just use the flag alone
node scripts/sprint-board.mjs next --json
```

Boolean flags in the argv parser (`--json`, `--help`, `--dry-run`, `--skip-state-update`, `--use-colony`, `--list`, `--unresolved`, `--reset-fail-count`) take no value. Passing a value after them causes an error.
