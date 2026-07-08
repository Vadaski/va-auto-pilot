# 多 Agent 并发运行 va-auto-pilot — 实现计划

> 目标:同一项目下开多个 agent 同时跑 auto-pilot,支持①协作消费同一 backlog(甲)②独立冲刺线(乙),执行树默认隔离(连甲模式也是),省合并优先。
>
> 架构决策见 [[multi-run-concurrency-design]] 记忆,三方(Codex/Kimi/Composer)独立源码评审 + 主架构师综合裁定。

## 设计基线(不再讨论的已定项)

- **Workspace×Run 分离**:Run=执行实例(永远 per-run orchestration state);Workspace=隔离边界(决定 backlog + 执行树归属)。
- **甲模式默认 isolated-tree**(共享 backlog + 每 run 独立 git worktree,commit 串行 squash-merge)。纯共享树降为 expert opt-in。
- **claim 前移到 plan**(`claim-and-plan` 原子原语),进 sprint-board 中心化读写,`findNextTask`/`buildParallelPlan` 跳过已 claim。
- **checkpoint 甲模式去掉 git HEAD 失效条件**(消除 N² stale 雪崩)。
- **claim 释放 = 惰性接管**(steal expired claim,保留审计字段),TTL=`max(60min, 2×trackTimeout)`。
- **默认启动 B4**:首 run 无参放行;检测到 active run,无参 init 退出码 2 + 给命令。
- **全局锁序**:`claim.lock(stateFile) → commit.lock`,单向有序,带 timeout。

## 关键源码注入点(Explore 已确认)

| 变更 | 注入点 | 行 |
|------|--------|-----|
| run.json namespace | `orchestrationPaths`/`resolveOrchestrationDir` | orchestration-state.mjs:17-32 |
| 硬编码路径泄漏 | close 删 plan-review / journal commitControlFiles / plan-review.mjs `.dir` | orch:231,957,1033; plan-review:16,99 |
| claim 字段 | `normalizeTask` schema + `findNextTask`/`buildParallelPlan` 跳过 | core.mjs:62-98,199-228,235-291 |
| claim 原子性 | `plan`/`next` 子命令包 `withPilotFileLock(stateFile)` | sprint-board.mjs:1811,1847 |
| commit 临界区 | `orchestrateCommit` 包 `commit.lock` | auto-pilot-orchestrate.mjs:888-912 |
| worktree run 化 | path 插 runId + dry-run 预览同步 | worktree-isolation.mjs:81; orch:601 |
| recover claim 释放 | `buildRecoveryPlan` 加 mutation + `applyRecoveryPlan` 加分支 | orch-state:~320-349; orch:249-285 |
| checkpoint 去 HEAD | `isCheckpointStale` / `buildCheckpoint` governance | orch-state:197-212,168-195 |

---

## 批次拆分(每批次独立 review + commit)

### 批次 1:run 级 orchestration 状态隔离 + 修 executorPid 空转
**目标**:让多个 run 的 orchestration 状态不互覆盖(修最致命的 bug),为后续 workspace/claim 铺地基。

**变更**:
1. `orchestration-state.mjs`:`resolveOrchestrationDir(workDir, runId?)` → 有 runId 时返回 `.va-auto-pilot/orchestration/runs/<runId>/`。`orchestrationPaths(workDir, runId?)` 透传 runId。所有 read*/write* 函数签名加可选 runId。
2. **runId 解析**:`runOrchestrateCommand`(`auto-pilot-orchestrate.mjs:1045`)扩展——`opts.runId` 来自 `--run-id` 或显式回填;新增 `resolveActiveRunId(workDir)`:读 `.va-auto-pilot/orchestration/active.json`(轻量索引:`{runId, startedAt, heartbeatAt}`),用于无 `--run-id` 时定位当前 run。所有 readRun/writeRun 调用点透传 runId(15 个 readRun + 17 个 writeRun,Explore 已列)。
3. **修 executorPid 空转**:`initRun` 删除无意义的 `RUN_LOCKED`(executorPid 判定,永 false);改成 workspace lease 占位(批次 5 填实)。当前批次只去掉假保护 + 让 init 写 `active.json`。
4. **3 处硬编码泄漏修复**:orch:231(close 删 plan-review)、957/1033(journal/commitControlFiles 路径)、plan-review.mjs:16/99(`.dir` → runId 感知)。
5. **新 CLI**:`--run-id <id>` 已存在,确认所有子命令透传;`orchestrate list-runs`(列 active runs)。

**验收**:
- `npm run check:units && npm run lint && npm run build` 全绿。
- 新测试:两个不同 runId 的 init → 各自 run.json 不互覆盖(独立目录);无 runId 时回退 active.json。
- 测 `resolveOrchestrationDir` 在有/无 runId 两种返回。
- 测 3 处硬编码路径在 runId 下正确路由。

**风险**:readRun/writeRun 调用点多(32 处),漏透传一个就静默错路由 → 用类型/lint 或集中测试覆盖。

---

### 批次 2:workspace 路由层(不强拆 sprint-state 默认位置)
**目标**:Workspace 作为路径路由层,决定 backlog/journal/board/pitfalls 的写根。采纳 Kimi 建议——保留 sprint-state 默认位置,workspace 动态解析。

**变更**:
1. 新模块 `scripts/lib/workspace.mjs`:
   - `resolveWorkspace(workDir, { name, isolated })` → 读/建 `.va-auto-pilot/workspaces/<name>/workspace.json`:`{ name, type: "shared"|"isolated", stateFile, boardFile, journalFile, pitfallsFile, gitWorktree?, baseRef, createdAt }`。
   - 路由规则:`type=shared` → 指向项目根默认路径(sprint-utils `resolveDefaults` 现状);`type=isolated` → 指向 `.va-auto-pilot/workspaces/<name>/`(独立 sprint-state + journal + board),并准备独立 git worktree(批次 4 用)。
2. `sprint-utils.mjs resolveDefaults(cwd, workspaceCtx?)`:接受可选 workspace 上下文,workspace 存在时优先返回 workspace.json 里的路径。保持现有 env>config>默认 优先级作为无 workspace 时的回退。
3. CLI:`orchestrate init --workspace <name> [--isolated-tree | --shared-tree] [--isolated]`。init 时绑定 run→workspace,run.json 存 `workspaceName`。
4. `buildOrchestrationOpts` 解析 workspace 参数 → 注入 workspace 上下文 → resolveDefaults 路由。

**验收**:
- 单元测试:shared workspace 路由到项目根默认路径;isolated workspace 路由到 workspace 子目录。
- CLI flow:init `--workspace featX --isolated` → sprint-state 写进 workspace 目录,不影响根 backlog。
- 无 `--workspace` 默认 `default` shared(等同今日行为)。
- `resolveDefaults` 回退路径不变(向后兼容)。

**风险**:resolveDefaults 是全局枢纽,改动要保证无 workspace 时行为完全不变(回归)。

---

### 批次 3:task claim 中心化(前移到 plan,惰性接管)
**目标**:claim 任务原子归属到 run,跨 run 不抢同一 task。这是甲模式协作的命脉。

**变更**(全在 sprint-board,因为 sprintBoardExec 是 spawn 子进程,claim 必须在 sprint-board 子命令里):
1. **schema**:`normalizeTask`(`core.mjs:62-98`)加 `claimedBy: ""`, `claimedAt: ""`, `claimExpiresAt: ""`, `previousClaimedBy: ""`, `reclaimedAt: ""`(惰性接管审计字段)。同步 `sprint-utils.mjs Task` typedef。
2. **跳过已 claim**:`findNextTask`(`core.mjs:199-228`)和 `buildParallelPlan`(`core.mjs:235-291`)在候选过滤时,跳过 `claimedBy && !claimExpired`(claimExpired = `claimExpiresAt < now`)。纯函数加 `nowMs` 参数。
3. **claim 原语**:新 `claim` 子命令 in `sprint-board.mjs`,在 `withPilotFileLock(stateFile)` 内:readState → 选首个可 claim task(复用 findNextTask 逻辑)→ 检查目标 task 的 `claimExpiresAt` 是否过期 → 过期则 steal(写 `previousClaimedBy`/`reclaimedAt`)否则拒绝 → 写 `claimedBy=runId, claimedAt=now, claimExpiresAt=now+TTL` → writeState → 输出 `{taskId, reclaimed?}`。
4. **claim-and-plan**:`orchestrate plan`(`auto-pilot-orchestrate.mjs:367`)改为先调 `sprint-board claim --count N --run-id <runId>`(原子 claim N 个)拿到 taskId 集,再基于已 claim 的 task 生成 candidatePlan。或让 `sprint-board plan` 内部 claim。
5. **TTL**:`max(60min, 2×DEFAULT_TRACK_TIMEOUT_MS)`,常量化、可 config。
6. **释放**:`sprint-board release --task <id> --run-id <id>`(显式,Done/Failed/close 时调);惰性接管由 claim 原语在下次抢时自动处理。

**验收**:
- 单元测试:findNextTask 跳过未过期 claim;过期 claim 可被 steal 且保留 previousClaimedBy。
- 并发测试(两进程,模拟两 run):同时 `sprint-board claim` → 各拿不同 task,不重叠(CAS 在 file lock 内原子)。
- claim 后 task 在 sprint.md render 显示 `[claimed by run-xxx]`。
- `sprint-board next --json` 不返回他人已 claim 的 task。

**风险**:claim TTL 误判(系统无真实心跳)→ TTL 取保守大值 + 惰性接管只 steal 明确过期的;Done/close 显式 release 兜底。

---

### 批次 4:甲模式 isolated-tree 执行树(commit 串行 squash-merge)
**目标**:甲模式共享 backlog 但每个 run 在自己的 git worktree 执行,commit 串行 squash-merge 回主树。彻底解决 worker 执行期文件冲突。

**变更**:
1. **worktree run 化**:`worktree-isolation.mjs:81` path 插 runId → `.va/worktrees/<runId>/<taskId>`(或 workspace 名)。dispatch dry-run 预览路径(`orch:601`)同步。
2. **甲模式 = workspace type shared + executionTree isolated**:workspace.json 加 `executionTree: "shared"|"isolated"`,甲模式默认 `isolated`。dispatch 时若 `executionTree=isolated`,为每个 track 准备 run-scoped worktree(复用 `prepareTrackWorktree`,但 rootDir 带 runId)。
3. **commit 串行**:`orchestrateCommit`(`auto-pilot-orchestrate.mjs:854-931`)临界区 888-912 包进 `withPilotFileLock(commitLockPath)`(workspace 级 commit.lock)。覆盖 `git merge --squash` + `git add` + `git commit`。持锁时重检 git HEAD(共享主树),冲突自动重试 squash(有限次数)或报错提示人工。
4. **checkpoint 甲模式去 HEAD**:`isCheckpointStale`(`orch-state:197-212`)在 shared workspace 下跳过 git HEAD 校验(保留 sprint-state + human-board 校验),消除 N² stale 雪崩。`buildCheckpoint` governance 标注 workspace mode。

**验收**:
- 单元测试:worktree path 含 runId,跨 run 不撞目录。
- CLI flow:两 run 共享 workspace,各自 dispatch 不同 task → 各自 worktree 执行 → 串行 commit,squash-merge 成功。
- checkpoint 测试:shared workspace 下,run A commit 后 run B 的 checkpoint 不 stale(不强制 re-approve)。
- commit.lock 并发测试:两 run 同时 commit,一个等锁,不产生 index.lock 竞争。

**风险**:squash-merge 冲突(两 task 改重叠文件)→ 文档明确甲模式是任务级并行非文件级;检测冲突报错 + 提示,不静默覆盖。

---

### 批次 5:workspace session lease + recover 扩展
**目标**:用 workspace lease 替代空转的 executorPid,实现 claim 惰性接管的触发 + 孤儿 worktree 清理。

**变更**:
1. **lease**:`workspace.json` 加 `activeRuns: [{ runId, managerSurface, sessionId, heartbeatAt, leaseExpiresAt }]`。每个 orchestrate 子命令结束时续期(写 heartbeatAt = now, leaseExpiresAt = now + leaseTTL)。run.json 权威,workspace 只存索引(采纳 Composer 建议,避免双写漂移)。
2. **session-id**:`--session-id <id>` 或从 manager-surface 推断;同一 manager 会话共享,不同窗口隔离。
3. **recover 扩展**:`buildRecoveryPlan`(`orch-state:~320-349`)新增 mutation `release-claim`(lease 过期 + run 无 active track + phase 非活跃执行窗)。`applyRecoveryPlan`(`orch:249-285`)加 `release-claim` 分支:调 `sprint-board release` 或直接 reset claimedBy。
4. **孤儿 worktree 清理**:recover 检测无 active run 的 worktree → 提示/清理。
5. **默认启动 B4**:`initRun` 检测 workspace 有 active lease 且未过期 → 无参 init 退出码 2,输出 active runs 列表 + 三条命令(`--workspace shared --isolated-tree` / `--workspace <name> --isolated` / `--join <runId>`)。

**验收**:
- 单元测试:lease 续期在子命令结束触发;过期 lease 在 recover 可释放。
- recover CLI flow:死 run 的 claim 被 `recover --apply` 释放回 Backlog;有 active track 的 run 不被误释放。
- init B4:首个 run 无参放行;第二个 run 无参报错 + 命令。
- 孤儿 worktree 清理。

**风险**:lease TTL 与 claim TTL 协调 → claim TTL 保守大,lease TTL 跟踪 manager 心跳;recover 区分"manager 挂了但 worker 还在跑"(不释放)vs"全死了"(释放)。

---

### 批次 6:文档 + 协议 + 收尾
**变更**:
1. `docs/operations/va-auto-pilot-protocol.md`:新增"多 Run 并发"章节(workspace/run 模型、甲乙模式、claim 协议、lease、锁序、recover)。
2. `CLAUDE.md`(va-auto-pilot):Orchestrated Mode 更新多 run 命令示例。
3. 质量门:新增并发回归测试进 `check:units`。
4. pitfall 记录:批次中踩的坑写入 run-journal / pitfall。

**验收**:protocol 文档自洽;并发测试纳入质量门;整体验收跑 `npm run check:units && npm run lint && npm run build`。

---

## 执行顺序与依赖

```
批次1 (run 隔离) ──┐
                  ├─→ 批次2 (workspace 路由) ──→ 批次3 (claim 中心化)
                  │                                    │
                  │                                    ↓
                  └──────────────────────────────→ 批次4 (isolated-tree + commit)
                                                       │
                                                       ↓
                                                  批次5 (lease + recover)
                                                       │
                                                       ↓
                                                  批次6 (文档收尾)
```

- 批次1、2 可并行起步(2 依赖 1 的 active run 解析)。
- 批次3 依赖 2(workspace 路由 backlog)。
- 批次4 依赖 1(worktree runId)+ 3(commit 串行配合 claim)。
- 批次5 依赖 3(claim 释放)+ 4(recover worktree)。

## 每批次交付纪律
- review(结构变更优先)→ 通过立即 commit。
- 每批次独立 `npm run check:units`。
- 不堆积,批次间保持 main 可用。
