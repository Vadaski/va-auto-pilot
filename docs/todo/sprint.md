# Sprint Board

> Last updated: 2026-04-15 by VA Auto-Pilot
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
| - | - | - | - | - |

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
| AP-020 | AP-020: va-anima 语义记忆升级 | 2026-03-25 | va-anima 213 tests pass, build pass. Ebbinghaus遗忘曲线+语义记忆升级 committed at 40696e5 |
| AP-027 | 循环自驱：auto-pilot-loop 完成一轮后自动检测 backlog 并重启下一轮 | 2026-03-29 | - |
| AP-028 | Auto commit：gate 通过后自动 stage + commit，消除变更堆积 | 2026-03-29 | - |
| AP-038 | Fix fail-open review gate: reviewer timeout/failure must not silently become PASS | 2026-04-04 | Codex fix: review gate now fails closed. Timeout/crash/no-output -> passed=false. Missing REVIEW STATUS -> fail closed. 8 new regression tests. 219 tests pass. |
| AP-039 | Fix fail-open sprint-board review: git errors suppressed, FAIL status does not cause non-zero exit | 2026-04-04 | Codex fix: sprint-board review now exits non-zero on FAIL/AMBIGUOUS. Git errors warn to stderr. 6 new regression tests. 219 tests pass. |
| AP-040 | Sprint 2-bis: refactor enforce-staged = runDoctorOnSnapshot(stagedConfig, stagedIndex) + checkStagedDiff, resolving B14/B15/B16 | 2026-04-14 | Sprint 2-bis refactor: enforce-staged=runDoctorOnSnapshot+checkStagedDiff; 43/43 mode tests including B14/B15/B16 regression cases; committed 98fe458 (loop misclassified as review-fail due to codex review unstructured output) |
| AP-046 | auto-pilot infra: review gate must tolerate unstructured codex output (retry/log/pass when tests+build pass) — current fail-closed causes true-positive tasks to be misclassified | 2026-04-14 | Done in dogfood round 3, committed 2c9d086. See commit body for details. |
| AP-001 | Upgrade multi-perspective review to dynamic perspective selection | 2026-02-23 | Two cross-reviews (adversarial + protocol designer), 6 CRITICALs resolved, templates synced |
| AP-003 | Add sprint-board.mjs add command to create tasks via CLI without hand-editing JSON | 2026-02-23 | add command implemented: auto-ID (AP-NNN), validation, depends-on, regex-safe prefix; printHelp updated; templates mirrored; all gates pass |
| AP-004 | Add unit test suite for sprint-board.mjs pure functions | 2026-02-23 | 41/41 unit tests pass via node:test; check:units added to check:all; all gates pass |
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
| AP-021 | AP-021: Awakener 端到端集成测试 | 2026-03-25 | harness-e2e.test.ts 存在(204行), va-hub 332/332 tests pass; test-harness-chain.sh 存在于 va-project/projects/video-factory/scripts/ |
| AP-022 | va-anima recall: 中文分词支持（query '陷阱 cli 工具' 无法匹配 tag '陷阱'） | 2026-03-25 | fix: 三项记忆系统缺陷修复 commit 1b4eba2 — 中文分词 MemoryTokenizer 已实现，213 tests pass |
| AP-025 | Resolve PF-001: blender_backend.py render 后添加 magic bytes artifact 验证 | 2026-03-25 | blender_backend.py 新增 validate_artifact_magic_bytes()，test_core.py 新增5个 magic bytes 测试，54/54 pass (2 skip for GPU render) |
| AP-026 | Resolve PF-002: cli-anything-blender PATH 修复，FORCE_INSTALLED=1 e2e 测试全绿 | 2026-03-25 | conftest.py PATH 前置修复，FORCE_INSTALLED=1 全部6个原失败e2e测试通过，54 passed 2 skipped |
| AP-029 | 错误恢复策略：失败分类器 + 策略表（build/lint/test/review 各有不同恢复路径）+ 升级机制 | 2026-03-29 | - |
| AP-030 | Review 决策结构化：finding → 自动创建 fix task + 历史修复模式库 + pitfall 自动注入 delegation | 2026-03-29 | - |
| AP-034 | Sprint 5 Task 1: Add layered journal view via journal --view | 2026-04-04 | journal --view implemented: parseJournal+renderJournalView produce layered summary (Active Signals + Recent 5 + Earlier compressed). Protocol/prompt/templates updated. 3 unit + 2 CLI flow tests. check:all passed. Commit 41cd09f. |
| AP-035 | Sprint 5 Task 2: Make sprint completion review perspective dynamic | 2026-04-04 | spawnSprintReviewer() now accepts perspective parameter. selectSprintReviewPerspective() analyzes changedFiles for stakeholder-grounded perspectives (CLI→CI dev, auth→security eng, protocol→adopter, tests→QA). Commit 8bba575. |
| AP-041 | Sprint 1-bis B11: decide archive-with-live-inboundRefs policy (strict reject vs permissive retarget), implement + tests | 2026-04-14 | B11 archiveDocument rejects targets with live inboundRefs; Sprint 1 tests 38/38 green; committed 98fe458 (loop misclassified as dispatch-fail) |
| AP-042 | Sprint 1-bis B12: linkDocuments strength-aware dedup; weak→strong upgrade replaces outbound, inbound stays consistent | 2026-04-14 | B12 linkDocuments strength-aware upsert (weak->strong replaces outbound); Sprint 1 tests 38/38 green; committed 98fe458 |
| AP-044 | Sprint 3: implement adoptDocument() / importLegacyDocument() SDK + CLI for bringing bare files into the managed store | 2026-04-14 | Done in dogfood round 3, committed 2c9d086. See commit body for details. |
| AP-047 | auto-pilot infra: dispatch fail detection — when sub-agent exits !=0 but tests+build pass and code landed, treat as partial-success and run review gate only (not re-dispatch) | 2026-04-14 | Done in dogfood round 3, committed 2c9d086. See commit body for details. |
| AP-048 | adopt test isolation: tests must create git-init'd tmpdir or adopt should fallback fs.rename when git unavailable; also must clean up .journal/ and test-adopt-tmp/ (test leak to repo root observed) | 2026-04-14 | Done in dogfood round 3, committed 2c9d086. See commit body for details. |
| AP-049 | auto-pilot infra: suggest-gate and sprint prompts must read project's actual package.json test script (not hardcode 'npm test'); generalize for any stack | 2026-04-14 | Round 5 dogfood: code landed, check:all green; loop dispatch-detection still has lag but work is done. |
| AP-002 | Fix parseArgv boolean flag regression (--flag value silently dropped) | 2026-02-23 | parseArgv now throws when bool flag is followed by non-flag token; templates mirrored; check:all and validate:distribution pass |
| AP-005 | Replace hand-rolled YAML parser with yaml package in sprint-utils.mjs | 2026-02-23 | yaml package moved to dependencies; readSprintPathsFromConfig replaced with yaml.parse(); stripYamlValue kept as compat export; templates mirrored; all gates pass |
| AP-008 | Resolve templates/ dual-copy maintenance burden | 2026-02-23 | All gates passed: 41/41 unit tests, 18/18 CLI flow MUSTs, validate:distribution. Init smoke test confirmed scripts/ correctly copied to target project. Dry-run path verified. Mirror drift check removed. templates/scripts/ deleted. |
| AP-023 | va-anima reflect: 去重（多 tag 条目在 reflect 中重复出现） | 2026-03-25 | fix: 三项记忆系统缺陷修复 commit 1b4eba2 — reflect 去重已修复，213 tests pass |
| AP-024 | va-anima autoRecall: 双语 tag/triggerConditions 支持（中文 context 无法命中英文 trigger） | 2026-03-25 | fix: 三项记忆系统缺陷修复 commit 1b4eba2 — autoRecall 双语支持已修复，213 tests pass |
| AP-031 | 自适应质量门：pitfall → suggest gate + 自动写入 quality-gates.yaml + 跨项目 gate 继承 | 2026-03-29 | - |
| AP-032 | 默认并行执行：auto-pilot-loop 从单任务循环改为任务池循环，plan 命令输出自动执行 | 2026-03-29 | - |
| AP-036 | Sprint 5 Task 3: Move stack-specific quality gate examples out of protocol | 2026-04-04 | 5 stack-specific example sections extracted to docs/operations/quality-gate-examples.md. Protocol reduced 767→647 lines (-120). Templates synced. Commit 6dabc54. |
| AP-037 | Sprint 5 Task 4: Inject unresolved pitfalls into evaluator review context | 2026-04-04 | sprint-board review command auto-injects stakeholder perspective + unresolved pitfalls. 9 unit tests covering perspective selection, pitfall formatting, prompt construction, full review flow. Protocol updated. Commit dc83411. |
| AP-043 | Sprint 1-bis B13: recovery rolls back target artifacts touched by refs mirror mid-update crash | 2026-04-14 | Actually committed in d199904 (Sprint 1-bis B13 recovery); stale Failed state from loop state race with manual update, reconciled. |
| AP-045 | Sprint 3: migrate subcommand for store-level schema migrations (§14.3 + §11 four-phase preflight/apply/verify/rollback) | 2026-04-14 | All gates pass: 50/50 doc-store tests, 47/47 doc-store-mode tests, 222/222 unit tests, CLI flows PASS, lint clean, distribution valid. Implemented four-phase migration engine (preflight/apply/verify/rollback) with backup/rollback, CLI --plan-only/--from/--to support, and journal integration. |
| AP-050 | auto-pilot infra: colony routing must avoid kimi for Sprint-level multi-file tasks (>200 lines or >3 files); kimi timeout observed at 10min for complex objectives | 2026-04-14 | Round 5 dogfood: code landed, check:all green; loop dispatch-detection still has lag but work is done. |
| AP-051 | auto-pilot infra: gate name 'undefined' in fix-and-retest path — review gate context propagation bug; emit real gate id to journal for diagnosability | 2026-04-14 | Round 5 dogfood: code landed, check:all green; loop dispatch-detection still has lag but work is done. |
| AP-052 | auto-pilot infra: state-file concurrency race (manual sprint-board updates can be overwritten by running loop) + dispatch success-detection lag (sub-agent exit!=0 masks real code landing); also audit all 'npm test' and 'gate undefined' remaining call sites | 2026-04-14 | Round 6 capstone: state race + success detection + path audit + 28 new regression tests; committed manually after loop self-paradox hit 3-fail stop. |
| AP-007 | Correct 'human-out-of-the-loop' framing to 'human-on-the-loop' across docs and website | 2026-02-23 | docs/human-on-the-loop.md created with updated framing; old file removed; README.md and README.zh.md references updated; all gates pass |
| AP-033 | Fresh context review：spawn 隔离的 reviewer agent session（不同 model 或独立 context window） | 2026-03-29 | - |

## Backlog
| Priority | ID | Task | Depends On | Owner | Source |
|----------|----|------|------------|-------|--------|
| P1 | AP-053 | Sprint 4(a): install DocStore pre-commit hook via 'doc-store install-hook' subcommand (idempotent, cascade with existing hooks, uninstallable); writes .git/hooks/pre-commit invoking enforce-staged; tests cover fresh install / existing hook preservation / uninstall | - | - | Sprint 4 plan — DocStore productionization |
| P1 | AP-054 | Sprint 4(b): GitHub Actions CI step for DocStore — extend existing .github/workflows/ci.yml or add new doc-store.yml to run 'doc-store doctor' + 'doc-store enforce-staged --base main' on PRs; required for merge | - | - | Sprint 4 plan — DocStore productionization |
| P1 | AP-055 | Sprint 4(c): Genesis phase 2 — run 'doc-store adopt docs/designs/doc-store-api-draft.md' to nadopt the design doc itself into .docstore/designs/; use preferGitMove to preserve history; commit the adoption as a distinct step | - | - | Sprint 4 plan, design doc §12 Genesis & Bootstrap phase 2 |
| P1 | AP-056 | Sprint 4(d): Flip store config mode legacy -> mixed; managedRoots includes .docstore/designs, .docstore/decisions, .docstore/process; doctor validates post-flip; no regressions in hook behavior | - | - | Sprint 4 plan, design doc §5 Migration Modes |
| P2 | AP-057 | Sprint 4(e): README + start-va-auto-pilot-prompt updates — DocStore usage section (init / adopt / hook install / modes); cross-link from CLAUDE.md Quality Gate section | - | - | Sprint 4 plan |
