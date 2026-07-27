# vNext Plan Preflight — Rev31

## Freeze

| Field | Value |
|---|---|
| Plan file | `docs/plans/vnext-durable-autonomy-architecture.md` |
| Plan SHA-256 | `a2dbc412711aacb870cea5ca1334536a6d585860568d5979933caa8257215965` |
| Plan bytes / lines | `1071793` / `13751` |
| Base HEAD | `9dcd8b77fae1a8b37e121ef9d541ea68f356fa99` |
| Base tree | `4a4a8b397894368c78954641b4fb34c4fec8ab7a` |
| Overlay rule | plan overlay only; plan file non-writable in sandbox |
| Review worktree | `/tmp/va-vnext-rev31-preflight` |

## Claimed closures vs Rev30

1. Freeze four mutually exclusive meta-read argv→profile rows (`meta-list`, `meta-list-pre-route`, `meta-report`, `meta-report-pre-route`).
2. Retire `meta report --output` from all read-only meta profiles (stdout-only; `A0-WORKSPACE-22`).
3. Reject current-route+`--project` and absent-route bare list/report; forbid cwd / hidden `--meta-file` trusted fallthrough (`A0-WORKSPACE-23`).
4. Correct domain-registry attribution for list/report entrypoints.

## Aggregate

| Perspective | Reviewer | Critical | P1 | P2 | Status |
|---|---|---:|---:|---:|---|
| crash-authority-mailbox-broker | Cursor Grok 4.5-high | 0 | 0 | 0 | PASS |
| false-success-holistic-fault | GPT-5.4-high | 0 | 0 | 0 | PASS |
| schema-hashdag-fault-static | GPT-5.5-high | 0 | 0 | 0 | PASS |
| repository-feasibility-inventory | Composer 2.5 | 0 | 0 | 1 | PASS |

**Aggregate: PASS — CRITICAL 0 / P1 0 / P2 1**

Raw outputs: `docs/reviews/raw/rev31-*.stdout.txt`

## Non-blocking P2

- repository: fault-annex IDs `A0-WORKSPACE-22`/`23` sit between `17` and `18` (numbering order only; semantics closed).

## Disposition

Rev30 false-success blockers are closed in plan text under all four perspectives.
Exact-hash manager preflight gate is satisfied for this freeze.
Next: formal `orchestrate review-plan` (still no product implementation / `approve-plan` until human/governance policy allows).


## Formal orchestrate review-plan

| Field | Value |
|---|---|
| Run | `run-2026-07-11T00-32-31-977Z-ca1f846a` |
| Candidate planHash | `829e6db11ba5053359adc622d1752547dde857d3cbe086a5d42a6c8139cd834e` |
| Result | **FAIL** (`PLAN_REVIEW_CRITICAL`) |
| Reviewer | Cursor Agent `gpt-5.4-high` via temporary `planReviewCommand` (config restored) |

### CRITICAL (blocking approve-plan)

1. Exact-hash preflight passed architecture plan SHA `a2dbc412…`, but `review-plan`/`approve-plan` bind only the thin candidate-plan JSON hash `829e6db1…` — checkpoint A≠B.
2. Approve-plan protocol does not bind the dirty plan-overlay bytes; cannot prove approved object equals Rev31 freeze.

### Disposition

Manager exact-hash preflight gate is satisfied. Formal sprint `review-plan` is **not** satisfied. Do **not** `approve-plan` / dispatch until candidate-plan (or an explicit binding field) carries the frozen architecture plan SHA and approve-plan evidence includes that binding.


## Bound formal review-plan (post-binding)

| Field | Value |
|---|---|
| Result | **PASS** |
| candidatePlanHash | `1492438bcfcacdb46d221c1cb91087e1ad331f1288df2ad1bf62218c8baff578` |
| architecturePlanSha256 | `a2dbc412711aacb870cea5ca1334536a6d585860568d5979933caa8257215965` |
| Phase | `plan-reviewed` |
| approvalPolicy | `human-required` |

Binding closure: `candidatePlan.architecturePlanBinding` + orchestrator byte re-verify on review/approve.
Next human gate: `orchestrate approve-plan --run-id run-2026-07-11T00-32-31-977Z-ca1f846a` (still no dispatch until approved).
