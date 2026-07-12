# vNext Architecture Plan — Round 9 Preflight Ledger

Status: diagnostic preflight PASS for plan SHA-256
`84090e8f050b49383368bc5ef9955d9df79e28659518ce00a3991967f0027821`.
This ledger is non-authorizing; implementation remains blocked until the four
independent detached-snapshot formal reviews all PASS.

## Blocking findings closed during preflight

| Source / reviewed plan hash | Blocking finding | Disposition in final preflight bytes |
| --- | --- | --- |
| Grok / `42d1e437...c97fc6` | reverse could retain full-trusted capability; C1 TaskDone preceded C2 calibration; Node qualification was not an open predicate; soak/default activation was global | effective capability is the minimum of a backend representation ceiling and exact current predicates; C1 creates only provisional terminal state; Node/environment qualification is checked before leases; production grants are per execution cell |
| Grok / `80066813...ed9919` | SQLite import wrote `backend_max=sqlite-provisional`, making full-trusted mathematically unreachable | SQLite writes the `full-trusted` representation ceiling, which grants nothing by itself; protected JSON writes the hard `protected-json-manual` ceiling |
| state-machine audit / `e9c517c7...b02e14` | protected COW `prepared` stored only a mutation hash and could not recover without caller memory | `prepared` atomically stores bounded canonical mutation schema/bytes/hash and the exact base; caller-free restart is a required fault |
| completion/Git audit / `e9c517c7...b02e14` | provisional goal attestation had no promotion action; clean/mutate/clean calibration had no durable saga; OS labels allowed durability-environment collisions | goal promotion is a separate aggregate; calibration has frozen phases and preallocated attempt IDs; qualification/grants bind an externally approved durability class plus runtime probe/observation |

## Final preflight checks

All checks read the exact final plan path and rechecked the SHA before and after
inspection. Any earlier hash-mismatch result was discarded rather than counted.

| Perspective | Result |
| --- | --- |
| Grok capability/real-operation adversary | PASS: reverse ceiling, provisional terminal, candidate-execution, fixture-to-production grant, calibration saga and durability class have no remaining P0/P1 |
| fresh completion/Git adversary | PASS: promotion, calibration attempts, exact commit/tree, approval/revocation and crash recovery have no remaining P0/P1 |
| fresh authority/state-machine adversary | PASS: forward/reverse/open, protected COW payload recovery, backend ceiling and durability probes have no remaining P0/P1 |

Next step: build one clean read-only detached snapshot containing the plan and
round ledgers, then run Grok, Kimi, Composer and a fresh-context Codex reviewer.

PRE-FLIGHT STATUS: PASS
