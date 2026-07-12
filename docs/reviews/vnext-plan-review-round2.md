# vNext Architecture Plan Review — Round 2

Plan SHA-256:
`78fbe46be5f2c5199d6c111b3e28ffb594ce6d564ef426b916b95cfc364f0687`.
Result: **FAIL**. No implementation was dispatched.

## Review identities

| Review ID | Runner/perspective | Result |
| --- | --- | --- |
| `r2-grok-crash` | Grok CLI default model; crash/authority review | FAIL |
| `r2-kimi-portability` | Kimi deep research; backend/operator portability | FAIL; Kimi session `d507eeb6-75f5-4684-b5c8-b157742b7fd8` |
| `r2-composer-feasibility` | Cursor Agent Composer 2.5; repository feasibility | FAIL |
| `/root/vnext_r2_adversary` | fresh-context Codex subagent; false-success/completion | FAIL |

The external session manager verified the plan hash before accepting each
result. Round three replaces this manual record with random nonces and a
bootstrap manifest; round-two outputs remain failed evidence.

## Blocking ledger and revision-3 disposition

| ID | Round-two blocker | Revision-3 disposition |
| --- | --- | --- |
| R2-C1 | live C1/B2 L2 state was scheduled while JSON remained authoritative | reorder: A2 contains no live L2; A3 establishes SQLite authority before C1/B2 |
| R2-C2 | candidate worker could directly mutate future DB/approval/supervisor | move control DB/approval/pinned supervisor outside repo; deny worker/gate access via mandatory sandbox/capability boundary |
| R2-C3 | gate proof was not proof of the current human goal | introduce versioned GoalAcceptanceContract and criterion coverage bound through dispatch/receipt/approval/Git/Done |
| R2-P1 | A3 depended on calibrated B2b and could never cut over on unsupported sandbox platforms | A3 depends only on A2; B2b is post-cutover and capability-gated |
| R2-P2 | isolated workspaces and parallel/colony diagnostic paths were missing from registry | add explicit workspace and diagnostic globs plus fixed module/allowlist categories |
| R2-P3 | backend qualification was conflated with `validate:distribution --ignore-scripts` | add separate real-DB `validate:backend-qualification` CI matrix; distribution smoke is not backend evidence |
| R2-P4 | C1 enforcement surface was underspecified | C1 now follows A3 and must gate every approve/commit/bypass path through one trusted-proof policy |
| R2-P5 | epoch could not fence non-cooperative pre-vNext binaries | external control state remains protected; real packed old-writer attack is required; fixed legacy paths need proven fail-closed sentinel or cutover refuses |
| R2-P6 | discovery hint and reverse-authority kill orders were incomplete | define fixed control-root open algorithm; hint is projection; add reverse, hint, archive and Git bind kill points |
| R2-P7 | quiescence ignored Git/DocStore/outbox/gate effects | define all-scope quiescence and lease lattice; required external effects must drain or become explicit conflict |
| R2-P8 | goal/gate bypass flags could still create false Done | add `ReadyToCommit` and one terminal policy; no-commit/dry-run/skip/waive remain non-trusted/non-terminal |
| R2-P9 | feedback key allowed repeated receipts to inflate samples and ignored post-GO changes | outcome fact keyed per episode/dimension with receipt evidence set; catalog/goal changes durably invalidate in-flight episodes |
| R2-P10 | four-review enforcement had a bootstrap loop | define one-time external manager bootstrap verifier/nonces, then migrate it into trust-controlled A0 control plane |
| R2-P11 | days-scale reports lacked external oracle, load definition and dead-letter budget | pin external workload/fault/oracle; add PR wall-clock, nightly/release rates, recovery samples and zero required dead-letter budget |
| R2-P12 | existing adaptive gate code silently rewrites external config | replace with explicit reviewed proposal/outbox and bootstrap trust-control invalidation |

Revision 3 requires four entirely new reviews. This ledger does not itself close
the findings.

PLAN REVIEW STATUS: FAIL
