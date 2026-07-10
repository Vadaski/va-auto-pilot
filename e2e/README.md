# va-auto-pilot E2E Tests

End-to-end tests that exercise the full auto-pilot loop with deterministic stubs replacing LLM calls.

## Quick Start

```bash
# Run all E2E scenarios (no LLM keys needed, ~70s total)
node e2e/run-e2e.mjs --all

# Run a single scenario
node e2e/run-e2e.mjs --scenario e2e/scenarios/01-state-machine-happy.yaml

# Run the demo walkthrough
node e2e/run-e2e.mjs --scenario e2e/scenarios/10-demo-walkthrough.yaml --demo

# Keep temp directories for debugging
node e2e/run-e2e.mjs --all --keep-tmpdir
```

## How It Works

### Architecture

```
YAML Scenario → e2e-runner → fixture-helper (isolated temp dir)
                              ↓
                    auto-pilot-loop.mjs (subprocess)
                              ↓
                    deterministic-agent.mjs (replaces Claude/Codex)
                    deterministic-reviewer.mjs (replaces codex review)
                              ↓
                    observers read state files
                              ↓
                    assert must/should → PASS/FAIL
```

Each scenario:
1. Creates an isolated temp directory with a minimal Node.js project
2. Writes sprint state, config, human board, pitfalls
3. Spawns `auto-pilot-loop.mjs` with `--no-colony --agent-template` pointing at stubs
4. Observes the resulting state files (sprint-state.json, run-journal.md, pitfalls.json)
5. Evaluates structural assertions

### Why Stubs, Not Real LLMs

- **Deterministic**: same input → same output, every time
- **Fast**: <15s per scenario (vs minutes with real LLMs)
- **Free**: no API costs
- **CI-friendly**: no flaky tests from LLM variability

The stubs exercise the **exact same code path** as real agents — `ColonyBridge.dispatchViaSpawn()`, gate execution, and state transitions. Plain templates are parsed into argv and spawned directly; templates that require shell syntax use the controlled shell fallback.

### Switching to Real LLMs

To test with a real LLM instead of stubs:

```yaml
run:
  agent_template: 'claude -p --output-format text "Implement task {taskId} in this project"'
  flags: ["--no-colony", "--no-commit", "--no-parallel", "--max-cycles", "5", "--skip-sprint-review"]
  # Remove AGENT_BEHAVIOR env var
```

When using real LLMs, rely on **structural assertions** only (`state_after`, `pitfall_count`, `journal_signal`) — never assert on exact text output.

## Scenario YAML Schema

```yaml
name: "Scenario Name"
description: "What this tests"

setup:
  fixture: minimal-node          # Fixture project name
  agent_behavior: pass           # pass | fail | timeout
  review_behavior: pass          # pass | fail | fail-critical
  sprint_state:
    projectPrefix: E2E
    tasks:
      - { id: E2E-001, title: "...", priority: P1, state: Backlog }
  human_board: |
    # Human Board
    ## Instructions
    - [ ] Do something
  pitfalls:
    entries: []
  config: |                       # optional complete config.yaml override
    qualityGate:
      buildCommand: "false"

run:
  args: ["scripts/auto-pilot-loop.mjs"]
  flags: ["--no-colony", "--no-commit", "--no-parallel", "--max-cycles", "5"]
  env: {}

assert:
  must:
    - { type: exit_code, value: 0 }
    - { type: state_after, task: E2E-001, field: state, value: Done }
  should:
    - { type: all_gates_passed }
```

### Multi-Step Scenarios

For testing behavior across multiple cycles (e.g., fail then retry):

```yaml
steps:
  - label: "first attempt fails"
    setup: { agent_behavior: fail }
    run: { ... }
    assert: { must: [...] }

  - label: "retry succeeds"
    setup: { agent_behavior: pass }
    run: { ... }
    assert: { must: [...] }
```

Steps share the same temp directory, so state accumulates naturally.

### Assertion Types

| Type | Source | Description |
|------|--------|-------------|
| `exit_code` | subprocess | Exact exit code match |
| `exit_code_nonzero` | subprocess | Any non-zero exit |
| `state_after` | sprint-state.json | `task.state === value` |
| `task_field` | sprint-state.json | Any task field comparison |
| `task_field_gte` | sprint-state.json | Numeric field >= value |
| `journal_contains` | run-journal.md | Summary text match |
| `journal_signal` | run-journal.md | Signal pattern match |
| `journal_entry_count` | run-journal.md | Minimum entry count |
| `pitfall_count` | pitfalls.json | Minimum pitfall count |
| `pitfall_for_task` | pitfalls.json | Unresolved pitfall exists for task |
| `gate_passed` | stdout | Named gate passed |
| `gate_failed` | stdout | Named gate failed |
| `gate_not_run` | stdout | Named gate never emitted a result |
| `all_gates_passed` | stdout | All gates passed |
| `stdout_contains` | stdout | Text in output |
| `stdout_not_contains` | stdout | Text not in output |
| `file_exists` | filesystem | File exists check |
| `file_not_exists` | filesystem | File does not exist |
| `file_contains` | filesystem | File content check |

**Semantics**: All `must` assertions must pass. At least 80% of `should` assertions must pass.

## Available Scenarios

| # | File | What it tests |
|---|------|---------------|
| 01 | state-machine-happy | Backlog → Done full path |
| 02 | state-machine-fail-retry | Backlog → Failed → Done recovery |
| 03 | state-machine-triple-fail | failCount ≥ 3 triggers stop |
| 04 | pitfall-lifecycle | Failure creates pitfall, injected on retry |
| 05 | human-board-injection | Unchecked instructions injected into dispatch |
| 06 | quality-gates-sequence | Build → Review → Acceptance order |
| 07 | quality-gates-first-fail | Build failure blocks sequence |
| 08 | parallel-dispatch | Two tasks dispatched concurrently |
| 09 | sprint-completion-review | Sprint-complete detection |
| 10 | demo-walkthrough | Full 3-task sprint lifecycle |

## Writing Custom Scenarios

1. Create `e2e/scenarios/NN-your-test.yaml`
2. Define `setup` with fixture, sprint state, and agent behavior
3. Define `run` with loop flags
4. Define `assert` with structural assertions
5. Run: `node e2e/run-e2e.mjs --scenario e2e/scenarios/NN-your-test.yaml`

## CI Integration

```bash
# In package.json
"check:e2e": "node e2e/run-e2e.mjs --all"

# In GitHub Actions
- run: npm run check:e2e
```

Expected runtime: ~70 seconds for all 10 scenarios (deterministic stub mode).

## Directory Structure

```
e2e/
  scenarios/           # YAML scenario definitions
  fixtures/
    minimal-node/      # Minimal Node.js project (package.json + 1 test)
    fixture-helper.mjs # Creates isolated temp directories
  stubs/
    deterministic-agent.mjs          # Controllable agent replacement
    deterministic-reviewer.mjs       # Controllable review gate
    deterministic-sprint-reviewer.mjs
  observers/
    state-observer.mjs   # Reads sprint-state.json
    journal-observer.mjs # Parses run-journal.md
    pitfall-observer.mjs # Reads pitfalls.json
    gate-observer.mjs    # Parses gate results from stdout
    file-observer.mjs    # File existence/content checks
  run-e2e.mjs            # CLI entry point + core runner
  README.md              # This file
```
