# Governance Checkpoints

VA Auto-Pilot governance is the resumable decision layer around the execution
loop. It records what was approved, what context made the approval valid, and
what must happen when that context changes.

## Goals

- keep human-on-the-loop decisions explicit without turning every phase into a
  meeting
- make pause/resume safe after process restart
- invalidate stale approvals when strategic context changes
- leave a durable trail for overrides and emergency paths

## Governance State

`checkpoint.json` is the current machine-readable plan checkpoint. It is written
by `orchestrate approve-plan` and consumed by `orchestrate dispatch`.

The checkpoint carries three layers:

| Layer | Purpose |
| --- | --- |
| `approvedPlanId` and `candidatePlan` | The plan that was approved. |
| context hashes | `sprintStateHash`, `humanBoardHash`, `runtimeConfigHash`, `gitHead`, `candidatePlanHash`, and `workerSelectionHash` bind approval to the state reviewed by the manager. |
| `governance` | The decision point, approval scope, invalidation rules, stale policy, and resume phase. |

Current governance schema:

```json
{
  "schemaVersion": 1,
  "checkpointId": "plan-...",
  "decisionPoint": "plan.approved",
  "approvalScope": ["plan", "dispatch"],
  "requiredBefore": "dispatch",
  "invalidatesOn": ["sprint-state", "human-board", "runtime-config", "git-head"],
  "stalePolicy": "block-dispatch-and-require-approve-plan",
  "resumePhase": "plan-approved"
}
```

## Checkpoint Matrix

| Checkpoint | CLI action | Required before | Invalidates on | Durable evidence |
| --- | --- | --- | --- | --- |
| Plan approval | `orchestrate approve-plan` | `dispatch` | sprint state, projected human intent, runtime config/gates, git HEAD | `checkpoint.json`, `plan.approved` event |
| Dispatch gate | `orchestrate dispatch` | worker execution | stale plan checkpoint, halt directive, unchecked projected intent, active executor lock | `dispatch.queued` or `checkpoint.stale` event |
| Commit approval | `orchestrate approve-commit --tasks ...` | `commit` | task/track state, approved file hashes or worktree commits, evidence references, integration HEAD | `run.json.approvedCommitTasks`, `approvedCommitManifestHash`, `commit.approved` event |
| Release approval | release workflow | publish or distribution promotion | failed checks, stale package evidence, missing human release note | future release checkpoint |

The release checkpoint is a defined governance slot, but this repository does
not yet ship a release orchestrator. Release automation must reuse the same
pattern: bind approval to evidence, write an append-only event, and block if
the evidence changes before publication.

## Human Intent Invalidation

`docs/todo/human-board.md` is the internal projection of strategic intent
captured through `auto-pilot intent` or by the manager. It always overrides
automated decisions.

Only unchecked `Instructions` items are hashed for checkpoint freshness. This
keeps archival notes and processed history from invalidating active approvals,
while still making new or edited live instructions a hard stop.

When unchecked projected human intent changes after plan approval:

1. `orchestrate dispatch` returns `STALE_CONTEXT`.
2. A `checkpoint.stale` event is appended to `.va-auto-pilot/evidence/events.jsonl`.
3. The manager must rerun the relevant planning/review step and approve a new
   checkpoint.

## Resumability

After a process restart, the manager reconstructs the decision point from:

- `.va-auto-pilot/orchestration/run.json` for the current phase
- `.va-auto-pilot/orchestration/checkpoint.json` for the last plan approval
- `.va-auto-pilot/orchestration/tracks.json` for dispatch/worker state
- `.va-auto-pilot/evidence/events.jsonl` for append-only governance events
- `docs/todo/run-journal.md` for human-readable rationale and interventions

The manager may continue from the recorded phase only if the corresponding
checkpoint is still fresh.

## Override Journal

Every override must answer:

- who: the manager surface or operator making the override
- what: the directive or approval being waived
- why: the reason and expected recovery path

Tactical overrides are recorded through `intervene` and `run-journal.md`.
Emergency plan-review waivers use:

```sh
node scripts/auto-pilot.mjs orchestrate approve-plan --waive-review-with-reason "..."
```

The reason is journaled. Waivers do not remove stale checkpoint checks before
dispatch.

## Observability Events

Governance writes AP-087 observability events:

| Event | Written when | Required payload |
| --- | --- | --- |
| `plan.approved` | `approve-plan` records a checkpoint | `planId`, `checkpointId`, `candidatePlan`, `approvalScope`, `invalidatesOn`, `stalePolicy` |
| `dispatch.queued` | dispatch passes all governance gates | `checkpointId`, `queuedTasks` |
| `checkpoint.stale` | dispatch detects stale approval | `checkpointId`, `approvedPlanId`, `reason`, `stalePolicy`, `resumePhase` |

These events are append-only. Redacted bundles may quote them when evidence
needs to be shared outside the local machine.

Commit approval uses the same stale-context rule as plan approval. The manifest
is rebuilt immediately before commit; a changed file, worktree result commit,
evidence reference, or integration `HEAD` clears approval and returns the run to
`awaiting-commit-approval`.
