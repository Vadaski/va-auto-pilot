# Run Journal

> Append-only memory for each VA Auto-Pilot cycle.
> Keep reusable knowledge in `Codebase Signals`, append cycle notes under `Entries`.

## Codebase Signals
- Add reusable patterns and gotchas here.

## Entries
## 2026-02-23T00:00:00.000Z - AP-001
- Summary: Initialized run journal.
- Files: `docs/todo/run-journal.md`
- Signals:
  - Keep this log append-only; never rewrite old entries.
---

## 2026-02-23T18:16:27.919Z - parallel-runner
- Summary: synchronized 1 parallel track(s) before quality gates.
- Primary Task: AP-001
- Tracks: AP-001:TIMEOUT
- Files:
  - `/Users/vadaski/vadaski/Code/auto-pilot/.va-auto-pilot/parallel-runs/AP-001.log`
- Note: exit-0 moves task to Review; manager agent must still run multi-perspective review and acceptance gates.
---

## 2026-02-23T18:16:35.705Z - parallel-runner
- Summary: synchronized 1 parallel track(s) before quality gates.
- Primary Task: AP-001
- Tracks: AP-001:TIMEOUT
- Files:
  - `/Users/vadaski/vadaski/Code/auto-pilot/.va-auto-pilot/parallel-runs/AP-001.log`
- Note: exit-0 moves task to Review; manager agent must still run multi-perspective review and acceptance gates.
---

## 2026-02-23T18:28:25.081Z - AP-001
- Summary: Upgraded Multi-Perspective Review section in va-auto-pilot-protocol.md. Two independent AI cross-reviews (adversarial adopter, protocol designer) each found 3 CRITICALs — all 6 resolved: anchor identification guard added, confidence replaced with concrete completion condition, 3-cycle iteration cap added, bounded stall procedure, perspective count heuristic, re-review = full set. Template synced. validate-distribution passed.
- Files: `docs/operations/va-auto-pilot-protocol.md`, `templates/docs/operations/va-auto-pilot-protocol.md`, `docs/todo/human-board.md`
- Signals:
  - multi-perspective review must use anchor+constraint grounding before selecting perspectives
  - completion condition must be concrete and checkable not vague confidence
  - all review loops must have bounded iteration caps
---

## 2026-02-23T18:54:44.849Z - AP-002
- Summary: Fixed parseArgv boolean flag regression: bool flag followed by non-flag token now throws instead of silently dropping the value. e.g. --json false now gives a clear error. Mirrored to templates/scripts/lib/sprint-utils.mjs. All gates passed.
- Files: `scripts/lib/sprint-utils.mjs`, `templates/scripts/lib/sprint-utils.mjs`
- Signals:
  - parseArgv boolean flag guard: reject non-flag token after bool flag with explicit error
  - never allow silent value drops in arg parsers
---

## 2026-02-23T18:54:53.575Z - AP-003
- Summary: Added sprint-board.mjs add command: auto-assigns next sequential ID (AP-NNN), requires --title and --priority, supports --source and --depends-on. nextTaskId() escapes regex special chars in projectPrefix to prevent injection. printHelp updated. Both scripts/sprint-board.mjs and templates/scripts/sprint-board.mjs updated identically. All gates passed.
- Files: `scripts/sprint-board.mjs`, `templates/scripts/sprint-board.mjs`
- Signals:
  - sprint-board add command: use normalizeTask for all new tasks to ensure schema consistency
  - escape regex metacharacters when building dynamic RegExp from user-supplied strings
  - always mirror scripts/ changes to templates/ counterpart
---

## 2026-02-23T19:06:31.523Z - AP-004
- Summary: cli-flow test entry
---

## 2026-02-23T19:06:45.207Z - AP-004
- Summary: cli-flow test entry
---

## 2026-02-23T19:10:47.479Z - AP-004
- Summary: Added 41-test unit suite (node:test) covering all pure functions in sprint-utils.mjs and sprint-board.mjs CLI surface. Added check:units to package.json and check:all pipeline. Tests use isolated tmp dirs; no real state files touched.
- Files: `scripts/test-units.mjs`, `package.json`
- Signals:
  - node:test is available in Node>=20 with no extra deps; use spawnSync for CLI-level tests; always use writeTmpState() for isolated state in unit tests
---

## 2026-02-23T19:10:53.790Z - AP-005
- Summary: Replaced hand-rolled YAML line parser in readSprintPathsFromConfig with yaml.parse(). Moved yaml from devDependencies to dependencies (it is a runtime import). stripYamlValue kept as exported compat utility. Templates mirrored. All 41 unit tests still pass.
- Files: `scripts/lib/sprint-utils.mjs`, `templates/scripts/lib/sprint-utils.mjs`, `package.json`
- Signals:
  - yaml package must be in dependencies not devDependencies when used in runtime scripts; keep stripYamlValue as compat export when removing internal use
---

## 2026-02-23T19:11:01.495Z - AP-006
- Summary: Added test-flows/sprint-board-cli.yaml (9 CLI flows covering add, update, journal, next, summary, --help, error cases) and scripts/test-cli-flows.mjs runner. Flows with isolated_state/isolated_journal get tmp copies of real files to prevent state pollution. check:cli-flows added to check:all.
- Files: `test-flows/sprint-board-cli.yaml`, `scripts/test-cli-flows.mjs`, `package.json`
- Signals:
  - CLI flow tests must use isolated_state to avoid polluting real sprint state; test-cli-flows.mjs skips chat-based flows (session:/turns:) transparently; cwd must be repo root
---

## 2026-02-23T19:11:07.411Z - AP-007
- Summary: Renamed docs/human-out-of-the-loop.md to docs/human-on-the-loop.md. Updated title and all occurrences of backtick-quoted term inside doc. Updated README.md and README.zh.md references. Old file deleted.
- Files: `docs/human-on-the-loop.md`, `README.md`, `README.zh.md`
- Signals:
  - human-on-the-loop is the correct framing: human supervises the loop but does not step into it; the old term implied human removal which is wrong
---

## 2026-02-23T19:23:55.804Z - AP-008
- Summary: Eliminated templates/scripts/ dual-copy. bin/va-auto-pilot.mjs init now copies scripts verbatim from the package's own scripts/ directory (single source of truth). validate-distribution.mjs mirror equality section removed; requiredFiles list pruned to remove templates/scripts/* entries. 41/41 unit tests, 18/18 CLI flow MUSTs, validate:distribution all pass. Init smoke test confirmed correct script output. Dry-run path verified. Multi-perspective review (Correctness Auditor + CLI Consumer): no critical findings.
- Files: `bin/va-auto-pilot.mjs`, `scripts/validate-distribution.mjs`, `templates/scripts/ (deleted)`
---

## 2026-02-23T19:31:44.940Z - AP-009
- Summary: Added Strategic Decomposition section to docs/operations/va-auto-pilot-protocol.md and templates/docs/operations/va-auto-pilot-protocol.md. Section activates on strategic (vague, multi-axis) goals. Key design decisions: dimensions emerge from goal analysis, not fixed lists — consistent with the constraint/anchor/perspective model; dimension-scan concurrency defers to the existing Concurrency Contract (model-native by default, experimental runner requires human opt-in); convergence produces a run-journal entry with defined schema; guard bounds the case where goal scope exceeds one sprint. Adversarial review (Sprint 4 post-sprint gate) surfaced one WARNING: concurrency section tension — fixed by adding explicit deference to Concurrency Contract and serialization fallback; one WARNING: unstructured journal entry — fixed by adding schema; one WARNING: honor-system guard — fixed in AP-010. All gates pass.
---

## 2026-02-23T19:31:54.606Z - AP-010
- Summary: Added Sprint Completion Gate section to docs/operations/va-auto-pilot-protocol.md and templates/docs/operations/va-auto-pilot-protocol.md. Section runs before any sprint is declared Done. Key design decisions: reviewer receives only the git diff and changed file state — no intent context; manager must assign a specific perspective derived from what changed (examples show stake-based framing, not role labels); CRITICAL findings block completion and re-enter task loop; WARNING requires recorded disposition. Critical design fix from adversarial review (Sprint 4 post-sprint gate): the guard was a disclosure, not a control. Fixed: when fresh-context condition is flagged imperfect, all PASS findings are downgraded to WARNING pending genuine fresh-context review. This makes the imperfection consequential rather than cosmetic. Self-referential note: this sprint's adversarial review was run by the implementing agent (imperfect fresh-context). Per the new guard, PASS findings from that review are treated as WARNING. Flagged in this journal entry. All gates pass.
---

## 2026-02-23T19:41:32.839Z - AP-011
- Summary: Added retrospective failure log (pitfalls.json) and pitfall guide CLI to sprint-board.mjs. Structured failureDetail on update --state Failed. pitfall command: add/resolve/list with isolated_pitfalls test support. Pitfall count surfaced in sprint-board summary. Protocol updated: Operational Memory Contract (read pitfalls.json each cycle), State Update Contract (record pitfall on Failed), Delegation Contract (inject pitfalls into Hard constraints). Sprint Completion Gate adversarial review (reliability engineer / write-only log perspective) found 3 WARNINGs: two fixed (summary pitfall count, list summary line), one accepted (fuzzy keyword overlap in protocol is intentional flexibility).
- Files: `scripts/sprint-board.mjs`, `scripts/test-cli-flows.mjs`, `scripts/validate-distribution.mjs`, `docs/operations/va-auto-pilot-protocol.md`, `templates/docs/operations/va-auto-pilot-protocol.md`, `templates/.va-auto-pilot/pitfalls.json`, `test-flows/pitfall-cli.yaml`
- Signals:
  - pitfall command uses --pitfalls-file for test isolation
  - readPitfalls falls back to empty state if file missing
  - failureDetail only written when at least one structured field is provided
  - --list --json returns raw entries array
---

## 2026-02-23T19:55:34.948Z - AP-012
- Summary: Rewrote README.md, README.zh.md, website/index.html, and website/app.js to communicate VA Auto-Pilot design philosophy with conviction. Led with the design bet (frontier-model-first by design), articulated six core intellectual contributions (constraint-derived perspectives, manager-as-delegator, CLI correctness guarantee, frontier-model scaling property, strategic decomposition, failure compounding), added honest when-to-use/when-not-to-use sections, updated website hero/philosophy/loop/compare sections, added Strategic Decomposition to state machine detail and adversarial Sprint Completion Gate to Done state. codex review found P0 JS syntax error (unescaped Chinese quotes in double-quoted string) — fixed by replacing with Chinese corner brackets. Sprint Completion Gate: 3 parallel adversarial reviewers (skeptical senior engineer, future power user, first-time reader) all returned PASS with no CRITICAL findings; 5 WARNINGs all accepted with rationale. NOTE: Sprint Completion Gate was run by implementing agent — all PASS findings treated as WARNING per protocol guard; no CRITICAL findings surfaced under this control downgrade.
- Files: `README.md`, `README.zh.md`, `website/index.html`, `website/app.js`
---

## 2026-02-23T20:13:13.383Z - AP-013
- Summary: Rewrote website/index.html and website/app.js i18n strings for marketing conviction. Hero: 'The loop frontier models deserve.' (6-word headline). Signal pill 1 leads with model tier requirement (Claude Opus 4 / GPT-5). Philosophy reduced from 5 descriptive cards to 3 provocative claim cards. Compare section leads with NOT-for-you disqualifiers including model tier. Demo updated to show 3 key loop moments: sprint planning, adversarial catch, pitfall prevention. ZH strings encoded as unicode escapes for JS safety. All quality gates pass. Adversarial review (burned-by-hype-marketing perspective) cleared with no CRITICAL findings.
- Files: `website/index.html`, `website/app.js`
---

## 2026-02-24T05:47:01.040Z - AP-014
- Summary: Optimized protocol Delegation Contract to be fully CLI-driven. Phase 1: rewrote Decision Loop as annotated bash, Delegation Contract as CLI lifecycle with prompt template, start prompt with all 13 CLI steps. Phase 2 (multi-perspective review): adopter perspective found 3 CRITICALs (gate duplication, pitfalls.json direct read, codex install missing), philosophy perspective found 2 CRITICALs (start prompt is recipe, 'no more' restricts model). Fixed: (1) start prompt reduced to 14-line mandate+pointer+hard-rules (no recipe), (2) 'exactly these sections -- no more' changed to 'at least', (3) pitfalls.json read replaced with CLI command, (4) inlined gates replaced with reference to Quality Gates section, (5) rigid lifecycle reframed as Delegation Invariants. All gates pass.
- Files: `docs/operations/va-auto-pilot-protocol.md`, `docs/operations/start-va-auto-pilot-prompt.md`
- Signals:
  - Protocol changes must survive two-perspective review: adopter (can they execute it?) and philosophy (does it violate goal-first?). Start prompt must never duplicate the Decision Loop -- pointer only. Delegation Prompt sections are a minimum contract ('at least')
  - not a maximum. Gate commands belong in Quality Gates section only -- reference by name elsewhere.
---

## 2026-02-24T06:00:29.392Z - AP-015
- Summary: Added va-auto-pilot upgrade command with version tracking, file classification (always-overwrite scripts, never-overwrite user state, merge-aware templates), upgrade-in-progress sentinel for crash detection, and token resolution from existing config.yaml. Two-perspective review (operator + security auditor) found 4 CRITICALs: config.yaml unprotected, raw token writes on --force, raw tokens on new files, no crash detection. All fixed: config.yaml added to NEVER_OVERWRITE, resolveContextFromConfig reads user values before template rendering, sentinel written before/removed after file ops. 7 new CLI flow tests for upgrade safety.
- Files: `bin/va-auto-pilot.mjs`, `test-flows/upgrade-cli.yaml`
- Signals:
  - config.yaml must always be in NEVER_OVERWRITE. Template files written during upgrade must be rendered through applyTemplate with user's context. Upgrade sentinel prevents partial upgrade state. Scripts are always safe to overwrite (single source of truth).
---

## 2026-03-02T06:33:42.006Z - AP-019
- Summary: Verified all quality gates: typecheck (tsc --noEmit, pass), lint (eslint, clean), test (164/164 pass, node --test), codex-review (configured as 'codex review --uncommitted', CLI binary exists at /opt/homebrew/bin/codex v0.106.0 but hits usage limit — gate is WIRED but BLOCKED by credits). build gate (npm run check:all) passes all sub-gates. Codex-review is NOT auto-invoked by sprint-board.mjs; it is documented in config.yaml and protocol.md as a manual step the agent must run.
---
