# vNext Plan Rev28 Exact-Hash Preflight Ledger

Status: **FAIL; non-authorizing; Rev29 required**

## Frozen candidate

- Plan SHA-256: `3826f838e025155487279478a85ca0ea8b973c1eda0e3b2d596eed29bbfcbc73`
- Size: 1,065,541 bytes; 13,670 lines
- Base HEAD/tree: `9dcd8b77…` / `4a4a8b39…` with uncommitted plan overlay

## Valid perspective results

| Perspective | Reviewer | C | P1 | P2 | Result | Raw |
| --- | --- | ---: | ---: | ---: | --- | --- |
| crash / mailbox / broker | Cursor Grok 4.5-high | 0 | 0 | 0 | PASS | `docs/reviews/raw/rev28-cursor-grok-crash.stdout.txt` |
| false-success | GPT-5.4-high | 0 | 1 | 1 | FAIL | `docs/reviews/raw/rev28-gpt-false-success.stdout.txt` |
| schema / hash-DAG | GPT-5.5-high | 0 | 0 | 0 | PASS | `docs/reviews/raw/rev28-gpt55-schema.stdout.txt` |
| repository feasibility | Composer 2.5 | 0 | 2 | 0 | FAIL | `docs/reviews/raw/rev28-composer-repo.stdout.txt` |

Aggregate: **CRITICAL 0 / P1 3 / P2 1**

## Closed from Rev27

- R27-C1 send-authorized-exited-absent / may-send barrier cycle: closed (crash PASS)
- R27-P1 A3/D2/C0/D1 architecture-gate coverage for packageVersion/meta/workspaces skip path: accepted by false-success as closed; residual issues are different

## Blocking → Rev29

| ID | Sev | Blocker | Disposition |
| --- | --- | --- | --- |
| R28-P1a | P1 | terminal/trust inventory parses only Done/TaskDoneProvisional/ReadyToCommit/GitBoundUntrusted, omitting TaskDone/GoalComplete trusted finals | Expand static inventory to include TaskDone/GoalComplete (and any direct canCount* bypass writes) |
| R28-P1b | P1 | meta public profiles exist but closed WorkspaceRoute role enum lacks meta-problem awareness; no isolation binding for meta mutators vs integration-root meta-problems.json | Add normative route role/entry for meta; define isolated-workspace behavior (reject, rebind under workspaces/**, or explicit matrix exemption) so A0 isolation proofs are satisfiable |
| R28-P1c | P1 | path-override flag inventory omits `--meta-file` despite real CLI support | Add `--meta-file` to closed dynamic route/flag inventory and old-writer corpus attacks |
| R28-P2 | P2 | D2 track gate omits `check:state-faults --track D2` despite D2-CELL-* rows | Add explicit D2 fault-track gate to matrix |

## Decision

`PRE-FLIGHT STATUS: FAIL`
