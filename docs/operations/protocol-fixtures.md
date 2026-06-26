# Protocol Fixture Mapping

AP-092 defines how Auto-Pilot maps va-agent-protocol `TaskUnit` fixtures to its
own sprint tracks and observability evidence bundles.

The compatibility contract is deliberately narrow:

1. Auto-Pilot track data must round-trip into a protocol-shaped `TaskUnit`.
2. The `TaskUnit.id` must match the task evidence bundle `taskId`.
3. Required protocol evidence must be inspectable through an evidence manifest
   and event log.
4. Fixture validation must fail when mapping fields drift.

## Fixture Files

Fixtures live in `docs/operations/protocol-fixtures/`:

| Fixture | Purpose |
| --- | --- |
| `completed-task.json` | A protocol task that maps to a completed Auto-Pilot task bundle. |
| `failed-task.json` | A protocol task that maps to a failed Auto-Pilot task bundle with first failing gate evidence. |

Each fixture has three sections:

| Section | Meaning |
| --- | --- |
| `taskUnit` | The protocol-facing task object a manager can consume. |
| `autoPilot.track` | The Auto-Pilot dispatch track used to generate the TaskUnit. |
| `evidence` | Relative pointers and expectations for the evidence bundle and event log. |

## Field Mapping

| Auto-Pilot track field | TaskUnit field |
| --- | --- |
| `taskId` | `id` |
| `title` or `command` | `objective` |
| `verification[]` | `acceptanceCriteria[]` |
| `notes` | `constraints[]` |
| work directory | `context.codebaseRoot` |
| `priority` | `priority` |
| `dependsOn[]` | `dependsOn[]` |
| `qualityGates[]` and `metadata` | `metadata` |

The executable source of truth for this conversion is
`scripts/lib/colony-bridge.mjs#trackToTaskUnit`.

## Evidence Mapping

| Evidence field | Source |
| --- | --- |
| `taskUnit.id` | `manifest.taskId` |
| `evidence.outcomeState` | `manifest.outcome.state` |
| `evidence.firstFailingGate` | `manifest.outcome.firstFailingGate` |
| `evidence.requiredEvents[]` | Event types in the fixture event log |
| `evidence.requiredGatesPassed` | Required gate pass state in `manifest.gates[]` |

The evidence manifest still follows `schemas/evidence-bundle.schema.json`. The
protocol fixture wrapper follows `schemas/protocol-fixture.schema.json`.

## Validation

Run:

```bash
npm run check:protocol-fixtures
```

The validator checks that:

- fixture JSON exists and has the expected top-level structure
- `trackToTaskUnit(autoPilot.track, taskUnit.context.codebaseRoot)` exactly
  matches the fixture `taskUnit`
- the referenced evidence manifest passes the observability validator
- referenced event logs contain required protocol event types
- completed fixtures have all required gates passing
- failed fixtures expose the expected first failing gate

`npm run check:all` includes this validation so protocol drift blocks normal
release checks.
