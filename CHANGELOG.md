# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
