# vNext Architecture Plan Review — Round 7

Detached read-only snapshot:

- commit `04e2c56edef52119f07a4a923639d79ad9903c25`
- tree `7f0db928c97c176b21945ebd7be404a5880f90cd`
- plan SHA-256 `e316004e3070b9a9380fc48b7b4d04ab9617af21a40da88714a41491f2c00a62`

Result: **FAIL**. No implementation was dispatched.

| Nonce | Perspective | Verdict |
| --- | --- | --- |
| `E6FB8618-70C6-4E40-9F41-D22AE6C7C651` | Grok crash/authority | FAIL: one CRITICAL, three P1 |
| `7AC99949-3969-421B-8A4B-A68E1ECA7566` | Kimi backend/operator | FAIL; session `53d84438-6934-4248-8468-65c906727bee` |
| `305C1198-7511-40CB-AF2E-2F2E0C00E7F7` | Composer repository feasibility | FAIL: one P1 |
| `01351705-B7E0-4E37-8270-76DC163591B9` | fresh completion adversary | FAIL: three P1 |

All reviewers matched the declared nonce, commit, tree, clean status and plan
hash. Kimi used a writable empty wrapper containing only a symlink to the same
read-only target because its CLI rejects a non-writable `--work-dir`; it verified
the resolved target and target permissions.

## Blocking ledger and revision-8 disposition

| ID | Round-seven blocker | Revision-8 disposition |
| --- | --- | --- |
| R7-C1 | first authority commit could select normal SQLite open while forward seal/project remained incomplete | closed `authority.phase`; first commit is `activating`; normal production open requires exactly `active+none+no maintenance lease`; final exit changes all three in one DB transaction |
| R7-P1 | global write-next-subphase prose contradicted post-effect seal/project/export CAS | delete shortcut and give every forward/reverse operation an exact pre/post/atomic advance boundary |
| R7-P2 | reverse pointer verification and final `phase=active` had two competing completion edges | pointer verification stays `reverse-transition`; only final exit may atomically activate and release maintenance |
| R7-P3 | kill-order claim used generic/missing outbox, shadow, archive and epoch actions | freeze `RecoveryAction`, external-effect observer contract, state→action table and named fault rows for shadow/outbox/archive/epoch/inbox |
| R7-P4 | public `gates maintain --apply` config writer escaped registry/A2/corpus | add `auto-pilot-gates.mjs`, script/bin routers, imported-call provenance, config trust-control lint and executed corpus attack |
| R7-P5 | GoalComplete could combine criterion proofs from different Git trees and remain trusted after revocation/ref drift | add final-tree `GoalCompletionAttestation`, full criterion re-proof, stale/revoked current state and release-time ref observation |
| R7-P6 | unchanged top-level gate could indirectly replace package script, harness or criterion verifier | freeze externally resolved `trust-control-closure`; any control byte/path change enters bootstrap; dynamic unknowns are manual/noncalibratable |
| R7-P7 | outcome dimension in the unique key allowed one evaluation opportunity to settle opposite outcomes twice | move outcome to value; unique key ends at exclusivity group; corrections revoke/replace atomically; concurrent conflicts have zero weight |

## Reviewer discrepancy and non-blocking hardening

Kimi reported that `sealed` mapped to `resume-seal`; the reviewed bytes at the
declared hash actually mapped `sealed` to `resume-project`. The finding is
factually rejected, but its explicit FAIL still makes the strict round manifest
fail. Its useful P2 notes were adopted: lazy optional native adapter behavior,
the 2,000,000-byte pack budget, x64/arm64 and glibc/musl receipts, signed
bootstrap artifact distribution, exact pre-vNext baseline commit, dynamic
remote-import denial and dedicated multi-hour soak runners.

Composer P2 notes were also adopted: explicit state registry/fault schema paths,
router/intent/parallel writer inventory, journal fault row, and a signed
capability-skip receipt that closes B2b on unsupported platforms.

Revision 8 requires four new detached-snapshot reviews.

PLAN REVIEW STATUS: FAIL
