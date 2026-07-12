# vNext Architecture Plan Review — Round 4

Detached review snapshot:

- commit `76e1de92f332d8f0cf73048682ecaa0b4d677a3a`
- tree `e997631fe2da5f87de8876f9da050335c084e4fb`
- plan SHA-256 `acd152a59df27e0b2c14fa781912ae4ff08e97c631f1efbffae956d8b920ebea`
- R1/R2/R3 ledger hashes `1e53ebec…`, `90c32be2…`, `9a3caccd…`

Result: **FAIL** (two PASS, two FAIL). No implementation was dispatched.

| Nonce | Perspective | Verdict |
| --- | --- | --- |
| `3224FC5D-8A11-41FA-BABC-AEB27CC3BCE9` | Grok crash/authority | FAIL |
| `F924B359-F3BF-42AC-B5C8-ED32A1BEEC9B` | Kimi backend/operator | PASS; session `e00c0028-e130-43c6-87e1-13604bcbbbd0` |
| `A4AA4B09-FA5C-4792-B96F-234F162384FC` | Composer repository feasibility | FAIL |
| `9EFE9A39-6632-418D-9F08-E8013495298D` | fresh false-success/completion | PASS |

## Blocking ledger and revision-5 disposition

| ID | Round-four blocker | Revision-5 disposition |
| --- | --- | --- |
| R4-P1 | A3 could promote stale/tampered A1 shadow | first authority is re-imported from exclusively locked JSON graph after quiescence; shadow diagnostic only |
| R4-P2 | reverse-authority was labels, not an executable state table | add step-by-step mutation/CAS/writer/kill matrix and no-dual-writer invariant |
| R4-P3 | quiescence missed lockless/noncooperative writers | require exclusive locks on every authority path plus reaped inventoried processes and legacy corpus attack |
| R4-P4 | A0 did not mechanically freeze finite legacy corpus | define `schemas/vnext/old-writer-corpus.json`, named versions/entrypoints/checksums and A0 merge proof |
| R4-P5 | writer registry/checklist omitted real modules/paths | add constraints/config/legacy marker/temp lifecycle rows and explicit A2 module list + doctor diff gate |
| R4-P6 | terminal callsite inventory omitted direct Done paths | enumerate sprint-board/core, distribution enum, parallel, loop, orchestrate and generated denylist |
| R4-P7 | GoalAcceptance bridge lacked concrete artifacts | add repository bridge table for intent/backlog/checkpoint/schema/template/MCP/E2E surfaces |
| R4-P8 | A2 GitSaga receipt contract unclear while L2 dark | define `GitSagaV1 receiptHead:null` until C1 upgrades it |

The two PASS reviews also suggested nonblocking portability hardening, included in
revision 5: per-sidecar endpoint locking, sanitized 0700/ACL state root,
single-use signed migration manifests, explicit capability levels, ABI receipts,
Git common-dir file identity and track-to-script mapping.

Revision 5 requires four new detached-snapshot reviews.

PLAN REVIEW STATUS: FAIL
