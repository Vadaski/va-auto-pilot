#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  AlreadyOpenError,
  ArchiveImmutableError,
  DanglingReferenceError,
  ExtensionNotRegisteredError,
  InvalidInputError,
  InvalidStoreRootError,
  SchemaVersionMismatchError,
  acquireLock,
  appendEntry,
  openManagedDocStore,
  releaseLock,
  readAll
} from "./lib/doc-store/index.mjs";
import { writeArtifact } from "./lib/doc-store/artifacts.mjs";
import { readIndex, writeIndexAtomic } from "./lib/doc-store/index-file.mjs";
import { buildArtifactPath } from "./lib/doc-store/shared.mjs";
import { buildDefaultIndex, createRecord, createRegistry } from "./lib/doc-store/store-models.mjs";

function createRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doc-store-"));
}

async function openStore() {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  return { root, store };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function readArtifact(root, artifactPath) {
  return JSON.parse(fs.readFileSync(path.join(root, artifactPath), "utf8"));
}

test("open rejects relative paths", async () => {
  await assert.rejects(() => openManagedDocStore("relative/path"), InvalidStoreRootError);
});

test("createDocument writes artifact, index, and journal", async () => {
  const { root, store } = await openStore();
  const record = await store.createDesign({ title: "Managed SDK" });
  const index = await store.getIndex();
  const journal = await readAll(path.join(root, ".journal", "current.jsonl"));

  assert.equal(record.id, "design:managed-sdk");
  assert.ok(fs.existsSync(path.join(root, record.path)));
  assert.equal(index.entries[record.id].frontmatter.title, "Managed SDK");
  assert.equal(journal.at(-1)?.status, "committed");
});

test("startup recovery aborts pending journal entries", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  await store.close();

  const journalPath = path.join(root, ".journal", "current.jsonl");
  await appendEntry(journalPath, {
    txId: "tx-crash",
    timestamp: new Date().toISOString(),
    op: "create",
    payload: { ref: "design:crash-case" },
    status: "pending"
  });

  const reopened = await openManagedDocStore(root);
  const journal = await readAll(journalPath);
  const index = await reopened.getIndex();
  assert.equal(journal.at(-1)?.status, "aborted");
  assert.equal(index.entries["design:crash-case"], undefined);
});

test("INDEX passthrough preserves future fields", async () => {
  const root = createRoot();
  const indexPath = path.join(root, "INDEX.json");
  const initialIndex = {
    storeFormatVersion: "1.0.0",
    managedRoots: ["designs", "decisions", "process", "archive"],
    entries: {},
    lastUpdated: new Date().toISOString(),
    extensions: {},
    _futureField: "x"
  };
  await writeIndexAtomic(indexPath, initialIndex);
  fs.mkdirSync(path.join(root, ".journal"), { recursive: true });
  fs.writeFileSync(path.join(root, ".journal", "current.jsonl"), "", "utf8");

  const store = await openManagedDocStore(root);
  await store.createDecision({ title: "Keep passthrough" });
  const roundTripped = JSON.parse(fs.readFileSync(indexPath, "utf8"));

  assert.equal(roundTripped._futureField, "x");
});

test("validate reports orphan documents", async () => {
  const { root, store } = await openStore();
  fs.writeFileSync(path.join(root, "designs", "orphan.json"), JSON.stringify({ hello: "world" }), "utf8");

  const report = await store.validate();
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((item) => item.type === "OrphanDocumentError"));
});

test("validate reports dangling artifact references", async () => {
  const { root, store } = await openStore();
  const record = await store.createDecision({ title: "Broken path" });
  fs.unlinkSync(path.join(root, record.path));

  const report = await store.validate();
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((item) => item.ref === record.id && item.type === "DanglingReferenceError"));
});

test("linkDocuments records inbound and outbound relations", async () => {
  const { store } = await openStore();
  const design = await store.createDesign({ title: "Origin" });
  const decision = await store.createDecision({ title: "Target" });

  await store.linkDocuments(design.id, decision.id, "depends");
  const resolvedDecision = await store.resolveDocumentRef(decision.id);

  assert.ok(resolvedDecision?.inboundRefs?.some((item) => item.to === design.id && item.relation === "depends"));
});

test("createDocument mirrors refs into target inboundRefs", async () => {
  const { store } = await openStore();
  const target = await store.createDesign({ title: "Target first" });
  const source = await store.createDesign({ title: "Source second", refs: [{ to: target.id, relation: "depends" }] });
  const resolvedTarget = await store.resolveDocumentRef(target.id);

  assert.ok(
    resolvedTarget?.inboundRefs?.some(
      (item) => item.to === source.id && item.relation === "depends" && item.strength === "weak"
    )
  );
});

test("createDocument rejects dangling refs without leaving partial state", async () => {
  const { root, store } = await openStore();

  await assert.rejects(
    () => store.createDesign({ title: "Broken source", refs: [{ to: "design:nonexistent", relation: "depends" }] }),
    (error) => error instanceof DanglingReferenceError && error.code === "DANGLING_REFERENCE"
  );

  const index = await store.getIndex();
  assert.deepEqual(Object.keys(index.entries), []);
  assert.deepEqual(fs.readdirSync(path.join(root, "designs")), []);
});

test("createDocument rejects archived ref targets without mutating them", async () => {
  const { root, store } = await openStore();
  const target = await store.createDesign({ title: "Archive target" });
  const archivedTarget = await store.archiveDocument(target.id);

  await assert.rejects(
    () => store.createDesign({ title: "Blocked source", refs: [{ to: target.id, relation: "depends" }] }),
    (error) => error instanceof ArchiveImmutableError && error.code === "ARCHIVE_IMMUTABLE"
  );

  const index = await store.getIndex();
  const resolvedTarget = await store.resolveDocumentRef(target.id);
  assert.deepEqual(Object.keys(index.entries), [target.id]);
  assert.deepEqual(fs.readdirSync(path.join(root, "designs")), []);
  assert.equal(resolvedTarget?.revision, archivedTarget.revision);
  assert.deepEqual(resolvedTarget?.inboundRefs ?? [], archivedTarget.inboundRefs ?? []);
});

test("registered extension subtype can create process entries", async () => {
  const { store } = await openStore();
  await store.registerExtensionType({ name: "gameplay-log", kind: "process", artifactSchemaVersion: "process@1.1.0" });
  const record = await store.createProcessEntry({ title: "Boss balance", subtype: "gameplay-log" });
  assert.equal(record.subtype, "gameplay-log");
  assert.equal(record.artifactSchemaVersion, "process@1.1.0");
});

test("unregistered extension subtype is rejected", async () => {
  const { store } = await openStore();
  await store.registerExtensionType({ name: "gameplay-log", kind: "process" });
  await store.unregisterExtensionType("gameplay-log");
  await assert.rejects(
    () => store.createProcessEntry({ title: "Boss balance", subtype: "gameplay-log" }),
    ExtensionNotRegisteredError
  );
});

test("opening a newer store format fails fast", async () => {
  const root = createRoot();
  const indexPath = path.join(root, "INDEX.json");
  await writeIndexAtomic(indexPath, {
    storeFormatVersion: "2.0.0",
    managedRoots: ["designs"],
    entries: {},
    extensions: {}
  });
  fs.mkdirSync(path.join(root, ".journal"), { recursive: true });
  fs.writeFileSync(path.join(root, ".journal", "current.jsonl"), "", "utf8");

  await assert.rejects(() => openManagedDocStore(root), SchemaVersionMismatchError);
});

test("INDEX stores embedded checksum and removes legacy checksum files", async () => {
  const { root, store } = await openStore();
  fs.writeFileSync(path.join(root, ".checksum"), "legacy\n", "utf8");

  const created = await store.createDesign({ title: "Checksum carrier" });
  const rawIndex = JSON.parse(fs.readFileSync(path.join(root, "INDEX.json"), "utf8"));
  const hydrated = await store.getIndex();

  assert.equal(typeof rawIndex.__checksum, "string");
  assert.equal(fs.existsSync(path.join(root, ".checksum")), false);
  assert.equal(hydrated.__checksum, undefined);
  assert.equal(hydrated.entries[created.id].frontmatter.title, "Checksum carrier");
});

test("extension type mutations keep concurrent document creations in INDEX", async () => {
  const root = createRoot();
  let entered = null;
  let release = null;
  const store = await openManagedDocStore(root, {
    __testHooks: {
      beforeAcquireLock: async ({ op }) => {
        if (op === "register-extension-type" && entered && release) {
          entered.resolve();
          await release.promise;
        }
      }
    }
  });

  entered = createDeferred();
  release = createDeferred();
  const pendingRegister = store.registerExtensionType({ name: "foo", kind: "process" });
  await entered.promise;
  const victim = await store.createDesign({ title: "Victim" });
  release.resolve();
  await pendingRegister;
  await store.unregisterExtensionType("foo");

  const index = await store.getIndex();
  assert.equal(index.entries[victim.id]?.frontmatter.title, "Victim");
});

test("archiving same slug across kinds writes distinct archive artifacts", async () => {
  const { root, store } = await openStore();
  const design = await store.createDesign({ title: "Same" });
  const decision = await store.createDecision({ title: "Same" });

  const archivedDesign = await store.archiveDocument(design.id);
  const archivedDecision = await store.archiveDocument(decision.id);
  const index = await store.getIndex();

  assert.notEqual(index.entries[design.id].path, index.entries[decision.id].path);
  assert.equal(index.entries[design.id].path, archivedDesign.path);
  assert.equal(index.entries[decision.id].path, archivedDecision.path);
  assert.ok(fs.existsSync(path.join(root, archivedDesign.path)));
  assert.ok(fs.existsSync(path.join(root, archivedDecision.path)));
});

test("archiveDocument rejects already archived refs without corrupting the store", async () => {
  const { root, store } = await openStore();
  const design = await store.createDesign({ title: "Archive once" });
  const archived = await store.archiveDocument(design.id);

  await assert.rejects(
    () => store.archiveDocument(design.id),
    (error) => error instanceof ArchiveImmutableError && error.code === "ARCHIVE_IMMUTABLE"
  );

  const index = await store.getIndex();
  const report = await store.validate();
  assert.equal(index.entries[design.id].path, archived.path);
  assert.equal(fs.existsSync(path.join(root, archived.path)), true);
  assert.equal(report.ok, true);
});

test("validate reports duplicate INDEX paths", async () => {
  const { root, store } = await openStore();
  const design = await store.createDesign({ title: "Same" });
  const decision = await store.createDecision({ title: "Different" });
  const index = await store.getIndex();

  index.entries[decision.id].path = index.entries[design.id].path;
  await writeIndexAtomic(path.join(root, "INDEX.json"), index);

  const report = await store.validate();
  assert.equal(report.ok, false);
  assert.ok(report.violations.some((item) => item.type === "DuplicatePathViolation" && item.ref === index.entries[design.id].path));
});

test("startup recovery deletes orphan artifacts left by pending journal entries", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  await store.close();

  const record = createRecord("design", { title: "Crash orphan" }, createRegistry());
  const journalPath = path.join(root, ".journal", "current.jsonl");
  await writeArtifact(root, record);
  await appendEntry(journalPath, {
    txId: "tx-orphan",
    timestamp: new Date().toISOString(),
    op: "create",
    payload: { ref: record.id, kind: record.kind, path: record.path },
    status: "pending"
  });

  const reopened = await openManagedDocStore(root);
  const report = await reopened.validate();
  assert.equal(fs.existsSync(path.join(root, record.path)), false);
  assert.equal(report.ok, true);
});

test("startup recovery removes dangling INDEX entries left by pending journal entries", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  await store.close();

  const record = createRecord("design", { title: "Crash dangling" }, createRegistry());
  const index = buildDefaultIndex();
  const journalPath = path.join(root, ".journal", "current.jsonl");
  index.entries[record.id] = record;
  await writeIndexAtomic(path.join(root, "INDEX.json"), index);
  await appendEntry(journalPath, {
    txId: "tx-dangling",
    timestamp: new Date().toISOString(),
    op: "create",
    payload: { ref: record.id, kind: record.kind, path: record.path },
    status: "pending"
  });

  const reopened = await openManagedDocStore(root);
  const recoveredIndex = await reopened.getIndex();
  const report = await reopened.validate();
  assert.equal(recoveredIndex.entries[record.id], undefined);
  assert.equal(report.ok, true);
});

test("startup recovery rolls back pending updates when INDEX stayed on the old revision", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  const record = await store.createDesign({ title: "Recover update", body: "old" });
  await store.close();

  const journalPath = path.join(root, ".journal", "current.jsonl");
  const updated = { ...record, revision: 2, frontmatter: { ...record.frontmatter, body: "new", updatedAt: new Date().toISOString() } };
  await writeArtifact(root, updated);
  await appendEntry(journalPath, {
    txId: "tx-update-recovery",
    timestamp: new Date().toISOString(),
    op: "update",
    payload: { ref: record.id, path: record.path, revision: 2 },
    status: "pending"
  });

  const reopened = await openManagedDocStore(root);
  const recovered = await reopened.resolveDocumentRef(record.id);
  const journal = await readAll(journalPath);
  assert.equal(recovered?.revision, 1);
  assert.equal(recovered?.frontmatter.body, "old");
  assert.equal(readArtifact(root, record.path).frontmatter.body, "old");
  assert.equal(journal.at(-1)?.status, "aborted");
});

test("startup recovery finishes pending archives when the archived copy is the only surviving artifact", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  const record = await store.createDesign({ title: "Recover archive" });
  await store.close();

  const archived = {
    ...record,
    archived: true,
    revision: 2,
    path: buildArtifactPath(record.kind, record.frontmatter.slug, true),
    frontmatter: { ...record.frontmatter, archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
  };
  const journalPath = path.join(root, ".journal", "current.jsonl");
  await writeArtifact(root, archived);
  fs.unlinkSync(path.join(root, record.path));
  await appendEntry(journalPath, {
    txId: "tx-archive-recovery",
    timestamp: new Date().toISOString(),
    op: "archive",
    payload: { ref: record.id, path: archived.path, previousPath: record.path, revision: 2 },
    status: "pending"
  });

  const reopened = await openManagedDocStore(root);
  const recovered = await reopened.resolveDocumentRef(record.id);
  const report = await reopened.validate();
  assert.equal(recovered?.path, archived.path);
  assert.equal(recovered?.archived, true);
  assert.equal(fs.existsSync(path.join(root, archived.path)), true);
  assert.equal(report.ok, true);
});

test("invalid update refs are rejected before INDEX.json can be bricked", async () => {
  const { root, store } = await openStore();
  const created = await store.createDesign({ title: "Valid design" });

  await assert.rejects(
    () => store.updateDocument(created.id, { refs: "oops" }),
    (error) => error instanceof InvalidInputError && error.code === "INVALID_INPUT" && /refs/.test(error.message)
  );

  const rawIndex = await readIndex(path.join(root, "INDEX.json"));
  assert.equal(rawIndex.entries[created.id].refs.length, 0);

  await store.close();
  const reopened = await openManagedDocStore(root);
  const reopenedIndex = await reopened.getIndex();
  assert.equal(reopenedIndex.entries[created.id].frontmatter.title, "Valid design");
  await reopened.close();
});

test("updateDocument keeps inboundRefs mirrored across ref retargets and removals", async () => {
  const { store } = await openStore();
  const source = await store.createDesign({ title: "Source design" });
  const targetB = await store.createDesign({ title: "Target B" });
  const targetC = await store.createDesign({ title: "Target C" });

  await store.updateDocument(source.id, { refs: [{ to: targetB.id, relation: "depends" }] });
  let resolvedB = await store.resolveDocumentRef(targetB.id);
  let resolvedC = await store.resolveDocumentRef(targetC.id);
  assert.ok(resolvedB?.inboundRefs?.some((item) => item.to === source.id && item.relation === "depends"));
  assert.equal(resolvedC?.inboundRefs?.some((item) => item.to === source.id && item.relation === "depends"), false);

  await store.updateDocument(source.id, { refs: [{ to: targetC.id, relation: "depends" }] });
  resolvedB = await store.resolveDocumentRef(targetB.id);
  resolvedC = await store.resolveDocumentRef(targetC.id);
  assert.equal(resolvedB?.inboundRefs?.some((item) => item.to === source.id && item.relation === "depends"), false);
  assert.ok(resolvedC?.inboundRefs?.some((item) => item.to === source.id && item.relation === "depends"));

  await store.updateDocument(source.id, { refs: [] });
  resolvedC = await store.resolveDocumentRef(targetC.id);
  assert.equal(resolvedC?.inboundRefs?.some((item) => item.to === source.id && item.relation === "depends"), false);
});

test("updateDocument rejects dangling ref targets without changing source refs", async () => {
  const { store } = await openStore();
  const source = await store.createDesign({ title: "Source design" });
  const target = await store.createDesign({ title: "Live target" });
  await store.updateDocument(source.id, { refs: [{ to: target.id, relation: "depends" }] });

  await assert.rejects(
    () => store.updateDocument(source.id, { refs: [{ to: "design:nonexistent", relation: "depends" }] }),
    (error) => error instanceof DanglingReferenceError && error.code === "DANGLING_REFERENCE"
  );

  const resolvedSource = await store.resolveDocumentRef(source.id);
  const resolvedTarget = await store.resolveDocumentRef(target.id);
  assert.deepEqual(resolvedSource?.refs, [{ to: target.id, relation: "depends", strength: "weak" }]);
  assert.ok(resolvedTarget?.inboundRefs?.some((item) => item.to === source.id && item.relation === "depends"));
});

test("updateDocument rejects archived ref targets without changing source refs", async () => {
  const { store } = await openStore();
  const source = await store.createDesign({ title: "Source design" });
  const target = await store.createDesign({ title: "Archive me" });
  const archivedTarget = await store.archiveDocument(target.id);

  await assert.rejects(
    () => store.updateDocument(source.id, { refs: [{ to: target.id, relation: "depends" }] }),
    (error) => error instanceof ArchiveImmutableError && error.code === "ARCHIVE_IMMUTABLE"
  );

  const resolvedSource = await store.resolveDocumentRef(source.id);
  const resolvedTarget = await store.resolveDocumentRef(target.id);
  assert.deepEqual(resolvedSource?.refs, []);
  assert.equal(resolvedTarget?.revision, archivedTarget.revision);
  assert.deepEqual(resolvedTarget?.inboundRefs ?? [], archivedTarget.inboundRefs ?? []);
});

test("invalid create refs are rejected before any artifact or INDEX entry is written", async () => {
  const { root, store } = await openStore();

  await assert.rejects(
    () => store.createDesign({ title: "Invalid refs", refs: [{ to: "design:x" }] }),
    (error) => error instanceof InvalidInputError && error.code === "INVALID_INPUT" && /refs\[0\]\.relation/.test(error.message)
  );

  const index = await readIndex(path.join(root, "INDEX.json"));
  assert.deepEqual(Object.keys(index.entries), []);
});

test("acquireLock clears corrupt stale lockfiles and retries immediately", async () => {
  const root = createRoot();
  const lockPath = path.join(root, ".lock");
  fs.writeFileSync(lockPath, "{", "utf8");

  const startedAt = Date.now();
  const lock = await acquireLock(lockPath, { timeoutMs: 500 });
  const elapsedMs = Date.now() - startedAt;

  assert.ok(elapsedMs < 300, `expected corrupt lock recovery within 300ms, got ${elapsedMs}ms`);
  await releaseLock(lock);
  assert.equal(fs.existsSync(lockPath), false);
});

test("concurrent updates rebase on the latest INDEX state after the write lock is acquired", async () => {
  const root = createRoot();
  let entered = null;
  let release = null;
  let pausedOnce = false;
  const store = await openManagedDocStore(root, {
    __testHooks: {
      beforeAcquireLock: async ({ op }) => {
        if (op === "update" && entered && release && !pausedOnce) {
          pausedOnce = true;
          entered.resolve();
          await release.promise;
        }
      }
    }
  });
  const record = await store.createDesign({ title: "Race", body: "old", metadata: { seed: true } });

  entered = createDeferred();
  release = createDeferred();
  const pendingA = store.updateDocument(record.id, { metadata: { fromA: true } });
  await entered.promise;
  const fromB = await store.updateDocument(record.id, { body: "B-change" });
  release.resolve();
  const fromA = await pendingA;
  const recovered = await store.resolveDocumentRef(record.id);

  assert.equal(fromA.revision, fromB.revision + 1);
  assert.equal(recovered?.frontmatter.body, "B-change");
  assert.deepEqual(recovered?.frontmatter.metadata, { fromA: true });
});

test("subtype changes recompute artifact schema version and reject unknown subtypes", async () => {
  const { store } = await openStore();
  await store.registerExtensionType({ name: "a", kind: "process", artifactSchemaVersion: "a@1.0.0" });
  await store.registerExtensionType({ name: "b", kind: "process", artifactSchemaVersion: "b@2.0.0" });
  const created = await store.createProcessEntry({ title: "Subtype migration", subtype: "a" });
  const updated = await store.updateDocument(created.id, { subtype: "b" });

  assert.equal(created.artifactSchemaVersion, "a@1.0.0");
  assert.equal(updated.artifactSchemaVersion, "b@2.0.0");
  await assert.rejects(() => store.updateDocument(created.id, { subtype: "unregistered" }), ExtensionNotRegisteredError);
});

test("embedded INDEX checksum survives concurrent reads during updates", async () => {
  const { store } = await openStore();
  const created = await store.createDesign({ title: "Mixed generation guard", body: "v0" });
  const settled = await Promise.all(
    Array.from({ length: 24 }, (_, index) =>
      Promise.allSettled([store.updateDocument(created.id, { body: `v${index + 1}` }), store.getIndex()])
    )
  );

  for (const batch of settled) {
    for (const result of batch) {
      assert.equal(result.status, "fulfilled");
      if (Array.isArray(result.value)) {
        const [, index] = result.value;
        assert.ok(index.entries[created.id]);
      }
    }
  }
});

test("open rejects a second live handle for the same root", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);

  await assert.rejects(async () => {
    await openManagedDocStore(root);
  }, (error) => error instanceof AlreadyOpenError && error.code === "ALREADY_OPEN");

  await store.close();
});

test("closed stores can be reopened for the same root", async () => {
  const root = createRoot();
  const store = await openManagedDocStore(root);
  await store.close();

  const reopened = await openManagedDocStore(root);
  const created = await reopened.createDesign({ title: "Reopened" });

  assert.equal(created.id, "design:reopened");
});

test("concurrent opens on a fresh root return one handle and one AlreadyOpenError", async () => {
  const root = createRoot();
  const [first, second] = await Promise.allSettled([openManagedDocStore(root), openManagedDocStore(root)]);
  const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
  const rejected = [first, second].filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof AlreadyOpenError);
  assert.equal(rejected[0].reason.code, "ALREADY_OPEN");

  await fulfilled[0].value.close();
});

test("subtype kind mismatches are rejected at typed create sites", async () => {
  const { store } = await openStore();
  await store.registerExtensionType({ name: "decisionish", kind: "decision", artifactSchemaVersion: "decisionish@1.0.0" });
  await store.registerExtensionType({ name: "processish", kind: "process", artifactSchemaVersion: "processish@1.0.0" });

  await assert.rejects(() => store.createProcessEntry({ title: "X", subtype: "decisionish" }), ExtensionNotRegisteredError);

  const decision = await store.createDecision({ title: "Y", subtype: "decisionish" });
  const process = await store.createProcessEntry({ title: "Z", subtype: "processish" });

  assert.equal(decision.artifactSchemaVersion, "decisionish@1.0.0");
  assert.equal(process.artifactSchemaVersion, "processish@1.0.0");
});

test("createDocument resolves subtype registration from the reloaded INDEX inside the mutation", async () => {
  const root = createRoot();
  const subtype = "queued-process";
  const artifactSchemaVersion = "queued-process@9.9.9";
  let injected = false;
  const store = await openManagedDocStore(root, {
    __testHooks: {
      beforeAcquireLock: async ({ op }) => {
        if (op !== "create" || injected) {
          return;
        }
        injected = true;
        const indexPath = path.join(root, "INDEX.json");
        const index = await readIndex(indexPath);
        index.extensions = {
          ...(index.extensions ?? {}),
          registeredTypes: {
            ...(index.extensions?.registeredTypes ?? {}),
            [subtype]: { name: subtype, kind: "process", artifactSchemaVersion }
          }
        };
        await writeIndexAtomic(indexPath, index);
      }
    }
  });

  const created = await store.createProcessEntry({ title: "Late registry", subtype });

  assert.equal(created.subtype, subtype);
  assert.equal(created.artifactSchemaVersion, artifactSchemaVersion);
});

test("linkDocuments rejects archived targets without mutating them", async () => {
  const { store } = await openStore();
  const designA = await store.createDesign({ title: "A" });
  const designB = await store.createDesign({ title: "B" });
  const archivedB = await store.archiveDocument(designB.id);

  await assert.rejects(async () => {
    await store.linkDocuments(designA.id, designB.id, "depends");
  }, (error) => error instanceof ArchiveImmutableError && error.code === "ARCHIVE_IMMUTABLE");

  const currentB = await store.resolveDocumentRef(designB.id);
  assert.equal(currentB?.revision, archivedB.revision);
  assert.deepEqual(currentB?.inboundRefs ?? [], archivedB.inboundRefs ?? []);
  assert.equal(currentB?.frontmatter.updatedAt, archivedB.frontmatter.updatedAt);
});

test("linkDocuments rejects archived sources too", async () => {
  const { store } = await openStore();
  const designA = await store.createDesign({ title: "Source archived" });
  const designB = await store.createDesign({ title: "Target live" });
  await store.archiveDocument(designA.id);

  await assert.rejects(async () => {
    await store.linkDocuments(designA.id, designB.id, "depends");
  }, (error) => error instanceof ArchiveImmutableError && error.code === "ARCHIVE_IMMUTABLE");
});
