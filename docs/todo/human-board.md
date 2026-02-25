# Human Board

> Human writes objectives and constraints here.
> VA Auto-Pilot reads this at the start of every cycle.
> Processed items must be marked `[x]`, never deleted.

---

## Instructions (highest priority)

- [x] 要设计更新机制，对未来本协议升级的兼容性要考虑到
> Processed 2026-02-23: AP-015 complete. Added `va-auto-pilot upgrade` command with version tracking (version.json with schemaVersion), file classification (always-overwrite scripts, never-overwrite user state, merge-aware templates), token resolution from existing config.yaml, and upgrade-in-progress sentinel for crash detection. Two-perspective review (operator + security auditor): 4 CRITICALs found and fixed. 10 upgrade CLI flow tests. All gates pass.

- [x] 对于 instruction， 还需要深度优化，比如我希望委派是通过执行 cli 命令完成，需要讲清楚，你要先理解项目设计哲学再进行优化，你可以开多视角来反复优化。
> Processed 2026-02-23: AP-014 complete. Delegation Contract rewritten as CLI-driven invariants (not rigid sequence). Decision Loop as annotated bash. Start prompt reduced to 14-line mandate+pointer+hard-rules. Two-perspective review (adopter + philosophy architect): 4 CRITICALs found and fixed — start prompt recipe eliminated, "no more" → "at least", pitfalls.json → CLI command, inlined gates → Quality Gates reference. All gates pass.

- [x] 复盘日志 (retrospective failure log): when a quality gate or acceptance fails, CLI captures structured failure metadata (what attempted, what failed, failure hypothesis, missing context) and writes to a pitfall guide. Manager agent reads pitfall guide at cycle start alongside Codebase Signals. Implementation delegation injects relevant pitfalls into sub-agent prompts. Each fix annotates the entry with resolution. Closes the loop: failure → structured metadata → reusable avoidance knowledge. Converted to AP-011.
> Processed 2026-02-23: AP-011 complete. sprint-board pitfall command (add/resolve/list), failureDetail on update --state Failed, templates/.va-auto-pilot/pitfalls.json, protocol updated (Operational Memory, State Update, Delegation contracts), pitfall count surfaced in sprint-board summary. 9 new CLI flow tests. All gates pass. Committed and pushed.
- [x] Add two new protocol capabilities: (1) Strategic Decomposition — when goal is high-level/vague, launch parallel dimension-scan agents first, each with independent constraints and current-state audit, then converge into backlog; (2) Mandatory post-sprint adversarial review — fresh-context agent, no prior history, adopts a specific sharp critical perspective (not generic), finds what the sprint team was blind to. Both must feel like natural extensions of the constraint/anchor/perspective philosophy already in the protocol. Model decides dimensions and adversarial viewpoint dynamically — no fixed lists. See full direction below.
> Processed 2026-02-23: AP-009 and AP-010 both Done in Sprint 4. Strategic Decomposition section added to protocol (dynamic dimensions, parallel scan, convergence → backlog, guard against infinite decomposition). Sprint Completion Gate added (stake-grounded adversarial perspective, CRITICAL blocks completion, imperfect fresh-context guard). Dogfooded immediately — adversarial reviewer caught 3 WARNINGs pre-merge.
[x] 我希望让这个 loop 拥有实现高维度复杂问题的能力，例如用户说，给我推进到商业化的水准，那么这里就应该引导模型进行深入思考，先发散思考有多少个维度，现在的限制条件是什么（现在是什么时候了？），尽可能每一个方向都有自己的独立约束，然后我认为可以并发的启动不同的 cli 去进行多视角拆解，先摸清现状，再汇总，把一个问题拆解成多个方向的问题进行推进，另外，要时刻保持一种心态叫做，不要觉得自己一轮就能搞定全部任务，而是要尝试在完成之后再次进行独立 review（不能带有前一个的上下文，需要独立视角，越毒辣越好，需要带着某个强视角去 review，而不是泛泛的 review 一下这个），边界和约束、多视角碰撞，是解决高纬度复杂问题的关键。
> Processed 2026-02-23: Converted to AP-009 (Strategic Decomposition phase) and AP-010 (mandatory post-sprint adversarial review) in sprint backlog.

- [x] AP-008 decision: implement Option C. Remove templates/scripts/ entirely. Have `va-auto-pilot init` copy scripts directly from the installed package's scripts/ directory. templates/ keeps only genuine per-project templates (config, docs, sprint-state). Update bin/va-auto-pilot.mjs + validate-distribution.mjs accordingly. Rationale: models getting stronger means single-source-of-truth designs scale better — eliminate the whole class of mirror drift bugs rather than patching them.
> Processed 2026-02-23: Deleted templates/scripts/ (4 files, 1607 lines removed). bin/va-auto-pilot.mjs init now copies scripts verbatim from package scripts/. validate-distribution.mjs mirror checks removed. All gates pass. Committed and pushed.
- [x] Sprint 2 dogfood run: use va-auto-pilot itself to develop the next feature sprint. Keep complete journal and sprint records. Design philosophy: maximize delegation to CLI and sub-agents. Manager agents must not implement — they delegate. Codex review found bug in AP-002. AP-003 adds the missing `sprint-board.mjs add` CLI command. Execute both tasks through the full quality loop: implement → review → acceptance → commit → push.
> Processed 2026-02-23: Executing AP-003 (primary, P1) and AP-002 (parallel, P2) concurrently via sub-agent delegation. Both tasks independent. Quality gates enforced: check:all → multi-perspective review → validate:distribution before commit.

[x] 让 Claude code 和 codex 交叉 review 改进，先让他们理解这套哲学，然后进行改进，直到两个都互相挑不出毛病为止，要充分考虑到模型的强大，不要写死各种东西限制它们的发挥，另外多视角这件事我希望不只是我们能定义，而且应该提示模型可以根据当前的需求场景临时定义最需要最合适的视角，不要给予假设和限定，但是在定义视角的时候必须要充分考虑当前的真实约束条件，以及锚点，让合适的视角自然的涌现，一切问题都是分类问题，可分的前提是给予了正确的约束条件，如果锚点对了，问题迎刃而解，如果解决遇到问题，那么就是视角和锚点错了，要换视角，换锚点。这是本项目的设计哲学。写完就推送就好了，最好自己吃自己的狗粮来验证。
> Processed 2026-02-23: Rewrote Multi-Perspective Review in va-auto-pilot-protocol.md. Two independent cross-reviews (adversarial adopter + protocol designer) each found 3 CRITICALs. All 6 CRITICALs resolved: added anchor identification guard, replaced undefined "confidence" with concrete completion condition, bounded review loop with 3-cycle cap, made "change anchor" a bounded procedure ref, added perspective count heuristic, specified re-review = full perspective set. Template synced. Pushed.

[x] 真正需要注意的问题（5 observations）
> Processed 2026-02-23: Converted to sprint backlog via `sprint-board.mjs add`. AP-004 (unit tests, P1), AP-005 (YAML parser, P2), AP-006 (test-flows coverage, P1), AP-007 (naming fix, P3), AP-008 (templates architecture, P2 — architectural decision required before implementation).

- [x] **CI 补全**：目前 GitHub Actions 只有 `deploy-website.yml`（部署静态站），缺少代码质量 CI。新建 `.github/workflows/ci.yml`，在 push/PR 到 main 时运行 `npm ci && npm run check:all`。Node 20。参考 va-agent-protocol 的 CI 写法。

- [x] **README.zh.md 同步**：英文 README 已大改版（加了 Protocol Comparison 对比表、Why Frontier Models Need This、Relationship to va-agent-protocol、扩展 Roadmap），中文版完全没跟上。同步所有新增章节到 README.zh.md，保持中文 README 与英文结构一致。

- [x] **.npmignore 优化**：当前 npm publish 把 `.claude/settings.local.json`、`.va-auto-pilot/sprint-state.json`、`.va-auto-pilot/parallel-runs/`、`.github/` 等内部文件全发了出去。完善 .npmignore，只保留 `bin/`、`scripts/`、`templates/`、`skills/`、`test-flows/`、`docs/operations/`、`README.md`、`LICENSE`、`CONTRIBUTING.md`、`package.json`。发布 0.1.1 修复。

- [x] **CHANGELOG.md 创建**：项目没有 CHANGELOG。创建 CHANGELOG.md，补录 v0.1.0 的主要功能（sprint execution loop、CLI quality gates、pitfall compounding、adversarial review、upgrade command、62 tests）。使用 Keep a Changelog 格式。

- [x] **清理无用 devDependency**：`tsx` 在 devDependencies 里但没有任何 script 使用它（test-runner.ts 是 reference implementation，实际测试用 node:test）。要么删除 tsx，要么把 test-runner.ts 正式接入 scripts。建议删除 tsx，保持零 devDep 的简洁性。

- [x] **website 国际化修复**：检查 website/ 中的文案是否与最新 README 的定位一致。特别是 tagline（应该是 "CLI-first autonomous multi-agent engineering loop"，不是 "USB interface"）、对比表信息、Frontier Models 章节是否在 landing page 有体现。

## Feedback (to fold into next cycle)
- npm publish 时 tarball 含 53 个文件、340KB，偏大。优化 .npmignore 后应显著缩小。
- va-auto-pilot 和 va-agent-protocol 的关系需要在两个 README 和 website 中都讲清楚，避免用户困惑。

## Direction (long-term)
- va-auto-pilot 是 sprint execution engine，va-agent-protocol 是 universal task protocol。两者互补。
- 考虑把 va-auto-pilot 作为 va-agent-protocol 的 monorepo 子包（packages/auto-pilot），简化维护和版本同步。
- 未来：MCP Server Adapter 让 VA Auto-Pilot 可以被任何 MCP client 直接调用。
