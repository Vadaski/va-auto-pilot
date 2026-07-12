Constraint sets in this directory are opt-in prompt inputs for `va-auto-pilot`.

This repository now seeds the library from resolved dogfood root causes across
five domains: `dispatch`, `review-gate`, `adopt`, `mode-enforcement`, and
`state-race`.

Contract:
- each file must be `*.yaml`
- top-level envelope must include `id`, `type: auto-pilot-constraint-set`, and `payload`
- `payload.domain`, `payload.tags`, `payload.synthesis`, `payload.constraints`, and `payload.blindSpots` are the supported fields
- constraint entries must use `type` in `boundary|invariant|prerequisite|trade-off|anti-pattern`
- pitfall-learned sets use `governance.status` (`probation|active|retired`), `learnedAt`, `lastValidatedAt`, `halfLifeDays`, evidence feedback, and optional `conflictsWith` pitfall IDs

When `VA_AUTO_PILOT_CONSTRAINTS=on` or `constraintInjection.enabled: true` is set,
the constraint bridge loads these files from disk, filters them by task keywords,
and injects the matched constraints into the delegate prompt.
Only active sets are injectable. Active pitfall-learned constraints decay by
half-life and are suppressed below the confidence floor; curated constraints do
not decay. A declared conflict suppresses both rules when both match a task and
would otherwise be injectable.
