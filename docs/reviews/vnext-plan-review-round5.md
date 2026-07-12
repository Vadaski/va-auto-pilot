# vNext Architecture Plan Review — Round 5

Detached snapshot:

- commit `4280285be4f9212e0adf2b29a040abb2e5c8e59f`
- tree `1a1ab9f4bbdde583af0c3b0d5f22f21456f6bb73`
- plan SHA-256 `83f7af31c4233a6fd3d634efcc371f965e9c5d8c29d32c09b6176d138d1185bb`

Result: **FAIL**. No implementation was dispatched.

| Nonce | Perspective | Verdict |
| --- | --- | --- |
| `9E230794-5146-48DF-8E9D-11019C504112` | Grok crash/authority | FAIL |
| `1178AE19-EC3C-4E50-B3E9-988D74A5E040` | Kimi backend/operator | FAIL; session `94945231-de22-41dc-a66d-5b1f59c68108` |
| `FEF71228-ADA8-485D-B487-194296B61B61` | Composer repository feasibility | FAIL |
| `DB21C835-C1AE-4791-88EC-6116F0CDB5A0` | fresh completion adversary | FAIL |

## Blocking ledger and revision-6 disposition

| ID | Round-five blocker | Revision-6 disposition |
| --- | --- | --- |
| R5-P1 | pre-authority missing DB/open rule contradicted kill recovery | add protected activation intent/seal and distinct pre-authority recovery vs post-authority fail-closed cells |
| R5-P2 | forward cutover relied on cooperative locks and had TOCTOU | normative freeze/sentinel/integrity-guard table; protected frozen graph is exact import source under continuous lock generation |
| R5-P3 | reverse flipped JSON before authority graph existed | materialize and hash-CAS every registered route/generation before flip |
| R5-P4 | dynamic state/board/journal/pitfall/history routes escaped registry | approved dynamic-route registry/adopt/quarantine policy; full-trusted rejects unknown routes |
| R5-P5 | TaskAcceptanceContract was not stored and A2 could false-Done | add task-contract table; A2 Git bind reaches GitBoundUntrusted; only C1 current proof reaches TaskDone |
| R5-P6 | evaluationOpportunity could be Sybil-created | external cohort/causal-root policy, one sample weight per cohort, external independence approval |
| R5-P7 | trust-root/signature envelope remained prose | Ed25519 + RFC8785 schemas, protected key providers, replay/rotation/revocation and two-key finalization |
| R5-P8 | sidecar IPC/capability remained prose | length-framed canonical JSON, closed methods, HMAC handshake/token schema, typed errors and replay store |
| R5-P9 | fault/corpus artifacts lacked schemas and track mapping | freeze state-domain/fault/corpus schemas and exact `check:state-faults --track` scenario mapping |
| R5-P10 | capability/doctor/migration CLI behavior lacked schemas | add capability→command matrix and doctor/migration-plan output schemas |

Revision 6 requires four new detached-snapshot reviews.

PLAN REVIEW STATUS: FAIL
