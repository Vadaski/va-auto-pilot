# vNext Architecture Plan Review — Round 9

Detached read-only snapshot:

- commit `d011be500bce9f60fcfe856e9d3912b2106a2250`
- tree `fa4914da7382163ec0b290520e4c526911442ced`
- plan SHA-256 `84090e8f050b49383368bc5ef9955d9df79e28659518ce00a3991967f0027821`
- clean/read-only identity verified before and after all reviews

Result: **FAIL**. No implementation was dispatched. The machine-readable
diagnostic manifest is `vnext-plan-review-round9.manifest.json`; exact successful
reviewer stdout/stderr streams are under `docs/reviews/raw/` and match the hashes
in that manifest.

| Nonce | Perspective / underlying model | Verdict |
| --- | --- | --- |
| `34F29B41-5DAE-4375-98D4-D2E7E802E5BA` | Grok crash/authority/capability | FAIL: two P1 |
| `D00F070B-53EC-4D76-A487-88B5DD5F7B7A` | Kimi backend/operator | FAIL: three P1; session `2a2ed455-9ca5-4b65-b638-58557f6a16df` |
| `9D3A6D30-5D37-4B63-B64F-0777A624DD5E` | Composer 2.5 repository feasibility | FAIL: one P1; session `d0085787-4a0f-45d1-86ea-4a9eca0ccef4` |
| `2D884B28-DE02-4BF7-B8E9-71CD7AAE9163` | GPT-5.4-high fresh false-success adversary | FAIL: one CRITICAL and two P1; session `eb6a5b66-7d10-4c08-aa5c-3929387f2176` |

Codex quota, Claude authentication and Gemini client-eligibility probes failed
before those models read the plan; they are recorded as non-review launch
failures and were not counted. The replacement GPT reviewer used a fresh
independent underlying model/session/nonce from the Composer reviewer even
though both were reached through the Cursor Agent frontend.

## Blocking ledger and required revision-10 disposition

| ID | Round-nine blocker | Required revision-10 disposition |
| --- | --- | --- |
| R9-C1 | the first qualification-fixture and production grants require a “previous trusted supervisor,” but no such signer exists for the first release | expand the externally approved bootstrap-supervisor ceremony to sign exactly one scoped fixture grant and, after valid D2 evidence, exactly one first production grant; bind plan/release/cell/runner/soak/nonces, require human countersignature, then rotate and seal the bootstrap authority |
| R9-P1 | the four-review bootstrap manifest/verifier is an A0 trust gate but has no frozen machine schema | freeze review manifest, reviewer output and bootstrap-verifier schemas; make all identity/input/output hashes, unique perspectives/models/sessions, strict verdict parsing and fail conditions required; reject legacy dry-run PASS |
| R9-P2 | a C1/L2 write can silently destroy reverse capability before the explicit irreversible-finalization checkpoint | keep all reverse-blocking L2 writers dark until a two-key irreversible-finalization record is current; make finalization the only transition that surrenders reverse, expose it in capability/doctor, and fault-test every attempted pre-finalization L2 write |
| R9-P3 | first-adoption semantic conflict persists no named destination subphase and still advertises `resume-freeze` | atomically persist finding hash plus pre-authority `manual-conflict`; both first adoption and reactivation map only to `diagnose-only`; add a kill-after-finding fault |
| R9-P4 | TaskDone has no canonical current-read equivalent to GoalComplete, so ref/commit/tree drift or same-tree replacement may leave downstream readers green | introduce task-completion attestation and one `canCountTaskCompletion()` path for dependency scheduling/cockpit/MCP/feedback; re-observe exact Git identity and all proof/capability dependencies; drift records TaskProofStale before false |
| R9-P5 | top-level Node `>=20` “support” can be read as post-cutover manual operation even though Node 20 is deliberately read-only after cutover | state the boundary precisely: Node >=20 can install/read/diagnose legacy state, but post-cutover mutation requires a maintained qualified Node; Node 20 post-cutover is read-only |
| R9-P6 | a checkout-scoped Unix socket inside the deep persistent state path exceeds Linux/macOS `sun_path` limits | separate persistent state from a short authenticated runtime IPC namespace; use `$XDG_RUNTIME_DIR` or a short protected `/tmp` path and Windows named pipe; qualify path length/ownership/collision/cleanup |
| R9-P7 | revoking the one-time bootstrap key could transitively invalidate the finalized first authority and make the project permanently read-only | seal the accepted bootstrap anchor/rotation receipt as historical trust evidence; compromise/revocation forbids future signatures but cannot retroactively erase finalized authority; define explicit recovery for compromise before sealing |
| R9-P8 | “acquire from npm” can be interpreted as installing the supervisor under candidate `node_modules` | make npm/release an untrusted download transport only; the trusted installer verifies and extracts exclusively into the protected content-addressed external installation; reject every project/node_modules loader or dependency path |

## Non-blocking hardening adopted for revision 10

- Make A0 fail if the Git index still owns any mutable runtime-authority path;
  `.va-auto-pilot/workspaces/**` must be ignored while curated fixtures remain
  tracked.
- Scrub and fault-test `NODE_OPTIONS`, `LD_PRELOAD`,
  `DYLD_INSERT_LIBRARIES`, `DYLD_LIBRARY_PATH` and equivalent loader variables;
  test paths with spaces.
- Require the native adapter to be an optional/dynamically loaded dependency;
  define its offline bundle path and prove old-writer tarball reproducibility
  with the pinned npm/toolchain.
- After bounded terminal/promotion retries, stop active polling and requeue only
  on a relevant dependency event; never infer success.
- Release the protected-JSON “current write” slot in the same head-bind
  transaction while retaining immutable history.
- Legacy `dryRun: true, passed: true` review output is diagnostic only and is
  structurally rejected by the bootstrap authorization schema.

Revision 10 requires a new detached snapshot and four entirely new review
sessions. Round-nine PASS cannot be recovered by majority vote.

PLAN REVIEW STATUS: FAIL
