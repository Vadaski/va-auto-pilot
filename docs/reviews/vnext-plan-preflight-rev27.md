# vNext Plan Rev27 Exact-Hash Preflight Ledger

Status: **FAIL; non-authorizing; Rev28 required**

## Frozen candidate

- Plan SHA-256: `3ebfd559abb25dee62fe5a2a01c401d8c2867ca5acc4f4c0bbc2c6082c79144f`
- Size: 1,063,954 bytes; 13,656 lines
- Base HEAD/tree: `9dcd8b77…` / `4a4a8b39…` with uncommitted plan overlay

## Valid perspective results

| Perspective | Reviewer | C | P1 | P2 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| crash / mailbox / broker | Cursor Grok 4.5-high | 1 | 0 | 1 | FAIL |
| false-success | GPT-5.4-high | 0 | 1 | 0 | FAIL |
| schema / hash-DAG | GPT-5.5-high | 0 | 0 | 0 | PASS |
| repository feasibility | Composer 2.5 | 0 | 0 | 3 | PASS |

Aggregate: **CRITICAL 1 / P1 1 / P2 4**

## Closed from Rev26

- R26-C1 dual-writer via recovery-writer: closed (crash + schema)
- R26-P1b/c/d packageVersion/meta/workspaces inventory text: closed for repository perspective (PASS)
- False no-send classification intent: accepted, but arrival path broken (see R27-C1)

## Blocking → Rev28

| ID | Sev | Blocker | Disposition |
| --- | --- | --- | --- |
| R27-C1 | CRITICAL | `send-authorized-exited-absent` requires exit+reap+audit+retirement before classification, but may-send barrier forbids reaping until may-send reconciled + continuity; 57N says classification unblocks reaping → unreachable cycle / hung authority | Classify on exit-observed ∧ authenticated-absent (without prior reap/retirement); classification lifts may-send barrier so reap/budget can proceed; never no-send success; rewrite 57B/57N |
| R27-P1 | P1 | `check:state-architecture` (packageVersion/meta/workspaces) not required on A3/D2 (and similar tracks that can change those surfaces) | Require `check:state-architecture` on every track that may mutate packageVersion identity, public command inventory, or ignore/resolution surfaces — at minimum A3 and D2 |

## Decision

`PRE-FLIGHT STATUS: FAIL`
