# ManagedDocStore API 设计草案

**目标**：为 va-auto-pilot 建立一个可迁移、可审计、可前向兼容的文档治理层。

对外正式名称统一为 `ManagedDocStore`。

内部实现可以保留 `DocStore` 作为昵称或模块名，
但对外 API、CLI、文档、错误信息、CI 检查、迁移说明一律使用 `ManagedDocStore`。

**受管目录**：`.docstore/`

`.docstore/` 是受治理的数据根，
不是“运行时状态目录”。

它保存受管文档的索引、journal、迁移元数据、备份和扩展定义，
因此名称必须反映“持久化文档仓库”而不是“临时 state”。

**设计意图**：

1. 给 `docs/designs`、`docs/operations`、未来 ADR、过程日志提供统一引用面。
2. 允许项目经历 `legacy -> mixed -> managed` 三态迁移，而不是一刀切。
3. 允许部分对象被“登记但不搬家”，例如 `CLAUDE.md` 和跨项目 instruction。
4. 把前向兼容、创世自举、故障恢复写成明确 contract，而不是口号。

---

## 1. 概览

`ManagedDocStore` 是 va-auto-pilot 的文档单一事实源治理层。

它不要求“所有 Markdown 都必须立刻搬进 `.docstore/`”，
但要求“所有被声明为受管的文档，都必须通过统一索引、统一版本轴、统一事务边界和统一审计面来治理”。

核心原则不是“单文件绝对权威”，
而是“单引用点权威”。

也就是说：

- 查询以 `INDEX.json` 为主入口。
- 文档正文可以是 Markdown、JSON、或将来的其他 artifact 形态。
- 某些对象可以只登记元数据和引用，不迁移物理文件。
- 对外稳定的对象是 `DocumentRecord`，而不是某个具体文件路径。

本设计针对两个现实约束：

1. va-auto-pilot 当前已经存在 `docs/designs/`、`docs/operations/`、`CLAUDE.md` 等历史结构。
2. 项目未来要“吃自己的狗粮”，由自己来管理自己的文档治理规则。

因此本稿默认系统必须从“历史仓库”平滑进入“受管仓库”，
而不是要求从零开始。

## 2. 范围与非目标

本稿覆盖：

- `.docstore/` 的目录契约。
- `ManagedDocStore` 核心 API 签名。
- `DocumentKind` / `DocumentRecord` / `ExtensionType` 三层模型。
- `INDEX.json`、`store.config.json`、journal、frontmatter 的契约。
- mixed 迁移期的 hook/CI 行为。
- adopt/import legacy 文档的入口。
- 审计、备份、恢复、cutover、前向兼容规则。

本稿不覆盖：

- runtime 函数体实现。
- UI 层或编辑器集成。
- 多机分布式锁的最终实现。
- 全量文本搜索引擎。
- 二级存储（SQLite、对象存储）的具体落地。

## 3. 术语与命名基线

为避免旧稿中 `artifact`、`entry`、`section type`、`type` 混用，
本稿统一以下术语。

### 3.1 Canonical 名词

- `ManagedDocStore`
  - 对外正式产品名。
- `DocumentKind`
  - 顶层文档类别。
  - 当前内置值：`design | decision | process | externalRef | workspaceInstruction | archive`。
- `DocumentRecord`
  - 单个受管对象在索引中的标准表示。
- `ExtensionType`
  - 扩展 kind 或子类型。
  - 用于表达 `process` 下面的 `gameplay-log` 之类 subtype。

### 3.2 命名约束

- 顶层 API 统一 CRUD / lookup 词根：
  - `createDocument`
  - `updateDocument`
  - `archiveDocument`
  - `linkDocuments`
  - `resolveDocumentRef`
  - `closeSprint`
- 不再使用：
  - `addDesign`
  - `updateDesign`
  - `archiveSprint`
  - `resolveRef`
- 错误命名统一为 `...Error` 后缀：
  - `OrphanDocumentError`
  - `DanglingReferenceError`
  - `SchemaVersionMismatchError`
  - `JournalCorruptError`

### 3.3 Kind 与 subtype 分层

`kind` 只能表达顶层文档类别。

例如：

- 正确：`kind: "process", subtype: "gameplay-log"`
- 错误：`kind: "gameplay-log"`

扩展只能扩展 subtype 或附加 schema，
不能篡改 `DocumentKind` 的语义边界。

## 4. 仓库拓扑与受管边界

`ManagedDocStore` 的默认根目录如下：

```text
.docstore/
├── INDEX.json
├── store.config.json
├── .schema-version
├── .journal/
│   ├── current.jsonl
│   └── archive/
├── backups/
│   ├── snapshots/
│   └── restore-log/
├── migrations/
│   ├── applied/
│   └── plans/
├── designs/
├── decisions/
├── process/
├── archive/
├── extensions/
└── refs/
```

目录职责如下：

- `INDEX.json`
  - 受管对象的权威索引。
- `store.config.json`
  - 受管模式、受管根、外部引用策略、hook/CI 行为的权威配置。
- `.schema-version`
  - 仅为人类和恢复工具提供的快捷镜像。
  - 它必须与 `INDEX.json.storeFormatVersion` 一致。
  - 它不是唯一版本权威来源。
- `.journal/current.jsonl`
  - 写前日志。
- `backups/`
  - 快照与恢复日志。
- `migrations/`
  - 迁移计划、执行结果、回滚标记。
- `designs/` / `decisions/` / `process/` / `archive/`
  - 真正物理落在 store 内的受管正文。
- `extensions/`
  - `ExtensionType` 注册定义。
- `refs/`
  - 可选缓存和引用映射。

与现有仓库的关系如下：

- `docs/designs/`
  - 允许在 `legacy` 或 `mixed` 期继续存在。
- `docs/operations/`
  - 同上。
- `CLAUDE.md`
  - 默认不硬迁。
  - 它应以 `workspaceInstruction` 形式登记到索引中。
- 跨项目 instruction 文件
  - 通过 `externalRef` 或 `workspaceInstruction` 进入索引。
  - 物理文件可留原位。

换句话说：

`ManagedDocStore` 管的是“受管对象集合”，
不是“仓库里所有文档文件”。

## 5. Migration Modes

本章是对旧稿最大缺口的补齐。

`.docstore/` 与现有 `docs/` / `CLAUDE.md` 的关系，
必须由同一份配置声明，
不能靠口头约定。

### 5.1 模式定义

系统必须支持三态：

| mode | 语义 | 是否允许 `docs/` 与 `.docstore/` 并存 | hook/CI 默认行为 |
| --- | --- | --- | --- |
| `legacy` | store 尚未接管任何正文，只允许登记计划与外部引用 | 是 | 不拦截裸改 |
| `mixed` | store 已接管部分路径，`docs/` 与 `.docstore/` 并存 | 是 | 只拦 `managedRoots` 内裸改 |
| `managed` | store 已成为项目文档治理主入口 | 可保留历史 stub，但新正文默认进 store | 全量强制 |

### 5.2 配置来源

必须存在 `.docstore/store.config.json`。

`store.config.json` 是模式权威配置。

`INDEX.json.managedRoots` 是为 reader 快速读取提供的镜像字段，
但不能替代 `store.config.json`。

二者不一致时：

1. `doctor` 必须报错。
2. `validate` 必须标记 `ConfigIndexDriftError`。
3. hook/CI 以 `store.config.json` 为准。

### 5.3 示例配置

```json
{
  "mode": "mixed",
  "managedRoots": [
    ".docstore/designs",
    ".docstore/decisions",
    ".docstore/process"
  ],
  "legacyRoots": [
    "docs/designs",
    "docs/operations"
  ],
  "trackedExternalPaths": [
    "CLAUDE.md",
    "AGENTS.md"
  ],
  "adoptionPolicy": {
    "preferGitMove": true,
    "leaveLegacyStubWhenMoved": true
  }
}
```

### 5.4 mixed 期行为规则

`mixed` 模式下必须满足以下规则：

1. `docs/` 与 `.docstore/` 可以并存。
2. 只有 `managedRoots` 内的正文受“必须经 `ManagedDocStore` 写入”约束。
3. `managedRoots` 外的历史文档可以继续裸维护。
4. 任何“新纳管文档”都必须先执行 `adoptDocument()` 或 `importLegacyDocument()`，
   再写入 `INDEX.json`。
5. 如果文档已通过 `git mv` 迁入 `.docstore/`，
   旧路径可以留下 stub 或 README 指向新位置。
6. stub 只能是指向性文件，
   不能继续承载真实正文。

### 5.5 managed 期行为规则

`managed` 模式下：

1. 所有新建设计、决策、过程记录必须通过 `ManagedDocStore` 写入。
2. 允许保留历史 stub/README，
   但它们不能被视为新的权威正文。
3. `docs/` 下仍存在的历史文件，
   若被标注为 `externalRef` 或 `workspaceInstruction`，
   则不受“必须搬进 `.docstore/`”约束。

### 5.6 legacy 期行为规则

`legacy` 模式下：

1. hook 和 CI 不能以“绕过 store”为由阻塞开发。
2. 允许只初始化 `.docstore/` 的元数据与计划文件。
3. 可以只登记 `externalRef`、迁移计划、adoption backlog。

## 6. 核心 API 面

核心 API 必须保持“类型可扩展，但命名不绑死未来 artifact 扩展路径”。

因此内核只暴露通用 CRUD/lookup，
具体文档类别由 typed facade 提供语法糖。

```ts
import { z } from "zod";

export type DocumentKind =
  | "design"
  | "decision"
  | "process"
  | "externalRef"
  | "workspaceInstruction"
  | "archive";

export type RelationType =
  | "links"
  | "cites"
  | "depends"
  | "extends"
  | "supersedes"
  | "records"
  | "references";

export interface CreateDocumentInput {
  kind: DocumentKind;
  subtype?: string | null;
  title: string;
  slug?: string;
  body?: string;
  pathHint?: string;
  metadata?: Record<string, unknown>;
  refs?: Array<{
    to: string;
    type: RelationType;
    strength?: "weak" | "strong";
  }>;
}

export interface UpdateDocumentPatch {
  title?: string;
  body?: string;
  subtype?: string | null;
  metadata?: Record<string, unknown>;
  refs?: Array<{
    to: string;
    type: RelationType;
    strength?: "weak" | "strong";
  }>;
  expectedDocumentRevision?: number;
}

export interface ArchiveDocumentPolicy {
  reason: string;
  archiveAt?: string;
  tombstone?: "redirect" | "stub" | "none";
}

export interface LinkDocumentsInput {
  from: string;
  to: string;
  type: RelationType;
  strength?: "weak" | "strong";
}

export interface ManagedDocStore {
  open(rootDir?: string): Promise<void>;
  close(): Promise<void>;

  createDocument(input: CreateDocumentInput): Promise<DocumentRecord>;
  updateDocument(ref: string, patch: UpdateDocumentPatch): Promise<DocumentRecord>;
  archiveDocument(ref: string, policy: ArchiveDocumentPolicy): Promise<DocumentRecord>;
  linkDocuments(input: LinkDocumentsInput): Promise<void>;

  resolveDocumentRef(ref: string): Promise<ResolvedDocument>;
  queryDocuments(filter: QueryFilter): Promise<DocumentRecord[]>;
  closeSprint(sprintId: string, summaryPatch?: UpdateDocumentPatch): Promise<DocumentRecord>;

  importLegacyDocument(path: string, inferredKind?: DocumentKind): Promise<DocumentRecord>;
  adoptDocument(input: AdoptDocumentInput): Promise<DocumentRecord>;

  validate(): Promise<ValidationReport>;
  doctor(): Promise<DoctorReport>;
  migrate(plan?: MigrationPlanInput): Promise<MigrationRunReport>;
}
```

### 6.1 typed facade 是 SDK 责任，不是内核责任

SDK 层可以暴露如下语法糖：

```ts
export interface ManagedDocStoreSdk extends ManagedDocStore {
  createDesign(input: Omit<CreateDocumentInput, "kind">): Promise<DocumentRecord>;
  createDecision(input: Omit<CreateDocumentInput, "kind">): Promise<DocumentRecord>;
  createProcessEntry(input: Omit<CreateDocumentInput, "kind">): Promise<DocumentRecord>;
}
```

但这些 facade 必须等价转换为：

- `createDocument({ kind: "design", ... })`
- `createDocument({ kind: "decision", ... })`
- `createDocument({ kind: "process", ... })`

内核不得因为 facade 存在而把未来类型扩展绑死在专用方法名上。

### 6.2 closeSprint 的定位

`closeSprint` 替代旧稿的 `archiveSprint`。

区别是：

1. `closeSprint` 是一个业务生命周期动作。
2. 它可以创建总结文档、归档过程条目、写入 closure relation。
3. 它不要求所有对象都进入 `archive` kind。

## 7. 数据模型与三轴版本

旧稿把 `version` 和 `schemaVersion` 混在一起，
会让 reader 无法判断“到底是 store 升级了，还是某个文档被编辑了，还是某类 artifact schema 变了”。

本稿明确三条独立版本轴：

1. `storeFormatVersion`
   - 整个 `.docstore/` 的存储格式版本。
   - 作用域：`INDEX.json`、journal、config、备份目录布局、迁移机制。
2. `artifactSchemaVersion`
   - 某类文档或某个 `ExtensionType` 的正文/frontmatter schema 版本。
   - 作用域：`DocumentRecord`、frontmatter、扩展定义。
3. `documentRevision`
   - 单个 `DocumentRecord` 的内容修订号。
   - 每次成功 mutation 后递增。

### 7.1 版本变化的责任边界

- 升级 `storeFormatVersion`
  - 必须通过 store-level migration。
  - 允许改 `INDEX.json`、journal、目录布局。
- 升级 `artifactSchemaVersion`
  - 必须附带 subtype 或 kind 对应迁移规则。
  - 不允许偷带 store 布局变更。
- 递增 `documentRevision`
  - 只能表示单文档语义变更。
  - 不允许借此偷偷删除兼容字段。

### 7.2 Frontmatter 中的三轴写法

```yaml
---
docId: design:managed-docstore-api-draft
kind: design
subtype: null
title: ManagedDocStore API 设计草案
storeFormatVersion: "1.0.0"
artifactSchemaVersion: "design@1.0.0"
documentRevision: 4
refs:
  - to: decision:managed-docstore-ssot
    type: depends
    strength: strong
---
```

`storeFormatVersion` 出现在 frontmatter 中，
不是为了让正文文件决定 store 版本，
而是为了让脱离索引的单文件恢复和离线检查仍然可行。

权威来源仍是 `INDEX.json.storeFormatVersion`。

## 8. Schema 定义

本章只给签名和 schema 契约，
不提供 runtime 函数体。

### 8.1 公共枚举

```ts
import { z } from "zod";

export const DocumentKindSchema = z.enum([
  "design",
  "decision",
  "process",
  "externalRef",
  "workspaceInstruction",
  "archive"
]);

export const RelationTypeSchema = z.enum([
  "links",
  "cites",
  "depends",
  "extends",
  "supersedes",
  "records",
  "references"
]);

export const JournalCommitStateSchema = z.enum([
  "pending",
  "committed",
  "aborted"
]);
```

`refs.type` 与 `relations.type` 必须共用同一个 `RelationTypeSchema`。

禁止出现：

- `refs.type` 是 enum
- `relations.type` 是任意字符串

这样的双轨契约。

### 8.2 StoreConfigSchema

```ts
export const StoreConfigSchema = z.object({
  mode: z.enum(["legacy", "mixed", "managed"]),
  managedRoots: z.array(z.string()).min(1),
  legacyRoots: z.array(z.string()).default([]),
  trackedExternalPaths: z.array(z.string()).default([]),
  adoptionPolicy: z.object({
    preferGitMove: z.boolean().default(true),
    leaveLegacyStubWhenMoved: z.boolean().default(true),
    requireRegistrationForNewManagedDocs: z.boolean().default(true)
  }).default({}),
  hookPolicy: z.object({
    blockBareWritesInManagedRoots: z.boolean().default(true),
    allowLegacyEditsOutsideManagedRoots: z.boolean().default(true)
  }).default({})
}).passthrough();
```

这里使用 `.passthrough()`，
因为 config 也必须满足前向兼容 contract。

### 8.3 DocumentRecordSchema

```ts
export const DocumentRecordSchema = z.object({
  id: z.string(),
  kind: DocumentKindSchema,
  subtype: z.string().nullable().default(null),
  title: z.string(),
  slug: z.string(),
  path: z.string(),
  managed: z.boolean(),
  external: z.boolean().default(false),
  storeFormatVersion: z.string(),
  artifactSchemaVersion: z.string(),
  documentRevision: z.number().int().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().optional(),
  refs: z.array(z.object({
    to: z.string(),
    type: RelationTypeSchema,
    strength: z.enum(["weak", "strong"]).default("strong")
  })).default([]),
  metadata: z.record(z.unknown()).default({}),
  extensions: z.record(z.unknown()).default({}),
  extra: z.record(z.unknown()).default({})
}).passthrough();

export type DocumentRecord = z.infer<typeof DocumentRecordSchema>;
```

`extensions` 和 `extra` 是显式保留桶：

- `extensions`
  - 给扩展类型写入非核心字段。
- `extra`
  - 给保留写回但当前 reader 不理解的字段使用。

持久化层必须保留这两个桶。

### 8.4 IndexSchema

```ts
export const IndexSchema = z.object({
  version: z.literal("1.0.0"),
  storeFormatVersion: z.string(),
  managedRoots: z.array(z.string()).default([]),
  lastUpdated: z.string().datetime(),
  documents: z.record(z.string(), DocumentRecordSchema),
  relations: z.array(z.object({
    from: z.string(),
    to: z.string(),
    type: RelationTypeSchema,
    strength: z.enum(["weak", "strong"]).default("strong"),
    addedAt: z.string().datetime()
  })).default([]),
  stats: z.object({
    totalDocuments: z.number().int().min(0),
    totalReferences: z.number().int().min(0),
    orphanedCount: z.number().int().min(0).default(0),
    externalCount: z.number().int().min(0).default(0)
  }),
  extensions: z.record(z.unknown()).default({}),
  extra: z.record(z.unknown()).default({})
}).passthrough();
```

### 8.5 JournalEntrySchema

WAL 依赖明确的 commit state。

因此 journal 条目必须包含 `committed` 状态，
而不是只在注释里说“成功后标 committed: true”。

```ts
export const JournalEntrySchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("create"),
    entryId: z.string(),
    timestamp: z.string().datetime(),
    committed: JournalCommitStateSchema,
    docId: z.string(),
    kind: DocumentKindSchema,
    subtype: z.string().nullable().optional(),
    payload: z.record(z.unknown()),
    actor: z.string().optional(),
    txId: z.string()
  }),
  z.object({
    type: z.literal("update"),
    entryId: z.string(),
    timestamp: z.string().datetime(),
    committed: JournalCommitStateSchema,
    docId: z.string(),
    changes: z.record(z.unknown()),
    actor: z.string().optional(),
    txId: z.string()
  }),
  z.object({
    type: z.literal("archive"),
    entryId: z.string(),
    timestamp: z.string().datetime(),
    committed: JournalCommitStateSchema,
    docId: z.string(),
    reason: z.string(),
    actor: z.string().optional(),
    txId: z.string()
  }),
  z.object({
    type: z.literal("link"),
    entryId: z.string(),
    timestamp: z.string().datetime(),
    committed: JournalCommitStateSchema,
    from: z.string(),
    to: z.string(),
    relation: RelationTypeSchema,
    actor: z.string().optional(),
    txId: z.string()
  }),
  z.object({
    type: z.literal("migrate"),
    entryId: z.string(),
    timestamp: z.string().datetime(),
    committed: JournalCommitStateSchema,
    migrationId: z.string(),
    fromStoreFormatVersion: z.string(),
    toStoreFormatVersion: z.string(),
    actor: z.string().optional(),
    txId: z.string()
  })
]).passthrough();
```

### 8.6 gameplay-log 示例必须写成 subtype

```ts
await managedDocStore.createDocument({
  kind: "process",
  subtype: "gameplay-log",
  title: "Session #42 - Boss Fight Balance",
  body: "# ...",
  metadata: {
    sessionId: "s42",
    gameVersion: "0.8.1",
    metrics: { dps: 1240, winRate: 0.73 }
  }
});
```

禁止出现旧稿那种：

```ts
// 错误示例
await addProcessEntry({
  type: "gameplay-log"
});
```

因为那会把 `kind` 与 `ExtensionType` 混为一谈。

## 9. Compatibility Contract

这是 `INDEX.json` 和持久化层的硬约束。

reader 和 writer 都必须遵守。

### 9.1 unknown fields 处理规则

对 `INDEX.json`、`store.config.json`、`DocumentRecord`、journal 扩展字段统一执行：

1. **preserve on read**
   - reader 读到未知字段时不得报错。
   - 未知字段必须进入 `extensions` 或 `extra` 桶，或被 `.passthrough()` 保留。
2. **preserve on write**
   - writer 更新已知字段时不得丢弃未知字段。
   - 重新写回后未知字段必须仍然存在。
3. **delete only by explicit migration**
   - 删除字段只能通过显式 migration 完成。
   - 普通 `updateDocument`、`doctor`、`validate` 不得隐式裁剪字段。

### 9.2 writer 的责任

writer 至少要做到：

- 以 AST/structured parse 方式读取 JSON/Markdown frontmatter。
- 写回前 merge 原始未知字段。
- 对无权理解的字段保持字节级稳定不是强制要求，
  但语义级保留是强制要求。

### 9.3 `.passthrough()` 是 schema 层 contract，不是实现细节

所有核心 schema 均应使用 `.passthrough()`，
原因不是“方便调试”，
而是这是前向兼容 contract 的直接编码表达。

如果某个 schema 不允许 passthrough，
必须在设计中单独写出理由，
并说明如何避免未来 reader 丢数据。

### 9.4 兼容矩阵

下表定义 `readerVersion x fileSchemaVersion` 的最低行为要求。

| readerVersion | fileSchemaVersion | 预期结果 | 允许动作 | 禁止动作 |
| --- | --- | --- | --- | --- |
| 相同主版本 | 相同主版本 | 正常读写 | 读、写、validate | 无 |
| 较新 reader | 较旧 file | 自动升级或兼容读取 | 读、写、推荐 migrate | 静默删字段 |
| 较旧 reader | 较新 file，但仅新增未知字段 | 只读兼容 | 读、保留未知字段再写回 | 裁剪未知字段 |
| 较旧 reader | 较新 file，包含破坏性字段变更 | 拒绝写，允许只读或报错 | 只读、提示 migrate | 强行写回 |
| 不同主版本且无迁移器 | 明显不兼容 | 明确失败 | 输出迁移建议 | 伪装成功 |

### 9.5 版本闸门

当 reader 检测到：

- `storeFormatVersion` 主版本更高，
- 且本地无对应 migration/read-only fallback，

则必须：

1. 拒绝 mutation。
2. 允许只读模式尝试打开。
3. 输出明确错误与建议的最小升级路径。

## 10. 事务、锁与 Journal

旧稿的原子性方向是对的，
但实现 contract 需要更细。

### 10.1 锁

默认以 `.docstore/.lock` 做排它锁。

规则如下：

1. 所有 mutation 必须先获取锁。
2. 锁超时默认 30 秒。
3. 超时后抛 `TransactionConflictError`。
4. `queryDocuments` 与 `resolveDocumentRef` 默认允许并发读。
5. `migrate` 必须获取独占写锁并阻止其他 mutation。

### 10.2 WAL 顺序

每个 mutation 的提交顺序固定为：

1. append `pending` journal entry
2. 写临时文件
3. fsync 临时文件
4. 原子 rename 覆盖目标文件
5. 更新 `INDEX.json`
6. append/patch journal state 为 `committed`

如果在第 2 至第 5 步失败：

- journal state 必须转为 `aborted`，
  或由恢复流程补记为 `aborted`。

### 10.3 open() 恢复逻辑

`open()` 时必须执行：

1. 扫描 `.journal/current.jsonl`
2. 找出 `committed = pending` 的条目
3. 对每个条目执行幂等恢复判定：
   - 目标文件与索引都已经存在且版本匹配
     - 补记为 `committed`
   - 两者都不存在
     - 标记 `aborted`
   - 部分存在
     - 进入 recovery 分支，重放或回滚
4. 恢复结束后输出 `DoctorReport.recoveryActions`

### 10.4 Markdown 正规化

所有 store 内 Markdown 写入前必须统一走 `normalizeMarkdown()`。

该步骤至少负责：

- frontmatter 排序稳定。
- heading 层级合法。
- 内部链接转为 store 可解析形式。
- Windows/Unix 换行统一。

正规化不能删除未知 frontmatter 字段。

## 11. Store-Level Migration Engine

旧稿的 `.schema-version` hook 过于单薄，
因为它只能表达“版本号不同了”，
却无法表达：

- 目录移动
- 引用重写
- journal 迁移
- 备份生成
- 回滚点

因此迁移必须升级为 store-level migration。

### 11.1 迁移器签名

```ts
export interface MigrationContext {
  storeFormatVersion: string;
  targetStoreFormatVersion: string;
  index: DocumentRecordIndex;
  artifacts: Map<string, DocumentRecord>;
  journal: JournalEntry[];
  extensions: Record<string, unknown>;
  refMap: Map<string, string>;
  writeFile(path: string, content: string | Uint8Array): Promise<void>;
  moveFile(from: string, to: string): Promise<void>;
  rewriteRefs(mapper: (ref: string) => string): Promise<void>;
}

export interface MigrationResult {
  migrationId: string;
  applied: Array<{
    step: string;
    status: "applied" | "skipped";
    details?: string;
  }>;
  warnings: string[];
  rollbackPlanId: string;
}

export type StoreMigrator =
  (ctx: MigrationContext) => Promise<MigrationResult>;
```

### 11.2 生命周期

每个 store migration 必须实现四阶段：

1. `preflight`
   - 检查版本、磁盘空间、锁、备份目标、路径冲突。
2. `apply`
   - 真正执行文件变更、索引调整、引用重写。
3. `verify`
   - 重新读取索引和抽样正文，确认迁移结果与目标版本一致。
4. `rollback`
   - 如果 `apply` 或 `verify` 失败，使用备份与移动记录恢复。

这四阶段必须在设计文档中被明确命名，
而不是隐含在“迁移函数里自己搞定”。

### 11.3 `.schema-version` 的角色

`.schema-version` 文件保留，
但职责调整为：

1. store 格式版本的镜像。
2. 人工排障时的快速读取点。
3. genesis 阶段尚未生成完整 `INDEX.json` 时的 fallback。

它不再是唯一 hook 点。

真正的迁移驱动来源是：

- `INDEX.json.storeFormatVersion`
- migration registry
- `migrations/plans/*`

## 12. Genesis & Bootstrap

这是专门处理“创世悖论”的章节。

系统不能假设自己一开始就已经存在。

### 12.1 genesis phase 三步

在自举完成之前，
设计稿本身允许先作为裸文件存在于 `docs/designs/`。

创世流程必须明确分三步：

1. **阶段一：裸文件阶段**
   - 设计草案在 `docs/designs/` 中维护。
   - 尚未要求它通过 `ManagedDocStore` 写入。
2. **阶段二：实现 adoption 能力**
   - 先实现 `doc-store import` / `adoptDocument` / `importLegacyDocument`。
   - 同时实现 `store.config.json`、`INDEX.json`、journal、`doctor`。
3. **阶段三：专门迁移提交纳管**
   - 当 adoption 能力可用后，
     用单独提交将设计文档纳管。
   - 从该迁移提交开始启用 hook。

### 12.2 hook 启用时点

hook 不得在 genesis phase 第一阶段提前强制。

原因很简单：

此时系统还没有能力管理自己，
强制 hook 只会制造死锁。

因此 contract 是：

- `legacy` 阶段可以存在 `.docstore/` 但不强制。
- 只有当 adoption 提交落地并切到 `mixed` 或 `managed`，
  hook 才能对对应范围生效。

## 13. Legacy Adoption

设计文档自身必须可被 adopt。

这意味着：

1. 现有无 frontmatter Markdown 可以先被导入。
2. 系统能推断最小 `DocumentKind`。
3. 系统能写回标准化版本。

### 13.1 importLegacyDocument

```ts
export interface ImportLegacyDocumentOptions {
  inferredKind?: DocumentKind;
  inferredSubtype?: string | null;
  keepOriginalPath?: boolean;
  managedTargetPath?: string;
  leaveLegacyStub?: boolean;
}

export interface AdoptDocumentInput {
  sourcePath: string;
  targetKind: DocumentKind;
  targetSubtype?: string | null;
  moveIntoStore?: boolean;
  registerAsExternal?: boolean;
  titleOverride?: string;
  metadata?: Record<string, unknown>;
}
```

### 13.2 adopt 行为规则

`adoptDocument()` 至少要支持三种路径：

1. **move into store**
   - 使用 `git mv` 将正文搬进 `.docstore/`。
2. **register in place**
   - 文件留原位。
   - 在索引中标记 `managed: false`, `external: true`。
3. **standardize only**
   - 不立即搬家。
   - 先注入 frontmatter、写入稳定 `docId`、建立 refs。

### 13.3 无 frontmatter 文档的推断规则

对于无 frontmatter 文件：

1. 如果位于 `docs/designs/`
   - 默认 `DocumentKind = design`
2. 如果位于 `docs/operations/`
   - 默认 `DocumentKind = process`
3. 如果文件名匹配 `ADR-*`
   - 默认 `DocumentKind = decision`
4. 如果路径是 `CLAUDE.md` 或类似指令文件
   - 默认 `DocumentKind = workspaceInstruction`

推断结果必须可被人工覆盖。

不能把推断写死成不可修改行为。

### 13.4 写回标准化版本

当 adoption 选择“写回标准化版本”时，
至少必须写入：

- `docId`
- `kind`
- `subtype`
- `storeFormatVersion`
- `artifactSchemaVersion`
- `documentRevision`
- `refs`

对于不适合修改的原始外部文件，
允许不写回，
但必须在索引中记录“未写回原因”。

## 14. Lifecycle Commands

旧稿把 `doc-store:init` 的幂等性说成一句口号，
不够。

命令面必须拆分为：

- `init`
- `doctor`
- `migrate`

### 14.1 init

`init` 只在 store 不存在时创建基础结构。

行为契约：

1. 若 `.docstore/` 不存在
   - 创建目录树、最小 config、空索引、空 journal。
2. 若 `.docstore/` 已存在
   - 默认不覆盖。
   - 自动转而执行 `doctor`。
   - 命令应 exit 0。
3. 若传入 `--force`
   - 允许覆盖明确列出的可覆盖项。
   - 但仍不得静默删除备份和迁移记录。

### 14.2 doctor

`doctor` 的职责：

1. 校验 `store.config.json` 与 `INDEX.json.managedRoots` 一致性。
2. 校验 `.schema-version` 与 `storeFormatVersion` 一致性。
3. 扫描 orphan、dangling refs、journal 恢复状态。
4. 输出修复建议而非直接修改。

### 14.3 migrate

`migrate` 的职责：

1. 执行 store-level migration plan。
2. 支持 `--plan-only`。
3. 支持 `--from` / `--to`。
4. 默认生成备份并记录 rollback plan。

### 14.4 内置类型注册规则

初始化内置类型时必须：

- 仅补缺，不覆盖已有定义。
- extension 目录只 merge，不 reset。

即使 `init --force`，
也不能粗暴清空扩展目录。

## 15. Mode-Aware Enforcement

hook 和 CI 必须模式感知，
并读取同一份 store config。

不能把路径写死成 `.docstore/` 全树必拦。

### 15.1 pre-commit 规则

```bash
#!/usr/bin/env bash
set -euo pipefail

MODE="$(jq -r '.mode' .docstore/store.config.json)"

if [ "$MODE" = "legacy" ]; then
  exit 0
fi

MANAGED_ROOTS="$(jq -r '.managedRoots[]' .docstore/store.config.json)"
CHANGED="$(git diff --cached --name-only)"

for root in $MANAGED_ROOTS; do
  if echo "$CHANGED" | grep -q "^${root}/"; then
    if ! echo "$CHANGED" | grep -q "^\\.docstore/INDEX.json\\|^\\.docstore/.journal\\|^\\.docstore/store.config.json"; then
      echo "ManagedDocStore violation: bare change inside managedRoots"
      exit 1
    fi
  fi
done
```

上面是示意，
不是最终脚本实现。

contract 在于：

1. `legacy`
   - 不拦。
2. `mixed`
   - 只检查 `managedRoots`。
3. `managed`
   - 全量强制受管路径。

### 15.2 mixed 期新增文档规则

`mixed` 模式下必须增加一条检查：

如果提交中新出现一个位于 `managedRoots` 的正文文件，
但它没有在 `INDEX.json` 登记，
CI 必须失败。

### 15.3 managed 期强制规则

`managed` 模式下：

1. 新建受管正文必须通过 store CLI/API 产生。
2. 直接编辑 `.docstore/designs/*.md`、`.docstore/decisions/*.md`、`.docstore/process/*.md`
   必须被视为违规。
3. `externalRef` / `workspaceInstruction` 对象的源文件若留原位，
   则不受此条约束。

## 16. 扩展模型

扩展应该挂在 `ExtensionType`，
而不是污染内核 `DocumentKind`。

### 16.1 ExtensionTypeDefinition

```ts
export const ExtensionTypeDefinitionSchema = z.object({
  name: z.string(),
  baseKind: DocumentKindSchema,
  artifactSchemaVersion: z.string(),
  requiredFields: z.array(z.string()).default([]),
  queryableFields: z.array(z.string()).default([]),
  metadataSchema: z.record(z.unknown()).default({}),
  renderer: z.string().optional(),
  migrationHints: z.array(z.string()).default([])
}).passthrough();
```

### 16.2 gameplay-log 扩展示例

```json
{
  "name": "gameplay-log",
  "baseKind": "process",
  "artifactSchemaVersion": "gameplay-log@1.0.0",
  "requiredFields": ["sessionId"],
  "queryableFields": ["sessionId", "gameVersion"],
  "metadataSchema": {
    "sessionId": "string",
    "gameVersion": "string",
    "metrics": "object"
  },
  "renderer": "gameplay-log-renderer"
}
```

注册后允许：

```ts
await managedDocStore.createDocument({
  kind: "process",
  subtype: "gameplay-log",
  title: "Boss Fight Balance Session",
  metadata: {
    sessionId: "s42",
    gameVersion: "0.8.1",
    metrics: { dps: 1240 }
  }
});
```

不允许：

- 把 `gameplay-log` 当成新的 `DocumentKind`
- 让 `relations.type` 自由字符串漂移
- 在未注册扩展时写入该 subtype

## 17. 引用解析与查询

`resolveDocumentRef` 替代旧名 `resolveRef`。

`linkDocuments` 替代 `linkDesign`，
因为关系是跨 kind 的。

### 17.1 引用规则

所有引用必须落到以下两类之一：

1. 内部引用
   - 目标必须是某个 `DocumentRecord.id`
2. 外部引用
   - 目标必须显式登记为 `externalRef` 或 `workspaceInstruction`

### 17.2 externalRef / workspaceInstruction

为了避免把 `CLAUDE.md` 和跨项目 instruction 硬迁进 store，
引入两个内置类别：

- `externalRef`
  - 泛化的外部文档登记类型。
- `workspaceInstruction`
  - 工作区级别 instruction 文档，
    例如 `CLAUDE.md`、跨项目操作约束。

这两类对象必须记录：

- 原始路径
- 是否允许原位编辑
- 最后扫描时间
- checksum 或等价内容指纹

但它们默认不纳入“必须经 `ManagedDocStore` 写入”约束。

### 17.3 查询策略

`queryDocuments` 默认从索引读。

只有在以下场景才允许正文回读：

- `resolveDocumentRef` 需要正文内容。
- `doctor` 需要重新计算 checksum。
- migration 需要 rewrite refs。

正文回读是索引的补充，
不是绕过索引。

## 18. Audit/Observability

旧稿里审计分散在 journal、错误和 blind spots 里，
需要收拢成单章。

### 18.1 审计面

系统至少要产出三类可观测数据：

1. **journal**
   - 每次 mutation / migrate 的交易记录。
2. **doctor report**
   - 当前 store 健康快照。
3. **metrics**
   - 性能和完整性指标。

### 18.2 必备指标

至少暴露：

- `managed_docstore_total_documents`
- `managed_docstore_total_external_refs`
- `managed_docstore_dangling_reference_count`
- `managed_docstore_orphan_document_count`
- `managed_docstore_journal_pending_count`
- `managed_docstore_last_successful_backup_timestamp`
- `managed_docstore_last_successful_migration_timestamp`
- `managed_docstore_validate_duration_ms`

### 18.3 审计字段

每条 journal 记录至少包含：

- `entryId`
- `txId`
- `timestamp`
- `actor`
- `committed`
- `docId` 或 `migrationId`

每次 `doctor` 输出至少包含：

- 模式
- storeFormatVersion
- 索引统计
- 恢复动作
- 风险等级

### 18.4 故障后的观测要求

如果 `open()` 触发恢复，
系统必须把恢复动作写入：

- journal
- `backups/restore-log/`
- `DoctorReport.recoveryActions`

不能只在 stdout 打一行然后丢失。

## 19. Failure Recovery & Backups

恢复与备份不能只依赖 journal。

原因是：

- journal 可能损坏
- 人为误操作可能同时污染索引和正文
- migration 需要可验证的回滚点

### 19.1 备份层级

至少支持两层：

1. **pre-mutation lightweight snapshot**
   - 对被修改的目标文件和 `INDEX.json` 做最小快照。
2. **pre-migration full snapshot**
   - 在大版本迁移前对整个 `.docstore/` 做目录级快照。

### 19.2 备份命名

备份文件命名必须带：

- 时间戳
- txId 或 migrationId
- storeFormatVersion

示例：

```text
.docstore/backups/snapshots/2026-04-14T10-30-00Z_tx-018_store-1.0.0.tar.zst
```

### 19.3 恢复策略

恢复顺序固定为：

1. 尝试 journal replay
2. 若 journal 无法判定，则使用 lightweight snapshot
3. 若 store migration 失败，则使用 full snapshot rollback

### 19.4 恢复演练

每次引入新的 migration 类型，
都应补一条恢复演练用例：

- 损坏 `INDEX.json`
- 中断 `git mv`
- journal 最后一条为 `pending`
- backup 存在但 restore log 缺失

### 19.5 何时拒绝自动恢复

出现以下情况时必须进入人工干预模式：

1. `INDEX.json` 与正文都被修改且冲突无法决议
2. journal checksum 不可信
3. rollback snapshot 缺失
4. 跨多个 managedRoots 的 rename 图出现环

## 20. Migration & Cutover

这章专门回答“怎么从历史仓库切到受管仓库”。

### 20.1 总原则

迁移优先保留 git 历史。

因此正文搬迁必须优先 `git mv`，
不要用“复制新文件 + 删除旧文件”的方式破坏 blame 连续性。

### 20.2 两提交策略

历史保留采用两提交策略，
不要揉在一个提交里。

**提交一：纯路径迁移**

- 只做 `git mv docs/... .docstore/...`
- 不改内容
- 不注入 frontmatter
- 不改链接
- 不生成索引

目标是最大化 Git 对 rename 的识别概率。

**提交二：语义纳管**

- 注入 frontmatter
- 生成或更新 `INDEX.json`
- 链接规范化
- 生成 journal 初始化记录
- 更新 `store.config.json`
- 视需要在旧路径留下 stub/README

### 20.3 cutover 顺序

建议 cutover 顺序如下：

1. `init`
2. `doctor`
3. 选定一批文档做 `adoptDocument`
4. 形成 mixed 期
5. 跑 CI 验证 mixed 约束
6. 等受管范围稳定后切到 `managed`

### 20.4 旧路径 stub 规则

若采用 stub：

1. 内容只能说明新位置。
2. 不再保留完整正文。
3. 必须包含新 `docId` 或新路径。

示例：

```md
# Moved

This document is now managed at `.docstore/designs/doc-store-api-draft.md`.

ManagedDocStore ref: `design:managed-docstore-api-draft`
```

### 20.5 对 `CLAUDE.md` 的特殊处理

`CLAUDE.md` 和跨项目 instruction 默认不参加两提交正文迁移。

它们走另一条路线：

1. 在索引中登记为 `workspaceInstruction`
2. 物理文件留原位
3. 建立 checksum、扫描时间、引用关系
4. 不纳入“必须经 store 写入正文”的强制规则

## 21. 错误体系

所有错误继承自 `ManagedDocStoreError`。

```ts
export abstract class ManagedDocStoreError extends Error {
  readonly code!: string;
  readonly context!: Record<string, unknown>;
  readonly recoverySuggestion?: string;
}
```

必须定义的错误至少包括：

- `DanglingReferenceError`
  - 引用目标不存在或未登记。
- `OrphanDocumentError`
  - 文件存在但索引无对应登记。
- `SchemaVersionMismatchError`
  - store 或 artifact schema 版本不匹配。
- `TransactionConflictError`
  - 写锁冲突或乐观版本冲突。
- `JournalCorruptError`
  - journal 损坏且无法自动恢复。
- `InvalidExtensionTypeError`
  - 未注册扩展 subtype 被写入。
- `ChecksumMismatchError`
  - 内容指纹不一致。
- `ArchiveMutationError`
  - 试图修改已归档对象。
- `ConfigIndexDriftError`
  - `store.config.json` 与 `INDEX.json.managedRoots` 不一致。

所有错误对象必须携带：

- `timestamp`
- `affectedRefs`
- `context`
- `recoverySuggestion`

## 22. 验证与不变量

旧稿里“不变量”方向是正确的，
这里把它们更新为新命名和新模式。

1. **No Orphaned Documents**
   - `INDEX.json` 中的每个 `DocumentRecord` 若 `managed = true`，
     则其正文必须存在且 checksum 匹配。
2. **No Dangling References**
   - 所有内部引用必须能解析到已有 `DocumentRecord.id`。
3. **Single Source of Truth by Reference**
   - 查询入口是索引，
     不是随意扫裸 Markdown。
4. **Journal Recoverability**
   - 每个 `pending` 条目都必须能被恢复流程解释为 `committed` 或 `aborted`。
5. **Mode Consistency**
   - hook/CI 看到的 mode 与 store config 必须一致。
6. **Store Version Consistency**
   - `INDEX.json.storeFormatVersion` 与 `.schema-version` 必须一致。
7. **Extension Registration**
   - 扩展 subtype 必须先注册。
8. **Archive Immutability**
   - 归档后禁止普通 update。
9. **External Reference Clarity**
   - `externalRef` / `workspaceInstruction` 必须显式标注为外部对象，
     不能伪装成 store 内正文。

`validate()` 应返回按不变量分组的报告，
而不是只给一个布尔值。

## 23. 示例对象

### 23.1 INDEX.json 片段

```json
{
  "version": "1.0.0",
  "storeFormatVersion": "1.0.0",
  "managedRoots": [
    ".docstore/designs",
    ".docstore/decisions",
    ".docstore/process"
  ],
  "lastUpdated": "2026-04-14T10:30:00.000Z",
  "documents": {
    "design:managed-docstore-api-draft": {
      "id": "design:managed-docstore-api-draft",
      "kind": "design",
      "subtype": null,
      "title": "ManagedDocStore API 设计草案",
      "slug": "managed-docstore-api-draft",
      "path": ".docstore/designs/doc-store-api-draft.md",
      "managed": true,
      "external": false,
      "storeFormatVersion": "1.0.0",
      "artifactSchemaVersion": "design@1.0.0",
      "documentRevision": 4,
      "createdAt": "2026-04-14T10:00:00.000Z",
      "updatedAt": "2026-04-14T10:30:00.000Z",
      "refs": [
        {
          "to": "workspaceInstruction:claude-md",
          "type": "references",
          "strength": "weak"
        }
      ],
      "metadata": {},
      "extensions": {},
      "extra": {}
    },
    "workspaceInstruction:claude-md": {
      "id": "workspaceInstruction:claude-md",
      "kind": "workspaceInstruction",
      "subtype": null,
      "title": "Workspace Instruction - CLAUDE.md",
      "slug": "claude-md",
      "path": "CLAUDE.md",
      "managed": false,
      "external": true,
      "storeFormatVersion": "1.0.0",
      "artifactSchemaVersion": "workspaceInstruction@1.0.0",
      "documentRevision": 1,
      "createdAt": "2026-04-14T10:00:00.000Z",
      "updatedAt": "2026-04-14T10:00:00.000Z",
      "refs": [],
      "metadata": {
        "allowInPlaceEdits": true
      },
      "extensions": {},
      "extra": {}
    }
  },
  "relations": [
    {
      "from": "design:managed-docstore-api-draft",
      "to": "workspaceInstruction:claude-md",
      "type": "references",
      "strength": "weak",
      "addedAt": "2026-04-14T10:30:00.000Z"
    }
  ],
  "stats": {
    "totalDocuments": 2,
    "totalReferences": 1,
    "orphanedCount": 0,
    "externalCount": 1
  },
  "extensions": {},
  "extra": {}
}
```

### 23.2 store.config.json 片段

```json
{
  "mode": "mixed",
  "managedRoots": [
    ".docstore/designs",
    ".docstore/decisions",
    ".docstore/process"
  ],
  "legacyRoots": [
    "docs/designs",
    "docs/operations"
  ],
  "trackedExternalPaths": [
    "CLAUDE.md",
    "AGENTS.md"
  ],
  "adoptionPolicy": {
    "preferGitMove": true,
    "leaveLegacyStubWhenMoved": true,
    "requireRegistrationForNewManagedDocs": true
  },
  "hookPolicy": {
    "blockBareWritesInManagedRoots": true,
    "allowLegacyEditsOutsideManagedRoots": true
  }
}
```

### 23.3 Journal 片段

```json
{
  "type": "update",
  "entryId": "je_018",
  "timestamp": "2026-04-14T10:31:00.000Z",
  "committed": "committed",
  "docId": "design:managed-docstore-api-draft",
  "changes": {
    "documentRevision": 5
  },
  "actor": "codex",
  "txId": "tx_018"
}
```

## 24. Blind Spots（修订后仍未决）

本章只保留修订后仍然没有定论的问题。

已经被本稿吸收为明确 contract 的内容，
不再留在 blind spots 里。

1. **多进程 / 多机锁**
   - 当前只定义本地排它锁 contract。
   - 分布式场景是否要引入租约锁仍未定。
2. **超大规模索引**
   - 当 `INDEX.json` 超过十万对象时，
     是否引入二级索引存储尚未定。
3. **全文检索**
   - 目前只定义引用解析和元数据查询。
   - 全文检索的实现边界未定。
4. **秘密扫描**
   - 是否在 adoption 或 create/update 时默认执行 secret scan 尚未定。
5. **压缩存储**
   - 备份和 archive 是否统一使用压缩包格式，
     以及压缩级别的默认值未定。
6. **Sprint 1 已知实现缺陷（Sprint 1-bis 处理）**
   以下 3 条在 Sprint 1 初始实现中由第 6 轮 codex review 暴露。
   为避免把多个语义决定揉进同一 commit，约定在独立的
   Sprint 1-bis 中完整处理并补齐回归测试。下游 Sprint（hook/CI、
   adopt/import）不直接依赖 refs-mirror 完整性，可与 Sprint 1-bis 并行推进。
   - **B11 [P1]**：`archiveDocument(B)` 成功后，若 `B` 仍有 `inboundRefs`，
     源记录 `A` 的任何 `updateDocument` 改 `refs`（含移除指向 B 的边）
     都会触发 `ArchiveImmutableError` — archive 语义与 refs-mirror 语义冲突。
     - Sprint 1-bis 决策：采用**严格策略**。`archiveDocument` 必须拒绝仍有
       live inboundRefs 的目标；只有当 inbound 来源都已 archived（或不存在）时，
       target 才允许进入 archive。这样 archived artifact 继续保持完全 immutable，
       source 侧也不需要引入“retarget/remove 时可写 archived target”的特例。
   - **B12 [P2]**：`linkDocuments` 的 duplicate 检查忽略 `strength`；
     weak → strong 升级时 outbound 保持 weak、inbound mirror 已经写 strong
     → 同一关系图两侧描述不一致。
     - Sprint 1-bis 修法：duplicate 判定同时比对 strength；
       strength 升级走"替换旧 outbound"路径。
   - **B13 [P2]**：`updateDocument` 改 `refs` 触发 target artifacts 重写（inbound mirror）；
     crash 落在 target artifacts 已写、INDEX 未更新的窗口时，
     recovery 只回滚 source，target artifacts 保留 speculative 状态
     → 重启后 artifact rev 与 INDEX rev 不一致。
     - Sprint 1-bis 修法：recovery 对被 mirror 触及的所有 target 做一致性回滚
       （从 INDEX 的 old revision 重建 artifact，或把 mirror-targets 记入 journal payload
       便于针对性 rollback）。
7. **Sprint 2 已知实现缺陷（Sprint 2-bis 处理）**
   Sprint 2 连续 4 轮 review 都在 enforce-staged 同一主题找到 gap
   （每轮 2–3 个）。现象性结论：enforce-staged 和 doctor 存在**重合逻辑但没共享
   ground truth**——每次都是"doctor 覆盖的，enforce-staged 漏了其中一条"。
   - **Sprint 2-bis 重构方向**：`enforce-staged = runDoctorOnSnapshot(stagedConfig, stagedIndex) + checkStagedDiff`。
     让 doctor 成为 commit-time metadata integrity 的**唯一真源**，
     enforce-staged 只负责组合调用 + 处理 staged/working-tree 的差异。
     避免继续在 enforce-staged 里拼凑"同一套 doctor 检查但只做了一半"。
   - 当前已知且未修的 gap（本次 commit 保留）：
     - **B14 [P1]**：`parseJsonSnapshot()` 只做 `JSON.parse`，不验 staged INDEX 的
       checksum/schema → 会让 commit 后 `readIndex()` 立即炸的状态溜过 hook。
     - **B15 [P2]**：enforce-staged 不查 staged config ↔ staged INDEX 的
       managedRoots drift → commit 后 doctor 立即报 `CONFIG_INDEX_DRIFT`。
     - **B16 [P2]**：staged `store.config.json` 删除（`git rm .docstore/store.config.json`）
       被当作"用 HEAD"放行 → commit 后 `doctor` 报 `CONFIG_MISSING`，
       managed-mode enforcement 实际被禁用直到有人重建配置。
   - Sprint 3（adopt/import、genesis 自举）不依赖这些 gap 的修复，可并行推进。

## 25. 结论

本修订把旧稿从“方向正确但无法照抄实现”，
提升到“reader 可以按章节落代码和约束”。

关键变化是：

1. 明确 `ManagedDocStore` 外部命名。
2. 把 `.doc-state/` 更名为 `.docstore/`。
3. 用 `DocumentKind` / `DocumentRecord` / `ExtensionType` 统一模型层。
4. 把迁移三态、前向兼容、store-level migration、genesis、mixed 期 enforcement 写成硬 contract。
5. 把 `CLAUDE.md` 之类 instruction 明确纳入 `workspaceInstruction` / `externalRef`，
   避免为了“统一管理”而做错误的物理硬迁移。

只有在这些 contract 都成立后，
`ManagedDocStore` 才值得从 design 走到 implementation。
