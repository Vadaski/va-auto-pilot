# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Evidence-backed pitfall rule promotion, effectiveness feedback, confidence decay, retirement, and deterministic conflict quarantine
- Regression coverage for multi-run workspace routing, cross-process human-board writes, commit approval manifests, stale locks, process-tree timeouts, DocStore path containment, scaffold symlink safety, and fail-closed quality/E2E gates
- `--min-score` support for judged quality runs; `--no-judge` is now an explicit collection-only mode

### Changed

- Commit approval now binds task IDs, approved files, file hashes or isolated-worktree commits, evidence references, and the integration `HEAD`; changed context requires fresh approval
- Git commits now serialize across parallel tracks and processes, run hooks against an isolated approved index, atomically publish the real index, and advance `HEAD` with compare-and-swap while preserving unrelated staged changes
- Run-scoped commands reuse the workspace persisted at initialization, while active claims and executor locks prevent cross-run or duplicate dispatch
- Plan review, permission checks, and quality probes fail closed on empty, malformed, destructive, or incomplete evidence
- Judged quality runs require a one-to-one probe binding and derive aggregate scores from rubric dimensions instead of trusting a reported total
- Primary evidence is secret-redacted before persistence; shareable bundles add path redaction and all managed evidence paths reject symlinked parents
- Human intent updates and parallel state transitions now use locked atomic read-modify-write operations
- Run/track transitions now use a durable hash-checked transaction intent; corrupt control state and ambiguous post-GO launches fail closed instead of being treated as empty or dead
- Orchestrated `await-workers` now explicitly uses the crash-safe spawn lifecycle (not Colony routing), with durable logs and launcher-owned deadlines across manager crashes
- Auto-generated pitfall constraints now enter probation, use exact multilingual token relevance, and stay out of hard prompts until curated; concurrent pitfall additions are serialized
- `check:all` and CI now enforce lint across source, E2E, tests, and website JavaScript; package publication also runs deterministic checks and E2E
- Coverage now includes focused and legacy unit suites, fails below the recorded 80/80/80/65 line/statement/function/branch floor, and runs in CI plus prepublish validation

### Fixed

- Made `done`-run shutdown recovery converge immediately after a crash: `recover --apply` now releases residual claims, clears checkpoint/review state, and removes stale active-run entries without waiting for lease expiry, while halted/error and live-worker cases remain fail-closed
- Prevented run/task identifiers and DocStore artifact paths from escaping managed roots
- Prevented `init` and `upgrade` from following destination or parent-directory symlinks outside the target project
- Prevented stale or dirty task worktrees, unrelated working-tree changes, and squash recovery from silently entering approved commits
- Terminated spawned worker process trees on timeout/intervention (POSIX process groups; Windows `taskkill /T`) instead of leaving descendants alive
- Preserved sibling active runs during shared/isolated workspace initialization and recovery
- Preserved completed worker results through commit approval, commit, and journal recovery phases; missing or stale execution approval now returns the run to plan approval instead of dispatching
- Prevented interrupted re-reviews from reusing an earlier PASS result and prevented checked items outside the Human Board Instructions section from satisfying intent reconciliation
- Added a READY→persist→GO worker launcher barrier with token heartbeats, including zero-config legacy-root runs; recovery/claim cleanup now serializes with the executor, halt survives late settlement, PID/token identity clears only after verified exit, and stale/ambiguous identity blocks destructive cleanup
- Recovered pilot-owned Git `index.lock` files across process crashes on either side of the atomic `HEAD` update using a hard-link/inode owner marker; byte-identical foreign locks and changed user indexes fail closed, while short writes and ambiguous `update-ref` results are verified before cleanup
- Kept plan-review verdict parsing bound to the model response stream so Codex stderr diagnostics cannot invalidate a valid final PASS; conflicting explicit verdicts across stdout/stderr and CR/Unicode line separators still fail closed
- Raised measured timeout budgets for multi-process cockpit and unattended CLI flows so loaded CI hosts do not report false regressions while still retaining bounded execution

## [0.2.1] - 2026-07-01

### Added

- Human-facing cockpit (`va-auto-pilot cockpit`) and goal-first CLI (`goal`, `plan-from-goal`)
- Explicit orchestrated mode with `orchestrate plan`, `review-plan`, `approve-plan`, `dispatch`, `await-workers`, `commit`, and `recover` phases
- Governance checkpoints, permission scope policy, budget guardrails, and eval gate runner
- Observability evidence contract, read-only MCP resources, and runtime evidence bundles
- `colony-bridge.mjs` graceful fallback to raw agent spawn when `va-agent-protocol` is not resolvable
- Distribution validation smoke test for packed artifact quick-start path

### Changed

- Default `--agent-template` is now a vendor-neutral placeholder that fails fast with a clear error; users must configure an agent template or worker override before dispatch
- `CLAUDE.md` aligned with the actual stack: `checkJs`/`allowJs` TypeScript (`strict: false`), ESLint, Node built-in test runner + `c8`
- README softened the "model cannot self-certify" claim to reflect that CLI gates catch obvious cheating and force observable evidence, but cannot cryptographically prove gate meaning
- README documented the `colony-bridge` / `va-agent-protocol` coupling and fallback behavior
- TypeScript coverage expanded to all `scripts/**/*.mjs` and `bin/**/*.mjs`; fixed type errors across source and test files
- Centralized timeout/concurrency constants in `scripts/lib/constants.mjs`
- Extracted shared `planTaskIds` helper to `scripts/lib/plan-helpers.mjs`
- Extracted sprint-board pure functions (`normalizeTask`, `findNextTask`, `buildParallelPlan`, etc.) to `scripts/lib/sprint-board/core.mjs`
- Hardened agent dispatch against shell injection by splitting commands into argv and using `spawn(file, args, { shell: false })`
- `sprint-board.mjs` main entry now guarded by `pathToFileURL(process.argv[1]).href === import.meta.url`
- `check:sprint` now validates state file format without requiring a specific runtime state (`summary --validate`)
- Website CI validation (`check:website`) verifies `app.js` syntax and `softwareVersion` consistency
- Cleaned up 22 resolved placeholder adaptive gates from `.va-auto-pilot/config.yaml`
- Aligned `README.zh.md` section order with `README.md`
- Added `AGENTS.md` with agent-focused conventions, commands, and release checklist
- Started splitting `test-units.mjs` into focused `tests/*.test.mjs` files

## [0.2.0] - 2026-04-15

### Added

- ManagedDocStore SDK + WAL + single-handle contract (Sprint 1–3)
- Mode-aware enforcement (`legacy | mixed | managed`) + init/doctor lifecycle
- Human-board parser strictness: only checkbox bullets count as instructions
- Layered journal view (`sprint-board journal --view`)
- Adaptive gates, parallel execution, sprint completion review
- Error recovery classification + structured review pipeline
- Loop auto-restart, auto-commit, commit failure rollback
- Pluggable quality gates — project-specific build/test/acceptance
- LLM quality observation: judge + trend tracking
- E2E test harness with 10 deterministic scenarios
- Feedback → learn loop: failures auto-pitfall, resolutions auto-gate
- Standalone `va-review` skill — contextual review with perspective + pitfalls
- Dynamic perspective selection for sprint completion review
- Recovery rolls back mirrored targets (DocStore Sprint 1-bis B13)
- Meta rounds 5–8: test-script discovery, colony routing, gate naming, prompts, state race + success detection + loop self-refit (AP-052), state artifacts cleanup
- Constraint-library seeding (Phase 1 PoC) + YAML-loader bridge (Phase 1.1)
- DocStore Sprint 4: install-hook + CI workflow + design-doc self-adoption
- SKILL 5.0.0 with DocStore + constraint library
- Skill source-install mode: bootstrap from local checkout via symlink

### Fixed

- Review gate self-heal (fail-closed semantics for unstructured output)
- Human-board parser only treats checkbox bullets as instructions
- Pitfall re-resolve guard

### Changed

- Review gate output normalized to REVIEW STATUS + structured findings
- Sprint board add/update commands surface full audit trail

## [0.1.0] - 2026-02-24

### Added

- CLI scaffold (`va-auto-pilot init .`) for zero-config project bootstrapping
- Goal-first delegation protocol for autonomous task planning
- Manager/worker architecture with role-based agent separation
- CLI quality gates enforced at every step
- Adversarial post-sprint review for self-correcting feedback loops
- Pitfall compounding to prevent recurring failure patterns
- Parallel execution tracks for concurrent workstreams
- Sprint board with machine-readable YAML and markdown views
- Upgrade command with version tracking and forward-compatible upgrade path
- 41 unit tests and 62 CLI flow tests for comprehensive coverage
- Distribution validation to ensure publish integrity

### Note

- Requires frontier coding model capability for reliable autonomous operation.
