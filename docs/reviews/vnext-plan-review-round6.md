# vNext Architecture Plan Review — Round 6

Detached snapshot:

- commit `2a21981882ac2be4e30e8afabce251712effd0ba`
- tree `22a25b1d0eeb5608f7d3346bc4b423787f3ad87c`
- plan SHA-256 `a96f2f541973494ea9588ec338877a7eb97d10321e97fd17ba7aa37766d48ba7`

Result: **FAIL**. No implementation was dispatched.

| Nonce | Perspective | Verdict |
| --- | --- | --- |
| `5B301308-5266-471B-8CD3-342B8A0772BD` | Grok crash/authority | FAIL |
| `D4613CDB-05F8-4D2C-B072-E4EFD38C7850` | Kimi backend/operator | PASS; session `714fe8ce-51cb-4459-b4bd-7b211ae326ca` |
| `086CE1C9-8095-4FA9-9901-15804C75FA41` | Composer repository feasibility | FAIL |
| `27CFCE3E-9EF7-4F3C-ACFF-AAF77E285E86` | fresh completion adversary | FAIL |

## Blocking ledger and revision-7 disposition

| ID | Round-six blocker | Revision-7 disposition |
| --- | --- | --- |
| R6-P1 | activation prose allowed multiple recovery choices for one crash point | closed `effectiveActivationSubphase` enum with one named idempotent action per persisted phase; forward and reverse matrices use those names |
| R6-P2 | a recovery process could mutate before winning the maintenance fence | every recovery mutation first acquires the exclusive project-maintenance lease with epoch, route-set and fencing CAS; losers are diagnose-only |
| R6-P3 | activation intent/seal/generation records had no frozen paths/schema identities | name intent, seal, authority-row and protected-generation schemas plus fixed protected state-root paths |
| R6-P4 | dynamic routes did not mechanically close alias/open-handle writers | global path and OS file-identity reservation, hardlink/cross-project rejection, handle-table scan and expected-replacement CAS |
| R6-P5 | the state-fault suite still depended on an unspecified future manifest | add normative A2/C0/A3 scenario IDs, injection boundaries, expected verdicts, immutable manifest hash and track subsets |
| R6-P6 | Goal/Task/Evaluation contracts lacked concrete schema paths | name and freeze goal-contract, task-contract, evaluation-opportunity and evaluation-independence schemas |
| R6-P7 | reverse cutover could expose a graph not bound by authority | keep post-flip open recovery-only; bind generation, graph and route-set hashes in the authority transaction |
| R6-P8 | candidate code could weaken the external fault oracle/manifest | pin raw manifest bytes in A0 external control; changes require previous-supervisor plus human approval |
| R6-P9 | cohort identity could be reset by routine contract revision | use externally approved independence class stable across revisions for criterion lineage and causal root |
| R6-P10 | sidecar/bootstrap/backend/degraded-mode provenance was underspecified | pin an external executable and one-time bootstrap key; enrich backend receipts; preserve explicit JSON-only checks without silently imposing SQLite |

Revision 7 requires four new detached-snapshot reviews.

PLAN REVIEW STATUS: FAIL
