# Budget Guardrails

Budget guardrails are environmental controls around autonomous execution. They
decide when a loop may continue, warn, or stop before it overruns the operator's
limits.

AP-091 added run-level and task-level budget evaluation plus journal summaries.
The loop also extracts best-effort token and cost usage from worker log files
when CLI agents emit common JSON or text usage records.

## Configuration

Budgets live under `.va-auto-pilot/config.yaml` in `qualityGate.budget`:

```yaml
qualityGate:
  budget:
    run:
      maxCyclesSoft: 5
      maxCyclesHard: 8
      maxElapsedMsSoft: 900000
      maxElapsedMsHard: 1200000
    task:
      maxCommandsSoft: 8
      maxCommandsHard: 12
    tokens:
      provider: example-provider
      model: example-model
      softTokens: 100000
      hardTokens: 150000
```

Flat keys such as `maxCyclesHard` are also accepted for small configs, but the
nested form is preferred.

## Semantics

| Budget | Soft limit | Hard limit |
| --- | --- | --- |
| Run cycles | Writes a warning in the cycle budget summary. | Stops the loop after the current cycle before starting another. |
| Run elapsed time | Writes a warning in the cycle budget summary. | Stops the loop after the current cycle. |
| Task command count | Writes a warning when collected step count reaches the soft limit. | Stops after the current cycle when collected step count reaches the hard limit. |
| Tokens | Writes warning/stop when worker logs expose measured token count. | Same; missing usage data is treated as unknown, not zero-cost proof. |

Hard limits are checked from observed state. The loop does not invent token or
cost usage; it only uses explicit usage telemetry found in worker logs.

## Journal Output

Each normal cycle boundary includes a budget summary:

```text
budget=warn | cycles=5 | elapsedMs=912000 | commands=7 | warnings=soft cycle budget reached: 5/5
```

When worker logs include usage, the summary also includes `tokens=<n>` and, when
available, `costUsd=<amount>`.

Hard stops use `budget=stop` and include the stop reason. This gives a manager
enough context to override, raise limits, or split the work into a smaller run.

## Implementation

Runtime helper: `scripts/lib/budget-guardrails.mjs`.

The loop evaluates budget after a cycle has produced evidence. This keeps
partially completed task state and journal entries coherent while preventing
the next cycle from starting after a hard limit has been reached.
