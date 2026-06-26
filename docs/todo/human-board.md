# Human Board

> Human writes objectives and constraints here.
> VA Auto-Pilot reads this at the start of every cycle.
> Processed items must be marked `[x]`, never deleted.

---

## Instructions (highest priority)

- [x] **Reopen Sprint：把 VA Auto-Pilot 做成最强 Harness + Loop Engineering 开源项目。**
  先清理过时叙事，再分解工程任务，不要反过来。
  当前判断：重新开源前必须统一公共叙事，避免让用户误解为特定厂商/模型绑定、MCP/A2A 竞争者、单纯 prompt/protocol 模板，或只是一套本地 dogfood 脚手架。
  目标定位：
  - VA Auto-Pilot 是独立可用的 CLI-first autonomous engineering loop。
  - 它以 Loop Engineering 为骨架，以 Harness Engineering 为可靠性层。
  - 它也是 va-agent-protocol 的 reference engine / managed-agent implementation；va-agent-protocol 是任务协议契约，不是 Auto-Pilot 独立运行的硬依赖。
  - 它应与 MCP/A2A 等连接层互补，而不是被表述成同层竞争者。
  - 它应能被 Codex、Claude Code、Cursor、Kimi 或任何可用 CLI Agent 驱动；公共文档不要暗示只有某一厂商 agent 才能使用。
  立即分解方向：
  1. Public narrative cleanup：清理 README、README.zh、website、articles、protocol 中的过时表达，包括厂商绑定、旧模型名、过强自夸、MCP/A2A 对抗表述、`protocol engineering` 旧核心叙事、旧模板路径。
  2. Harness + Loop positioning：补强“它在 agent stack 里的层级”与 Harness/Loop 对应表，让新读者 60 秒内明白它是什么、不是什么、和 va-agent-protocol 的关系。
  3. Reopen readiness：补齐开源首屏、安装路径、generic CLI agent 使用说明、distribution smoke、release checklist。
  4. Next-gen roadmap：围绕 observability、cost guardrails、evals/benchmarks、permission scope、human-on-the-loop governance、MCP adapter 形成可执行 backlog。
  验收：
  - public docs 不再把 Codex/Claude 写成平级共创者或唯一默认运行面。
  - README 中英文与 website 对 VA Auto-Pilot / va-agent-protocol / MCP / A2A 的层级关系一致。
  - reopen 文章标题和正文更稳健，强调行业语言成熟，而不是“超前两个版本”的自夸。
  - auto-pilot backlog 形成 P0/P1/P2 任务，并通过 plan-review 后再 dispatch。
> Processed 2026-06-26: Folded into AP-079..AP-086. AP-079 creates the canonical public narrative spec and stale-expression checks; follow-up tasks clean README, website, long-form docs/protocol, cross-surface consistency, generic CLI agent path, readiness checklist, and next-gen roadmap.

- [x] **Plan Review Gate（Sprint 5）**：Manager 在 `orchestrate plan` 之后、`approve-plan` 之前，**必须与 Codex（或配置的 plan reviewer）讨论计划**——只评审、不写代码。运行 `orchestrate review-plan`，将结论写入 run-journal；存在 CRITICAL 则调整 backlog 后重新 plan + review。禁止「定计划后直接 dispatch / 实现」。
> Processed 2026-05-19: `orchestrate review-plan` CLI + plan-review.json planHash gate; protocol/SKILL updated; Codex reviewed Sprint5 plan before implementation (journal plan-review).

- [x] DocStore 打磨至生产级：AP-040..AP-045 是 Sprint 1-bis / 2-bis / 3 的落地任务。
> Processed 2026-04-14: 6-round dogfood session complete. Done 39→52. Commits:
> 2407884 / 98fe458 / 2c9d086 / d199904 / 5f49c0a / 57d0c57 / 93b174c. Auto-pilot
> self-healed 3 layers (review gate tolerance / dispatch semantics / state race +
> success detection). Sprint 1-bis (B11/B12/B13) + Sprint 2-bis (B14/B15/B16) +
> Sprint 3 (adopt + migrate) all landed. Genesis phase 2/3 + hook install + CI
> integration deferred to next sprint (see below).

- [x] Sprint 4 — DocStore 产品化：落地到 va-auto-pilot 仓库自身，
> Processed 2026-05-19: (a) pre-commit hook installed; (b) ci.yml doc-store job;
> (c) adopt → .docstore/designs/doc-store-api-draft.md; (d) mode=mixed + managedRoots;
> (e) README Managed DocStore + CLAUDE cross-link. Orchestrated dogfood AP-062..065 Done.
  _(原 scope：让设计稿和项目文档真正受 ManagedDocStore 管理。)
  (a) 安装 pre-commit hook（.git/hooks/pre-commit 调 doc-store enforce-staged）—
      幂等、可卸载、不覆盖现有 hook 用 exec chain 或 cascade 脚本；
  (b) GitHub Actions CI 集成（或扩展 .github/workflows/ci.yml）跑 doc-store doctor
      + enforce-staged --base main 作为必过 check；
  (c) Genesis phase 2：用 doc-store adopt 把 docs/designs/doc-store-api-draft.md
      纳管进 .docstore/designs/，保留 git history；
  (d) 切换 store config mode 从 legacy → mixed，managedRoots 加上 .docstore/designs；
  (e) README + start-va-auto-pilot-prompt 更新 DocStore 使用章节。
  
  验收每个任务独立闭环：check:all 绿 + review 过 + auto-commit；允许 loop
  full autonomy 无手动 commit 作为 "self-healed infra works" 的终验证。

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

- [x] **.npmignore 优化**：历史 npm publish 曾把 `.claude/settings.local.json`、`.va-auto-pilot/sprint-state.json`、`.va-auto-pilot/parallel-runs/`、`.github/` 等内部文件发出去。当前通过 package `files` 白名单与 packed-artifact validation 防止回归。
> Processed 2026-06-26: Superseded by package `files` allowlist and packed-artifact validation. Current package excludes internal state, root test flows, source-only tests, coverage, and local conductor artifacts.

- [x] **CHANGELOG.md 创建**：项目没有 CHANGELOG。创建 CHANGELOG.md，补录 v0.1.0 的主要功能（sprint execution loop、CLI quality gates、pitfall compounding、adversarial review、upgrade command、62 tests）。使用 Keep a Changelog 格式。

- [x] **清理无用 devDependency**：`tsx` 在 devDependencies 里但没有任何 script 使用它（test-runner.ts 是 reference implementation，实际测试用 node:test）。要么删除 tsx，要么把 test-runner.ts 正式接入 scripts。建议删除 tsx，保持零 devDep 的简洁性。

- [x] **website 国际化修复**：检查 website/ 中的文案是否与最新 README 的定位一致。特别是 tagline（应该是 "CLI-first autonomous multi-agent engineering loop"，不是 "USB interface"）、对比表信息、Frontier Models 章节是否在 landing page 有体现。

- [x] **[HUB-16] CLI-Anything 集成 — va-auto-pilot pitfall guide + va-hub Awakener + video-factory CLI harness**
> Processed 2026-03-11: Task A (va-auto-pilot): PF-001/002/003 注入 pitfall guide — artifact magic bytes 验证、真实后端强依赖、失败响亮原则，check:all 全绿。Task B (va-hub): 新增 cli-anything-discovery.ts / harness-cli-adapter.ts / awakener-agent-registry.ts，discoverHarnessCliTools() 扫描 PATH 中 cli-anything-* 并注册为 cli-harness:* Colony agent，270/270 tests 全绿。Task C (video-factory): cli-anything-blender Python harness，7阶段完成，Click CLI + blender --background subprocess backend，48 passed 2 skipped（blender 未装时正确 skip，FORCE_INSTALLED=1 时正确 fail），_resolve_cli 实现官方 fallback 模式。

  背景：调研了 HKUDS/CLI-Anything（6k stars）。这是「让任意 GUI 软件变 Agent-Native CLI」的 7 阶段方法论插件，已验证 11 个真实软件（GIMP/Blender/LibreOffice等），1508 tests 100% pass。

  本次要落地的三件事（**独立可并行，优先级从高到低**）：

  **Task A（P0）— va-auto-pilot pitfall guide 吸收 HARNESS.md 教训**
  将 CLI-Anything HARNESS.md 中的硬教训注入 va-auto-pilot pitfall guide（`sprint-board.mjs pitfall` CLI 新增3条）：
  1. "Use the real software — no reimplementation": 验收要检验真实 artifact（magic bytes / ZIP 结构），不能只看 exit code 0
  2. "The Rendering Gap": Worker 生成中间文件后必须调用真实后端渲染，pipeline 中间节点的输出必须有 artifact verification
  3. "Fail loudly and clearly — no silent degradation": 外部工具缺失时必须 error with install instructions，禁止 fallback 到劣化实现

  **Task B（P1）— va-hub Awakener _resolve_cli 模式**
  Awakener 中增加桌面软件 CLI 自动发现能力（参考 CLI-Anything 的 `_resolve_cli` 模式）：
  - `which cli-anything-<software>` 检测已安装的 harness CLI
  - 未安装时给出清晰 install 指引（`pip install -e <harness-path>`），不静默跳过
  - 发现的 harness CLI 作为可选 Colony agent 路由能力注册
  - TypeScript，接 va-hub 现有 Awakener 结构

  **Task C（P2）— video-factory cli-anything-blender harness（最小可用版）**
  在 `va-project/packages/video-factory/` 下，用 CLI-Anything 7 阶段方法论生成 `cli-anything-blender`：
  - Phase 1-3: 分析 blender bpy API，设计 CLI（project/scene/object/render/export 命令组），实现 Click CLI + subprocess blender --background 后端
  - Phase 4-5: 测试计划 TEST.md + 实现（unit + e2e-backend + subprocess，目标 ≥30 tests）
  - 验收：`cli-anything-blender --help` ✓，`--json scene new` 返回合法 JSON，`render execute --output out.png` 真实调用 blender 生成 PNG（≥1KB）
  - Python，pip install -e . 可用，blender 为硬依赖（不在则 error，不 fallback）

  **验收门（全部）**：
  - Task A: `node scripts/sprint-board.mjs pitfall --list` 新增 3 条有效 pitfall 条目，内容具体可操作
  - Task B: `npm run build && npm run lint && npm test` 全绿，Awakener 单测覆盖 _resolve_cli 路径
  - Task C: `CLI_ANYTHING_FORCE_INSTALLED=1 python3 -m pytest cli_anything/blender/tests/ -v` 全绿，artifact 验证到 PNG magic bytes

  委派对象：Codex CLI（Task A 在 va-auto-pilot 仓，Task B 在 va-hub 仓，Task C 在 va-project 仓 — 三者可并行）。

- [x] **Sprint 5：Harness 优化（源自 Anthropic 长运行 Agent 工程博客分析）**
> Processed 2026-04-04: All 4 tasks complete. AP-034 (journal --view), AP-035 (dynamic perspective), AP-036 (protocol extraction), AP-037 (pitfall injection into review). All committed 2026-03-30. Sprint state reconciled.

  基于 Anthropic 两篇工程博客（Effective Harnesses for Long-Running Agents + Harness Design for Long-Running Apps）的核心洞察，经四视角交叉分析确认的优化方向。按优先级排列：

  **Task 1（P1）— Journal 分层视图**
  run-journal.md 是 append-only，随 sprint 增长会稀释关键信息。新 session 全量读 journal 成本递增。
  - 给 `sprint-board.mjs` 新增 `journal --view` 子命令，生成分层摘要：Active Signals（聚合全部 Codebase Signals）+ Recent（最近 5 条完整条目）+ Earlier（每条压缩为一行 task-id + summary）
  - 原始 journal 保持 append-only 不动，审计完整性不受影响
  - 协议 `docs/operations/va-auto-pilot-protocol.md` Operational Memory Contract 中 `cat docs/todo/run-journal.md` 改为 `node scripts/sprint-board.mjs journal --view`
  - 验收：`node scripts/sprint-board.mjs journal --view` 输出分层结构且行数 < 原始 journal 50%；原始 journal 内容不变；现有测试全绿

  **Task 2（P1）— Sprint Review Perspective 动态化**
  当前 `spawnSprintReviewer()` 的 perspective 硬编码为 "adversarial regression perspective"，违反协议自身设计（要求 manager 根据 diff 内容动态选择 stakeholder-grounded perspective）。
  - 给 `spawnSprintReviewer()` 增加 `perspective` 参数，默认仍为当前行为
  - 在 `handleSprintCompletionReview()` 中，调用 reviewer 前先分析 `diffBundle.changedFiles` 的变更范围（CLI/auth/protocol/docs 等），生成具体 perspective 描述传入
  - perspective 选择逻辑参考协议 Sprint Completion Gate → Perspective Assignment 章节的示例模式
  - 验收：perspective 不再是硬编码字符串；journal 中记录实际使用的 perspective；现有测试全绿

  **Task 3（P2）— 协议 Quality Gates 示例瘦身**
  协议 767 行中 Quality Gates section 包含 4 个具体技术栈示例（Godot/Python/Mixed/Godot validation script），占 ~150 行，对非匹配项目是纯噪音。
  - 将 4 个具体示例（Example: Godot Project、Example: Python Project、Example: Mixed Project、Creating a Godot Validation Script）移到 `docs/operations/quality-gate-examples.md`
  - 协议主文件保留：Gate Configuration 格式说明 + TypeScript 默认示例 + Gate Semantics + Adaptive Quality Gates + Gate Resolution，并加一行指针 "See docs/operations/quality-gate-examples.md for more stack-specific examples"
  - 模板目录 `templates/docs/operations/` 同步
  - 验收：协议主文件行数减少 ≥100 行；`npm run check:all` 全绿；quality-gate-examples.md 内容完整

  **Task 4（P2）— Evaluator Pitfall 注入**
  codex review 是通用 review，未利用项目历史失败知识。将 pitfalls.json 中的未解决条目自动注入 review 上下文。
  - 在 `runGateSequence()` 的 review gate 执行前，读取 `pitfalls.json` 中未解决条目
  - 如果 codex review CLI 支持附加上下文（检查 `codex review --help`），则注入；否则改用 `codex exec --sandbox read-only` + 自定义 review prompt（包含 diff + pitfall 列表 + review 指令）
  - 验收：review gate 执行时日志显示注入了 N 条 pitfall 上下文（或日志说明 0 条可注入）；现有测试全绿

  **全局约束**：
  - 每个 Task 独立闭环，完成一个 review + commit 一个，不堆积
  - 质量门严格执行：`npm run check:all` + `codex review --uncommitted`
  - Do NOT run `codex review` inside the execution session（防递归）
  - 不改动与任务无关的代码

---

## Feedback (to fold into next cycle)
- npm publish 时 tarball 含 53 个文件、340KB，偏大。优化 .npmignore 后应显著缩小。
> Processed 2026-06-26: AP-073/AP-078 complete. Switched to package `files` allowlist, added packed-artifact validation, excluded internal artifacts/source-only tests/root CLI flows. Current npm dry-run: 80 files, 171.8KB package, 655.8KB unpacked; tarball install smoke passes.
- va-auto-pilot 和 va-agent-protocol 的关系需要在两个 README 和 website 中都讲清楚，避免用户困惑。
> Processed 2026-06-26: README.md, README.zh.md, and website hero/meta/compare copy now state VA Auto-Pilot as the sprint execution loop and va-agent-protocol as the universal task protocol; README also maps current Harness + Loop Engineering language.

## Direction (long-term)
- va-auto-pilot 是 sprint execution engine，va-agent-protocol 是 universal task protocol。两者互补。
- 考虑把 va-auto-pilot 作为 va-agent-protocol 的 monorepo 子包（packages/auto-pilot），简化维护和版本同步。
- 未来：MCP Server Adapter 让 VA Auto-Pilot 可以被任何 MCP client 直接调用。
