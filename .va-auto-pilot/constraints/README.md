Constraint sets in this directory are opt-in prompt inputs for `va-auto-pilot`.

This repository now seeds the library from resolved dogfood root causes across
five domains: `dispatch`, `review-gate`, `adopt`, `mode-enforcement`, and
`state-race`.

Contract:
- each file must be `*.yaml`
- top-level envelope must include `id`, `type: auto-pilot-constraint-set`, and `payload`
- `payload.domain`, `payload.tags`, `payload.synthesis`, `payload.constraints`, and `payload.blindSpots` are the supported fields
- constraint entries must use `type` in `boundary|invariant|prerequisite|trade-off|anti-pattern`

When `VA_AUTO_PILOT_CONSTRAINTS=on` or `constraintInjection.enabled: true` is set,
the constraint bridge loads these files from disk, filters them by task keywords,
and injects the matched constraints into the delegate prompt.
