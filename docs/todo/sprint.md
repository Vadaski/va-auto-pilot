# Sprint Board

> Last updated: 2026-03-02 by VA Auto-Pilot
> Generated from `.va-auto-pilot/sprint-state.json` via `node scripts/sprint-board.mjs render`.
>
> Rules:
> - Machine source of truth: `.va-auto-pilot/sprint-state.json`
> - Human-readable projection: `docs/todo/sprint.md`
> - One primary task at a time in `In Progress`; independent tracks may run in parallel
> - Task ID format: `AP-{3-digit number}`
> - Priority: P0(blocking) / P1(important) / P2(routine) / P3(optimization)
>
> State flow:
> ```
> Backlog -> In Progress -> Review -> Testing -> Done
>                  ^                     |
>                  +------ Failed <------+
> ```

---

## In Progress
| ID | Task | Owner | Started | Notes |
|----|------|-------|---------|-------|
| AP-004 | Add unit test suite for sprint-board.mjs pure functions | - | 2026-02-23 | - |

## Failed
| ID | Task | Fail Count | Reason | Last Failed |
|----|------|------------|--------|-------------|
| - | - | - | - | - |

## Review
| ID | Task | Implementer | Security | QA | Domain | Architect |
|----|------|-------------|----------|----|--------|-----------|
| - | - | - | - | - | - | - |

## Testing
| ID | Task | Test Flow | MUST Pass Rate | SHOULD Pass Rate |
|----|------|-----------|----------------|------------------|
| - | - | - | - | - |

## Done
| ID | Task | Completed | Verification |
|----|------|-----------|--------------|
| AP-013 | Rewrite website copy with marketing conviction — hooks, not features | 2026-02-23 | All gates pass: node --check, npm run check:all, npm run validate:distribution. Codex review: no CRITICAL/BUG findings (P2 sprint.md board artifact only). Adversarial review (burned-by-hype-marketing perspective): no CRITICAL findings, 2 WARNINGs accepted with rationale. |
| AP-017 | va-lives: 固化 tsx 依赖，消除 spawn 脚本对 npx 临时拉包的依赖 | 2026-03-02 | - |
| AP-001 | Upgrade multi-perspective review to dynamic perspective selection | 2026-02-23 | Two cross-reviews (adversarial + protocol designer), 6 CRITICALs resolved, templates synced |
| AP-003 | Add sprint-board.mjs add command to create tasks via CLI without hand-editing JSON | 2026-02-23 | add command implemented: auto-ID (AP-NNN), validation, depends-on, regex-safe prefix; printHelp updated; templates mirrored; all gates pass |
| AP-006 | Expand test-flows to cover add, update, journal, and next CLI commands | 2026-02-23 | sprint-board-cli.yaml added (9 flows, 18 MUST/3 SHOULD); test-cli-flows.mjs runner with isolated_state/isolated_journal; check:cli-flows added to check:all; all gates pass |
| AP-009 | Add Strategic Decomposition phase to protocol for high-level goals | 2026-02-23 | Strategic Decomposition section added to both protocol files. Specifies strategic vs tactical detection, parallel dimension-scan with independence constraint, structured audit report format, convergence step with run-journal schema, and transition back to tactical loop. Concurrency follows existing Concurrency Contract. Guards are bounded. npm run check:all and npm run validate:distribution pass. |
| AP-010 | Add mandatory post-sprint independent adversarial review phase to protocol | 2026-02-23 | Sprint Completion Gate section added to both protocol files. Specifies adversarial reviewer setup (fresh context, diff-only), manager-assigned specific perspective grounded in what changed, structured finding report format, CRITICAL-blocks / WARNING-requires-disposition enforcement, and guard with control-downgrade semantics (not just disclosure) when fresh context is unavailable. npm run check:all and npm run validate:distribution pass. |
| AP-011 | Add retrospective failure log: capture structured failure metadata and pitfall guide | 2026-02-23 | pitfall CLI (add/resolve/list), failureDetail on update --state Failed, templates/.va-auto-pilot/pitfalls.json, protocol updated (Operational Memory, State Update, Delegation contracts), pitfall count in summary, 9 new CLI flow tests pass, all 41 unit tests pass, validate:distribution passes |
| AP-012 | Rewrite website and README to clearly articulate framework's design philosophy and competitive advantage | 2026-02-23 | README.md, README.zh.md, website/index.html, website/app.js rewritten to communicate design philosophy: frontier-model-first, constraint-derived perspectives, CLI correctness guarantee, manager-delegates pattern, strategic decomposition, adversarial sprint completion gate, failure compounding. All gates passed: check:all PASS, validate:distribution PASS, codex review PASS (P0 JS syntax bug found and fixed). Sprint Completion Gate: 3 adversarial reviewers (skeptic/future-user/first-timer) all returned PASS with no CRITICAL findings. |
| AP-014 | Optimize protocol delegation contract to be fully CLI-driven with clear design philosophy grounding | 2026-02-24 | All gates pass: npm run check:all (41/41 units, 36/36 CLI MUST, validate:distribution). Two-perspective review (adopter + philosophy architect): 4 CRITICALs found, all 4 fixed. 5 WARNINGs dispositioned (1 fixed, 4 accepted with rationale). |
| AP-015 | Design protocol update mechanism with forward-compatible upgrade path | 2026-02-24 | All gates pass: npm run check:all (41 unit tests, 62/62 CLI MUST, validate:distribution). Two-perspective review (operator mid-sprint + security auditor): 4 CRITICALs found and fixed (config.yaml protected, token resolution during upgrade, upgrade sentinel). 10 upgrade-specific CLI flow tests. |
| AP-016 | 为 va-lives 五大生命补充认识论立场（哥德尔多视角架构） | 2026-03-02 | - |
| AP-018 | va-hub Awakener: 检测 va-lives 中的 du/wu/yan agent 并通过 Colony 分发任务 | 2026-03-02 | - |
| AP-019 | va-auto-pilot: 验证质量门 typecheck/lint/test/codex-review 实际执行情况 | 2026-03-02 | - |
| AP-002 | Fix parseArgv boolean flag regression (--flag value silently dropped) | 2026-02-23 | parseArgv now throws when bool flag is followed by non-flag token; templates mirrored; check:all and validate:distribution pass |
| AP-005 | Replace hand-rolled YAML parser with yaml package in sprint-utils.mjs | 2026-02-23 | yaml package moved to dependencies; readSprintPathsFromConfig replaced with yaml.parse(); stripYamlValue kept as compat export; templates mirrored; all gates pass |
| AP-008 | Resolve templates/ dual-copy maintenance burden | 2026-02-23 | All gates passed: 41/41 unit tests, 18/18 CLI flow MUSTs, validate:distribution. Init smoke test confirmed scripts/ correctly copied to target project. Dry-run path verified. Mirror drift check removed. templates/scripts/ deleted. |
| AP-007 | Correct 'human-out-of-the-loop' framing to 'human-on-the-loop' across docs and website | 2026-02-23 | docs/human-on-the-loop.md created with updated framing; old file removed; README.md and README.zh.md references updated; all gates pass |

## Backlog
| Priority | ID | Task | Depends On | Owner | Source |
|----------|----|------|------------|-------|--------|
| - | - | - | - | - | - |
