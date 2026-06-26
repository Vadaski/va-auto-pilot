# Observability Event Schema & Evidence Bundle Specification

> AP-087 contract. Defines what the harness records around every agent run so that
> completed work can be audited and failed work can be diagnosed without re-reading
> the entire conversation.

## Scope

This spec covers:

1. The structured run event log.
2. The per-task/run evidence bundle file layout.
3. Redaction rules for shareable evidence.
4. Process-restart survival semantics.
5. Failed-gate timeline expectations.
6. Review finding index expectations.
7. How AP-088 governance/checkpoint work consumes this contract.

Out of scope for AP-087: live streaming, long-term storage backends, or UI rendering.

## Design principles

- **Append-only event log**: every phase change, command, gate, review, and decision is one event.
- **One evidence bundle per task**: deterministic path from `runId` + `taskId`.
- **Redaction is a copy operation**: originals stay intact; a redacted shareable copy is produced.
- **Survive restarts**: log and manifest are flushed atomically; paths are deterministic.

## Event envelope

Every event is a JSON object with this shape:

```json
{
  "schemaVersion": 1,
  "eventType": "task.gate",
  "eventId": "evt-0198240a-...",
  "runId": "run-2026-06-26T05-...",
  "taskId": "AP-087",
  "phase": "running",
  "timestamp": "2026-06-26T05:30:00.000Z",
  "payload": { ... },
  "provenance": {
    "source": "auto-pilot-loop",
    "host": "host.example",
    "pid": 12345
  },
  "redaction": {
    "applied": false,
    "rules": [],
    "fieldsRemoved": []
  }
}
```

### Event envelope fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | integer | yes | Must be `1`. |
| `eventType` | string | yes | One of the registered event types below. |
| `eventId` | string | yes | UUIDv4-style unique id. |
| `runId` | string | yes | The active orchestration run id. |
| `taskId` | string | no | Set for task-scoped events; omitted for run-level events. |
| `phase` | string | no | Active run phase at the time of the event. |
| `timestamp` | ISO-8601 | yes | UTC event time. |
| `payload` | object | yes | Type-specific data. |
| `provenance.source` | string | yes | `"auto-pilot-orchestrate"`, `"auto-pilot-loop"`, `"worker"`, `"manual"`. |
| `provenance.host` | string | no | Hostname. |
| `provenance.pid` | number | no | Process id. |
| `redaction.applied` | boolean | yes | Whether this event has been redacted. |
| `redaction.rules` | string[] | no | Names of redaction rules applied. |
| `redaction.fieldsRemoved` | string[] | no | Dotted paths removed. |

### Event types

| Event type | Payload fields | Emitted when |
|------------|----------------|--------------|
| `run.lifecycle` | `phase`, `previousPhase`, `reason` | Run phase changes. |
| `plan.reviewed` | `planHash`, `passed`, `criticalCount`, `warningCount`, `findingsIndexArtifact` | Plan review completes. |
| `plan.approved` | `planId`, `checkpointId`, `candidatePlan` | Checkpoint is recorded. |
| `checkpoint.stale` | `reason`, `expectedHash`, `actualHash` | Dispatch detects stale checkpoint. |
| `dispatch.queued` | `taskIds`, `parallel` | Tasks are queued to workers. |
| `task.started` | `worker`, `command`, `workingDir` | Worker begins a task. |
| `task.command` | `command`, `exitCode`, `durationMs`, `stdoutArtifact`, `stderrArtifact` | Any shell command finishes. |
| `task.gate` | `gateName`, `required`, `passed`, `exitCode`, `durationMs`, `outputArtifact` | A quality gate finishes. |
| `task.review` | `reviewArtifact`, `findingsIndexArtifact`, `criticalCount`, `warningCount` | Code review finishes. |
| `task.completed` | `state`, `commitHash`, `evidenceBundle` | Task reaches a terminal success state. |
| `task.failed` | `state`, `failureType`, `firstFailingGate`, `recoveryDecision`, `pitfallId` | Task reaches a terminal failure state. |
| `intervention` | `directiveType`, `reason` | A directive is written. |
| `commit` | `taskIds`, `commits[]` | Commits are made. |
| `journal` | `summary`, `signals[]` | A journal entry is appended. |
| `run.closed` | `finalPhase`, `reason` | Run is closed. |

Payload objects are intentionally flat so that grepping and streaming remain easy.

## Evidence bundle layout

A bundle is a directory, not a single file, so large artifacts can be stored without
inflating the manifest.

### Default paths

```text
.va-auto-pilot/evidence/
  events.jsonl                       # run-level event log
  {runId}/
    {taskId}/
      manifest.json                  # bundle manifest
      events.jsonl                   # task-level event log (may mirror run log subset)
      artifacts/
        build-gate.log
        review-report.json
        stdout-001.txt
        stderr-001.txt
        diff.patch
      findings/
        findings-index.json
      redacted/
        manifest.json                # redacted shareable manifest
        artifacts/...
```

Paths are deterministic. A process that restarts can reconstruct state from the
manifest and event logs without an in-memory registry.

### Bundle manifest

```json
{
  "schemaVersion": 1,
  "bundleId": "bnd-...",
  "bundleType": "task",
  "runId": "run-...",
  "taskId": "AP-087",
  "state": "completed",
  "outcome": {
    "state": "completed",
    "commitHash": "abc123"
  },
  "createdAt": "2026-06-26T05:30:00.000Z",
  "updatedAt": "2026-06-26T05:35:00.000Z",
  "timeline": [
    { "at": "2026-06-26T05:30:00.000Z", "phase": "running", "eventId": "evt-...", "note": "task started" },
    { "at": "2026-06-26T05:31:00.000Z", "phase": "running", "eventId": "evt-...", "note": "build gate passed" },
    { "at": "2026-06-26T05:35:00.000Z", "phase": "awaiting-commit-approval", "eventId": "evt-...", "note": "task completed" }
  ],
  "artifacts": [
    {
      "name": "build-gate.log",
      "path": "artifacts/build-gate.log",
      "kind": "gate-output",
      "sizeBytes": 1200,
      "sha256": "...",
      "redacted": false
    }
  ],
  "gates": [
    {
      "name": "build",
      "required": true,
      "passed": true,
      "exitCode": 0,
      "durationMs": 4500,
      "artifact": "artifacts/build-gate.log"
    }
  ],
  "review": {
    "findingsIndexArtifact": "findings/findings-index.json",
    "criticalCount": 0,
    "warningCount": 1,
    "disposition": "accepted"
  },
  "eventsLog": "events.jsonl",
  "redactedShareable": "redacted/manifest.json"
}
```

### Manifest fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `schemaVersion` | integer | yes | Must be `1`. |
| `bundleId` | string | yes | Unique bundle id. |
| `bundleType` | string | yes | `"task"` or `"run"`. |
| `runId` | string | yes | Parent run id. |
| `taskId` | string | required for `task` bundles | Task id. |
| `state` | string | yes | `"open"`, `"completed"`, `"failed"`, `"abandoned"`. |
| `outcome` | object | yes | `state`, optional `commitHash`, optional `firstFailingGate`, optional `failureType`, optional `recoveryDecision`. |
| `createdAt` | ISO-8601 | yes | Bundle creation time. |
| `updatedAt` | ISO-8601 | yes | Last update time. |
| `timeline` | array | yes | Ordered phase/event notes. |
| `artifacts` | array | yes | Artifact metadata. |
| `gates` | array | yes | Gate results. |
| `review` | object | no | Review summary. |
| `eventsLog` | string | yes | Relative path to task event log. |
| `redactedShareable` | string | yes | Relative path to redacted manifest. |

## Redaction rules

Redaction produces a **copy**. The original bundle is never modified.

Default redaction rules:

| Rule name | Targets |
|-----------|---------|
| `env-secrets` | Lines matching `export .*SECRET`, `.*_TOKEN=`, `password=`, `api_key=`. |
| `auth-headers` | `Authorization:` or `Bearer ` tokens. |
| `paths` | Absolute home-directory paths (replaced with `~`). |

When a redacted copy is created:

1. A new `redacted/` directory is populated.
2. Text artifacts are rewritten with rules applied.
3. The redacted manifest records `redacted: true` on each artifact.
4. Event `payload` fields known to contain sensitive output are stripped or replaced.
5. The original manifest's `redactedShareable` field points to the redacted manifest.

Redaction is opt-in via `redactBundle(bundleDir)`; by default bundles contain raw
command output so the manager can debug failures.

## Restart-survival semantics

- Every write is flushed to disk before returning.
- Event logs are appended under a file lock (`withPilotFileLock`).
- Manifests are replaced atomically via temp-file + rename.
- Bundle directories are created once and never deleted by normal harness code.
- `checkpoint.json` stores `observability.eventLogPath` and `observability.evidenceBundleDir`
  so a restarted process can locate logs without scanning.

On restart, a consumer reads:

1. `run.json` for the active run id and phase.
2. `checkpoint.json` for the event log path and bundle directory.
3. The event log to reconstruct the timeline.
4. Task manifests for artifact references.

No in-memory state is required to resume.

## Failed-gate timeline expectations

A failed task bundle **must** contain enough information to answer:

1. Which gate failed first?
2. What was the exit code / output?
3. What recovery decision was made (retry, escalate, abort)?

Therefore the timeline and events must include, in order:

- `task.started`
- `task.command` / `task.gate` events
- the first `task.gate` with `passed: false`
- `task.failed` with `firstFailingGate` set to that gate name
- `intervention` if the manager overrides the default recovery

The manifest `outcome` object must contain:

```json
{
  "state": "failed",
  "firstFailingGate": "build",
  "failureType": "gate",
  "recoveryDecision": "escalate"
}
```

## Review finding index expectations

Findings are normalized into a machine-readable index:

```json
{
  "schemaVersion": 1,
  "source": "plan-review",
  "artifact": "artifacts/review-report.json",
  "generatedAt": "2026-06-26T05:31:00.000Z",
  "summary": {
    "critical": 0,
    "warning": 1,
    "suggestion": 2
  },
  "findings": [
    {
      "id": "F-001",
      "severity": "warning",
      "message": "Schema lacks example for redacted artifacts",
      "location": "schemas/evidence-bundle.schema.json",
      "disposition": "accepted",
      "evidence": "observability-spec.md line 142"
    }
  ]
}
```

The index is the contract between review tools and downstream gates:

- `CRITICAL`, `BUG`, `ANCHOR VIOLATION` block completion.
- `WARNING` / `RISK` require a recorded disposition.
- `PASS` findings are retained for audit.

Plan reviews and task reviews both produce a finding index. The checkpoint
governance logic (AP-088) checks the plan-review index before allowing dispatch.

## Completed-task audit example

See [`observability-examples/completed-task`](./observability-examples/completed-task/).
It contains:

- `manifest.json` — completed state, gates all passed, review disposition.
- `events.jsonl` — ordered event stream from start to completion.
- `artifacts/build-gate.log`, `review-report.json`, `diff.patch`.
- `findings/findings-index.json` — zero critical findings.

A reader can verify completion by checking `state === "completed"`, every required
gate has `passed === true`, and the review index has no critical findings.

## Failed-task audit example

See [`observability-examples/failed-task`](./observability-examples/failed-task/).
It contains:

- `manifest.json` — failed state, `firstFailingGate: "build"`, `recoveryDecision: "escalate"`.
- `events.jsonl` — shows the failing `task.gate` event and the `task.failed` event.
- `artifacts/build-gate.log` — raw failing output.
- `findings/findings-index.json` — one critical finding from the post-failure review.

A reader can diagnose the failure without reading the conversation by opening the
first failing gate event and the associated artifact.

## AP-088 checkpoint consumption

`buildCheckpoint()` in `scripts/lib/orchestration-state.mjs` adds an `observability`
object to `checkpoint.json`:

```json
{
  "schemaVersion": 1,
  "approvedPlanId": "plan-...",
  "sprintStateHash": "...",
  "humanBoardHash": "...",
  "gitHead": "...",
  "createdAt": "...",
  "observability": {
    "schemaVersion": 1,
    "eventLogPath": ".va-auto-pilot/evidence/events.jsonl",
    "evidenceBundleDir": ".va-auto-pilot/evidence",
    "redactedShareableDir": ".va-auto-pilot/evidence/redacted"
  }
}
```

AP-088 can:

1. Read `eventLogPath` to append `plan.approved` / `checkpoint.stale` events.
2. Use `evidenceBundleDir` to locate per-task bundles deterministically.
3. Use `redactedShareableDir` to produce manager-shareable evidence.
4. Treat the observability schema version as a compatibility gate: if unknown,
   refuse to consume the bundle.

The helpers in `scripts/lib/observability.mjs` provide the canonical implementation
for building events, appending logs, validating manifests, and redacting bundles.

## Versioning

- `observability.schemaVersion = 1` for this contract.
- Bumping the version requires updating `schemas/*.schema.json`, `scripts/lib/observability.mjs`,
  and the checkpoint `observability.schemaVersion` field together.

## Verification

Run the lightweight validator:

```bash
node scripts/validate-observability.mjs
```

And the unit tests:

```bash
node scripts/test-units.mjs --test-name-pattern observability
```
