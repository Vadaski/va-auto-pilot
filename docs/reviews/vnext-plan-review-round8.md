# vNext Architecture Plan Review — Round 8

Detached read-only snapshot:

- commit `13589e4a877a2f5a7681c42a28e75cd4ef158707`
- tree `bac19050b4dab9c9a18da29ed056248eff722fdb`
- plan SHA-256 `8d938bfcb357e45927093a377a583c540d896618ff3477bbbec33ce3f41de496`

Result: **FAIL**. No implementation was dispatched.

| Nonce | Perspective | Verdict |
| --- | --- | --- |
| `104A7987-C503-4849-8E41-E2002C062B06` | Grok crash/authority | FAIL: one CRITICAL, one P1 |
| `99B99E4D-EF1C-4392-80CE-A5F175BCC2E2` | Kimi backend/operator | PASS; session `5a89546f-a7f2-4b0a-ab86-227e62939376` |
| `0314DDC1-41E7-4720-B3FC-8AED5C590233` | Composer repository feasibility | PASS |
| `54F62CA0-3E4F-43BB-9111-E4C488233731` | Codex fresh false-success adversary | FAIL: two P1; session `019f4eff-2449-75b1-a11d-ad58fb0b2d53` |

All four reviewers matched the nonce, commit, tree, plan hash and clean target,
and reported no target mutation. Kimi again used a writable empty wrapper whose
only repository input was a symlink to the read-only target. Codex independently
reconstructed HEAD/index/worktree cleanliness after macOS developer-tool cache
warnings in its read-only sandbox.

## Blocking ledger and revision-9 disposition

| ID | Round-eight blocker | Revision-9 disposition |
| --- | --- | --- |
| R8-C1 | reverse materialized live JSON routes could drift before flip/exit while bound export hashes stayed green | never promote repository routes back to authority: reverse separates an immutable export bundle from a service-owned `protected-json-v2` activation generation under the external control root; repository/Git paths remain projections; active open verifies the exact authority head, and later L1 writes use immutable generations plus one protected head CAS |
| R8-P1 | Git was both a generic outbox effect and a dedicated saga, yielding two actions; post-bind/pre-terminal had no action and prose could mark Done early | exclude Git from generic outbox; freeze `prepared→commit-object→ref-updated→kernel-bound` phases/actions, including kills after `commit-tree`/`update-ref` but before phase CAS; bind exact Git result and `GitBoundUntrusted` in one transaction; TaskDone remains a separate atomic C1 policy transition |
| R8-P2 | attestation rechecked ref/tree but could trust a different same-tree commit/parent | make exact commit OID a first-class current dependency and release/publish expected identity; use an immutable completion draft/input hash so T1 proof envelopes cannot construct a same-tree T2 attestation; add commit-replacement/substitution faults |
| R8-P3 | signed approval bound contract/purpose but not necessarily project/checkout/task audience and exact candidate/Git object; nonce consumption was not atomic with authorization | bind typed audience and exact approved object/saga/proof tuple; verify signature, consume nonce, record approval/dependencies and create first authorized state in one kernel transaction; approval/key revocation invalidates every dependent saga/proof/attestation |

## Non-blocking hardening adopted

- Mark Node 20 as legacy/manual after its official EOL while preserving the
  `>=20` compatibility floor; qualify Node 22/24/26 separately and move the PR
  backend cell to the oldest maintained line.
- Make the Linux fallback exactly `~/.local/state/va-auto-pilot`; name
  receipt/archive/calibration schemas; document untrusted online/air-gap
  supervisor acquisition and `soak-unavailable` behavior.
- Add parallel-runner, observe/intervene and eval-history surfaces explicitly to
  corpus/A2 inventory; freeze the candidate-backlog schema path.
- Reserve first-adoption epoch `0` and type the shared exit verifier by validated
  forward/reverse tuple.

Revision 9 requires four new detached-snapshot reviews.

PLAN REVIEW STATUS: FAIL
