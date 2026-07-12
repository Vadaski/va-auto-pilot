# vNext Plan Round 10 Preflight Ledger

Status: **STALE; revision 15 diagnostic PASS only; non-authorizing**

Revision 16 changed the plan after governance-bundle inventory exposed a
pre-approval TCB implementation loop. The frozen-candidate section below is
retained as diagnostic history and must not be used for a round-ten snapshot.

This ledger records the iterative, read-only checks used to decide whether the
vNext architecture is ready to enter formal round ten. It is not a formal
review manifest, does not substitute for preserved raw reviewer output, and
does not authorize implementation.

## Frozen candidate

- Plan: `docs/plans/vnext-durable-autonomy-architecture.md`
- SHA-256: `017c58baee8344e3e4782cfbbe3120675263a110fc3dd286c1e9e34831203c27`
- Size at freeze: 221,995 bytes; 3,000 lines
- Repository base commit: `501aac4192ae76ce0ea57c7295452879b9a52b4a`
- Repository base tree: `01582b62a6f91bcb21e278b75ed8f1c95cb37c58`

Any plan-byte change invalidates this result.

## Failed candidate history

| Revision | Exact plan SHA-256 | Preflight result | Blocking themes |
| --- | --- | --- | --- |
| 10 | `38db2f15f168364c398cffeedbff3f2012c9a46fd875971b005ab8ba5df3124a` | FAIL | task-proof substitution; non-mechanical history rewrite; missing unique lineage/ref-ABA protection; unreviewed bootstrap parser; future-object slot paradox; candidate manager inside the HMAC TCB |
| 11 | `dc6caa8afcfe0f6b7e239d3b1c8006197bf0a87eba27c8f60daeec8b6b295694` | FAIL | Git saga did not freeze ref generation/reflog anchor; Goal lacked a unique head/ref generation; install slot burn; source/artifact/runtime closure gap; future A0 lacked fresh review |
| 12 | `acf9db169cac5decc77695e71a4c93cc6be3b0803e2f416c2290e6e6da4f36d7` | FAIL | ref-CAS/reflog TOCTOU; install repair/driver not closed; pre-A0 dual-authority risk; successor-bundle qualification gap; parser self-authorization |
| 13 | `68ccdfecef00912941a4fcad5574d3fb34522a9681387c22bccfae8c0cf43e9b` | FAIL | bootstrap purpose confusion; external-registry ownership contradiction; coordinator lifecycle gap; staging sandbox/oracle gap; incomplete Task trusted read; unqualified reflog |
| 14 | `81e096d9e781a200f832cf6654f8bbdcedb71db58feaa6c4e99de31c77768efe` | FAIL | external `bound` not wired into every trusted consumer; target repair lacked unique fencing/recovery; `update-ref prepare` SIGKILL left an unrecoverable ref lock; Goal provisional read was ambiguous |

Revision 15 intermediate hashes
`cbb530414339a60e253c223b2b1a8728746ad6cb86817b6d44d4856d1f3b3680`
and `35eb8559be92c3cf62ffb3495e9d71b29a4bb46f1dc64e4d72af3f143df3fe66`
each reached zero blocking findings. Their nonblocking findings were folded into
the final candidate, so their PASS observations are stale and diagnostic only.

## Final exact-hash confirmation

Four independent read-only perspectives recomputed the frozen SHA-256 before
and after review. Each reported the exact frozen hash above and made no file
edits.

| Perspective | Focus | CRITICAL | P1 | P2 | Result |
| --- | --- | ---: | ---: | ---: | --- |
| state/crash consistency | durable bind rejection, sequential reverse/epoch drift, global target eligibility and repair regression | 0 | 0 | 0 | PASS |
| Git and completion lineage | durable GO result/child generation, guardian/orphan recovery, Task/Goal promotion bindings | 0 | 0 | 0 | PASS |
| false-success adversary | rejection lost-ack, reverse/finalization ordering, GO replay, direct-current Goal proof | 0 | 0 | 0 | PASS |
| fresh Grok exact-hash check | the same four delta closures plus regression sampling | 0 | 0 | 0 | PASS |

The final checks specifically confirmed:

1. a unique append-only kernel bind-rejection record is loaded before any retry
   can reevaluate a vanished conflict;
2. a completed reverse or authority tuple drift cannot later legitimize a
   pending bootstrap finalization;
3. Git cannot execute before a supervised child identity and durable,
   generation-bound GO result exist, and an old GO capability cannot release a
   replacement child; and
4. direct-current and promoted Task/Goal attestations carry the same exact
   promotion proof and bindings before canonical trusted reads can return true.

## Decision

`PRE-FLIGHT STATUS: PASS`

Formal round ten remains blocked until an out-of-repository governance bundle
and detached snapshot are frozen. Formal reviewers must receive those exact
bytes, emit closed `ReviewerOutputV1` objects in fresh sessions, pass both
independent auditors, and be followed by an independent operator signature over
the archived raw outputs and full findings arrays. No implementation dispatch
is authorized by this ledger.
