# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
