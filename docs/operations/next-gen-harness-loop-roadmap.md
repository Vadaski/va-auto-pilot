# Next-Gen Harness + Loop Roadmap

This roadmap starts after the reopen readiness work. It assumes the public
positioning is stable: VA Auto-Pilot is a CLI-first autonomous engineering loop,
a Harness Engineering reliability layer, and a standalone execution engine that
can also act as a va-agent-protocol reference engine.

The next phase is to make the system stronger as a harness and more durable as a
loop.

## Roadmap Principles

- Build reliability into the environment around the agent, not into prompts.
- Treat every claim of progress as evidence that can be inspected later.
- Keep humans on the loop for objectives, risk, budgets, and stop conditions.
- Make adapters pluggable without weakening the core CLI-first contract.
- Prefer small verified increments over broad framework rewrites.

## Track 1: Observability Harness

Goal: make each agent run inspectable after the fact.

Why this is Harness:

The harness defines what evidence is collected around execution. Observability
turns agent work from a transcript into a structured event stream.

Deliverables:

- structured run event log
- per-task evidence bundle
- command, exit code, duration, and artifact references
- review finding index
- failed-gate timeline

Acceptance:

- a completed task can be audited without reading the whole conversation
- a failed task exposes the first failing gate and the recovery decision
- run evidence survives process restart

Risks:

- event logs can become noisy
- sensitive command output may need redaction before sharing

## Track 2: Cost And Budget Guardrails

Goal: make autonomous execution budget-aware.

Why this is Harness:

Cost controls are environmental constraints around agent action. They define
when a run may continue, degrade, ask for approval, or stop.

Deliverables:

- run budget configuration
- per-task elapsed time and command-count budget
- optional model/provider token budget metadata
- stop/escalate behavior when budget is exceeded
- budget summary in run-journal

Acceptance:

- a run stops before exceeding configured hard limits
- budget warnings appear before hard stop when soft limits are configured
- budget decisions are journaled with enough context for a human to override

Risks:

- token-cost data is provider-specific
- command-count limits can block legitimate long-running tests

## Track 3: Evaluation Gates

Goal: make quality gates richer than build/test/review.

Why this is Harness:

Evaluations are external judgments attached to completion. They keep the agent
from optimizing only for local test pass.

Deliverables:

- `evalCommand` gate type
- fixture-based acceptance evals
- regression eval history
- eval result parser with pass/fail/ambiguous states
- adaptive suggestions when evals repeatedly fail

Acceptance:

- a project can define at least one eval gate in `.va-auto-pilot/config.yaml`
- eval failures block Done state
- ambiguous eval output is treated as non-passing

Risks:

- poorly designed evals can create false confidence
- eval runtime can make every sprint too slow

## Track 4: Permission And Tool-Scope Harness

Goal: give the manager explicit control over what workers may touch.

Why this is Harness:

Permissions are part of the operating environment. A strong agent still needs a
bounded tool surface.

Deliverables:

- per-task allowed path scopes
- command allow/deny list
- destructive-command policy
- external network access flag
- reviewer warning when diff exceeds declared scope

Acceptance:

- worker prompts include explicit tool and file boundaries
- out-of-scope file changes are detected before commit
- destructive commands require explicit opt-in policy

Risks:

- overly strict scopes can prevent legitimate refactors
- path scope detection must not become a brittle string matcher

## Track 5: Governance Loop

Goal: make human-on-the-loop governance explicit and resumable.

Why this is Loop:

The loop decides when to continue, pause, escalate, request approval, or change
strategy.

Deliverables:

- objective/risk/stop-condition section in human-board
- approval checkpoints for plan, dispatch, commit, and release
- intervention journal
- stale checkpoint detection across human-board edits
- resumable governance state after process restart

Acceptance:

- a manager can pause and resume without losing the current decision point
- human-board changes invalidate stale approvals
- every override records who/what/why in run-journal

Risks:

- too many checkpoints can make the system feel heavy
- emergency override paths must be visible but not casual

## Track 6: MCP Adapter

Goal: expose Auto-Pilot capabilities through MCP without redefining the core
loop around MCP.

Why this is Adapter, not Core:

MCP is a connection layer. Auto-Pilot's core remains the state machine,
delegation, gates, recovery, and evidence model.

Deliverables:

- MCP tools for sprint summary, next task, plan, approve, dispatch, and observe
- read-only resources for sprint state, run-journal, and pitfall guide
- write tools for human-board and tactical directives
- adapter-level permission model
- examples for local MCP clients

Acceptance:

- MCP clients can inspect state without direct filesystem knowledge
- write tools preserve the same guardrails as CLI commands
- the CLI remains the source of truth and keeps working without MCP

Risks:

- adapter drift from CLI semantics
- accidental framing as "Auto-Pilot depends on MCP"

## Track 7: va-agent-protocol Reference Engine Hardening

Goal: make Auto-Pilot a clearer reference implementation for managed agents.

Why this is Loop + Protocol:

The protocol defines the task contract; Auto-Pilot demonstrates one execution
engine that satisfies it.

Deliverables:

- explicit TaskUnit import/export path
- evidence bundle mapping to protocol fields
- managed-agent lifecycle examples
- compatibility tests against protocol fixtures
- protocol-version compatibility matrix

Acceptance:

- a TaskUnit can enter Auto-Pilot and produce structured evidence
- evidence can be consumed by a protocol-aware manager
- compatibility failures are detected before release

Risks:

- overfitting Auto-Pilot internals into the protocol
- changing protocol fields without migration guidance

## Suggested Execution Order

1. Observability Harness
2. Governance Loop
3. Permission And Tool-Scope Harness
4. Evaluation Gates
5. Cost And Budget Guardrails
6. va-agent-protocol Reference Engine Hardening
7. MCP Adapter

Reasoning:

Observability should come first because every later track needs evidence. MCP
should come after the core semantics are stable so the adapter does not freeze
immature behavior.

## Initial Backlog Seeds

- `roadmap-observability-events`: design event schema and evidence bundle shape
- `roadmap-governance-checkpoints`: define human approval checkpoints and stale
  approval invalidation
- `roadmap-permission-scope`: define file/command/network policy schema
- `roadmap-eval-gates`: add eval gate type to config and runner
- `roadmap-budget-guardrails`: add soft/hard budget policy and journal output
- `roadmap-protocol-fixtures`: map TaskUnit/evidence fixtures to Auto-Pilot
- `roadmap-mcp-adapter`: implement read-only MCP resources before write tools

## Definition Of Stronger

The next-generation system is stronger when:

- every action leaves inspectable evidence
- every long loop has budget and stop conditions
- every worker has a declared tool boundary
- every completion can be evaluated beyond self-report
- every human intervention is durable
- every adapter preserves CLI semantics instead of bypassing them
