# vNext Architecture Plan Review — Round 1

Plan reviewed: `docs/plans/vnext-durable-autonomy-architecture.md` revision 1.
Result: **FAIL**. Implementation was not dispatched.

## Reviewers

| Perspective | Runner | Verdict |
| --- | --- | --- |
| crash consistency / transaction boundaries | Grok CLI, configured default model | FAIL |
| SQLite portability / migration operator UX | Kimi CLI deep research | FAIL |
| repository feasibility / writer inventory | Cursor Agent Composer 2.5 | FAIL |
| false-success / cross-domain adversary | fresh-context subagents | FAIL |

Round-one raw output was produced before the content-bound review-manifest
mechanism existed. This ledger preserves the blocking substance; revision 2
must be reviewed again with content hashes and raw-output hashes.

## Merged blocking ledger and revision-2 resolution

| ID | Round-one finding | Revision-2 resolution |
| --- | --- | --- |
| R1-C1 | authority cutover preceded writer migration and could create dual authority | split shadow-import from A3 cutover; require complete writer migration, maintenance/quiescence and authority epoch |
| R1-C2 | “one transaction boundary” ignored Git, human board, DocStore and artifact external effects | add explicit domain registry/classification and saga boundary; Done waits for observed Git commit |
| R1-C3 | candidate-controlled gate/profile/validator could certify itself | dual-plane previous-approved supervisor and bootstrap review for trust-control changes |
| R1-C4 | temp cwd did not enforce filesystem/process isolation | require per-platform strong sandbox or `calibration-unsupported`; add escape attack fixtures |
| R1-P1 | B2 feedback existed before canonical receipts | split B2a/B2b; depend on C1/C2 and disable automation until calibrated |
| R1-P2 | mutable constraint counters could duplicate or survive revoked evidence | immutable feedback ledger with unique fact key and derived views |
| R1-P3 | selection/dispatch/receipt did not bind one immutable constraint snapshot | CAS catalog revision with dispatch; bind snapshot/policy/epoch into receipt |
| R1-P4 | claim/heartbeat had multiple authorities and wall-clock ordering | leases are sole authority; fencing CAS orders mutations; heartbeat becomes projection |
| R1-P5 | JSON/SQLite parity claim was impossible for arbitrary multi-aggregate transactions | split L1/L2 capabilities and return typed unsupported errors |
| R1-P6 | journal, plan-review, evidence, eval and workspace writers were missing | add full writer registry plus architecture lint and projection classification |
| R1-P7 | legacy constraints/evidence could be silently promoted or malformed lines skipped | byte-preserving quarantine; legacy-unverified/probation and legacy-untrusted evidence |
| R1-P8 | stale compatibility projection could mislead old consumers | versioned generations + atomic manifest pointer; old unaware consumers observational only |
| R1-P9 | receipt retention broke feedback references/hash chain | archive catalog, segment roots/anchors/tombstones; referenced receipts never bare-delete |
| R1-P10 | mutation had no clean positive controls or per-gate coverage | clean→mutated expected fail→clean differential; per-required-gate trust lattice |
| R1-P11 | receipt validation did not gate real approval/commit | canonical trusted-proof policy and full approve/commit negative matrix |
| R1-P12 | exact argv was impossible for legacy shell strings | structured gate config v2; legacy shell cannot become calibrated proof |
| R1-P13 | native SQLite could pass pack/help but fail first real DB use | real packed-tarball backend qualification without hiding install scripts |
| R1-P14 | four-review rule was not machine enforced | content-bound unique-review manifest; any plan change stales all reviews |
| R1-P15 | “days-scale” had no measurable workload/SLO | 72h virtual PR stress, 8h nightly, 72h release soak and bounded growth/recovery SLOs |

Revision 2 requires a full new review round; this file does not claim the
findings are closed until those reviewers pass the revised text.

PLAN REVIEW STATUS: FAIL
