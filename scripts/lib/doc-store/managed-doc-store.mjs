/**
 * Sprint 1 implementation of ManagedDocStore.
 *
 * Known limitations tracked for Sprint 1-bis (see design doc §24):
 *   B11 [P1]: archiving a document with live inboundRefs blocks future
 *     updateDocument edits on the source that reference it.
 *   B12 [P2]: linkDocuments duplicate check ignores strength; weak→strong
 *     upgrade leaves outbound weak while inbound mirror already holds strong.
 *   B13 [P2]: crash after mirror target rewrites but before INDEX update
 *     leaves target artifacts ahead of INDEX revision after recovery.
 *
 * Single-handle-per-root invariant holds per design §10 contract.
 */

import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { removeArtifact, resolveArtifactPath, writeArtifact } from "./artifacts.mjs";
import { AlreadyOpenError, ArchiveImmutableError, DanglingReferenceError, DocStoreError, InvalidStoreRootError } from "./errors.mjs";
import { readIndex, writeIndexAtomic } from "./index-file.mjs";
import { appendEntry } from "./journal.mjs";
import { acquireLock, releaseLock } from "./locking.mjs";
import { buildDefaultIndex, createRecord, createRegistry, patchRecord, syncRegistry, validateStoreVersion } from "./store-models.mjs";
import { recoverPendingTransactions } from "./store-recovery.mjs";
import { validateStore } from "./store-validation.mjs";
import { JOURNAL_FILE, buildArtifactPath, cloneValue, ensureStoreLayout, nowIso, pathExists } from "./shared.mjs";

// single-handle-per-root is the Sprint 1 contract per design §10; multi-handle support is future work
const OPEN_HANDLES = new Map();

// Ref mirror diffs use to+relation+strength so strength-only edits rewrite inbound mirrors too.
function relationIdentity(relation) {
  return `${relation.to}\u0000${relation.relation}\u0000${relation.strength ?? "weak"}`;
}

function buildInboundRelation(sourceRef, relation) {
  return { to: sourceRef, relation: relation.relation, strength: relation.strength ?? "weak" };
}

function uniqueRelations(relations = []) {
  const byIdentity = new Map();
  for (const relation of relations) {
    byIdentity.set(relationIdentity(relation), relation);
  }
  return byIdentity;
}

function addInboundMirror(targetRecord, sourceRef, relation) {
  const inbound = buildInboundRelation(sourceRef, relation);
  if ((targetRecord.inboundRefs ?? []).some((item) => relationIdentity(item) === relationIdentity(inbound))) {
    return false;
  }
  targetRecord.inboundRefs = [...(targetRecord.inboundRefs ?? []), inbound];
  return true;
}

function removeInboundMirror(targetRecord, sourceRef, relation) {
  const inbound = buildInboundRelation(sourceRef, relation);
  const currentInboundRefs = targetRecord.inboundRefs ?? [];
  const nextInboundRefs = currentInboundRefs.filter((item) => relationIdentity(item) !== relationIdentity(inbound));
  if (nextInboundRefs.length === currentInboundRefs.length) {
    return false;
  }
  targetRecord.inboundRefs = nextInboundRefs;
  return true;
}

function requireLiveMirrorTarget(previousIndex, stagedRecords, sourceRef, targetRef, archivedDetail) {
  const indexedTarget = previousIndex.entries[targetRef];
  if (!indexedTarget) {
    throw new DanglingReferenceError(sourceRef, targetRef);
  }
  if (indexedTarget.archived) {
    throw new ArchiveImmutableError(targetRef, archivedDetail);
  }
  if (stagedRecords.has(targetRef)) {
    return stagedRecords.get(targetRef);
  }
  const targetRecord = cloneValue(indexedTarget);
  stagedRecords.set(targetRef, targetRecord);
  return targetRecord;
}

function syncInboundRefMirrors(previousIndex, stagedRecords, sourceRef, previousRefs, nextRefs, archivedDetail) {
  const touchedTargets = new Set();
  const previousRelations = uniqueRelations(previousRefs);
  const nextRelations = uniqueRelations(nextRefs);
  for (const [identity, relation] of previousRelations) {
    if (nextRelations.has(identity)) continue;
    const targetRecord = requireLiveMirrorTarget(previousIndex, stagedRecords, sourceRef, relation.to, archivedDetail);
    if (removeInboundMirror(targetRecord, sourceRef, relation)) {
      touchedTargets.add(relation.to);
    }
  }
  for (const [identity, relation] of nextRelations) {
    if (previousRelations.has(identity)) continue;
    const targetRecord = requireLiveMirrorTarget(previousIndex, stagedRecords, sourceRef, relation.to, archivedDetail);
    if (addInboundMirror(targetRecord, sourceRef, relation)) {
      touchedTargets.add(relation.to);
    }
  }
  return touchedTargets;
}

/**
 * @param {string} absoluteRoot
 * @param {{ __testHooks?: { beforeAcquireLock?: (event: { op: string }) => Promise<void> | void } }} [options]
 * @returns {Promise<import("./index.mjs").ManagedDocStore>}
 * @throws {InvalidStoreRootError}
 */
export async function openManagedDocStore(absoluteRoot, options = {}) {
  if (!path.isAbsolute(absoluteRoot)) {
    throw new InvalidStoreRootError(absoluteRoot, "Store root must be absolute.");
  }
  if (!(await pathExists(absoluteRoot))) {
    throw new InvalidStoreRootError(absoluteRoot, "Store root does not exist.");
  }

  const rootPath = await fs.realpath(absoluteRoot);
  if (OPEN_HANDLES.has(rootPath)) {
    throw new AlreadyOpenError(rootPath);
  }
  const openingToken = Symbol(rootPath);
  OPEN_HANDLES.set(rootPath, openingToken);
  const indexPath = path.join(rootPath, "INDEX.json");
  const journalPath = path.join(rootPath, JOURNAL_FILE);
  const lockPath = path.join(rootPath, ".lock");
  try {
    await ensureStoreLayout(rootPath);
    if (!(await pathExists(journalPath))) {
      await fs.writeFile(journalPath, "", "utf8");
    }
    if (!(await pathExists(indexPath))) {
      await writeIndexAtomic(indexPath, buildDefaultIndex());
    }
    await recoverPendingTransactions(journalPath, indexPath, rootPath);

    /** @type {import("./types.mjs").StoreIndex} */
    let index = (await readIndex(indexPath)) ?? buildDefaultIndex();
    validateStoreVersion(index);
    const registry = createRegistry(index.extensions.registeredTypes ?? {});
    let closed = false;
    const testHooks = options.__testHooks ?? {};
    async function reloadIndex() {
      index = /** @type {import("./types.mjs").StoreIndex} */ ((await readIndex(indexPath)) ?? buildDefaultIndex());
      validateStoreVersion(index);
      syncRegistry(registry, index.extensions.registeredTypes ?? {});
      return index;
    }

    async function persistIndex(nextIndex) {
      nextIndex.lastUpdated = nowIso();
      nextIndex.extensions = { ...nextIndex.extensions, registeredTypes: Object.fromEntries(registry) };
      await writeIndexAtomic(indexPath, nextIndex);
      index = nextIndex;
    }
    async function restoreIndexSnapshot(previousIndex) {
      if (!previousIndex) return;
      index = previousIndex;
      syncRegistry(registry, previousIndex.extensions.registeredTypes ?? {});
      await writeIndexAtomic(indexPath, previousIndex);
    }
    async function runMutation(op, payload, applyChange, rollbackChange) {
      if (closed) throw new DocStoreError("ManagedDocStore is closed.", { code: "STORE_CLOSED" });
      await testHooks.beforeAcquireLock?.({ op });
      const lock = await acquireLock(lockPath, { timeoutMs: 30_000 });
      const txId = crypto.randomUUID();
      /** @type {import("./types.mjs").JournalEntry | null} */
      let pendingEntry = null;
      try {
        await reloadIndex();
        const resolvedPayload = typeof payload === "function" ? await payload() : payload;
        pendingEntry = { txId, timestamp: nowIso(), op, payload: resolvedPayload, status: "pending" };
        await appendEntry(journalPath, pendingEntry);
        const result = await applyChange();
        await appendEntry(journalPath, { ...pendingEntry, timestamp: nowIso(), status: "committed" });
        return result;
      } catch (error) {
        if (pendingEntry) {
          await rollbackChange();
          await appendEntry(journalPath, { ...pendingEntry, timestamp: nowIso(), status: "aborted" });
        }
        throw error;
      } finally {
        await releaseLock(lock);
      }
    }
    async function resolveDocumentRef(ref) {
      await reloadIndex();
      const record = index.entries[ref];
      return record ? cloneValue(record) : null;
    }
    async function createDocument(kind, input) {
      /** @type {import("./types.mjs").StoreIndex | null} */
      let previousIndex = null;
      /** @type {import("./types.mjs").DocumentRecord | null} */
      let record = null;
      /** @type {string[]} */
      let mirroredTargetRefs = [];
      return runMutation(
        "create",
        () => {
          previousIndex = cloneValue(index);
          // Build inside the serialized mutation so subtype validation sees the latest INDEX-backed registry state.
          record = createRecord(kind, input, registry);
          return { ref: record.id, kind, path: record.path };
        },
        async () => {
          if (!record || !previousIndex) throw new DocStoreError("Create mutation missing state.", { code: "MUTATION_STATE_MISSING" });
          if (index.entries[record.id]) throw new DocStoreError(`Document already exists: ${record.id}`, { code: "DOCUMENT_EXISTS" });
          const stagedRecords = new Map([[record.id, record]]);
          const mirroredTargets = syncInboundRefMirrors(
            previousIndex,
            stagedRecords,
            record.id,
            [],
            record.refs,
            "createDocument target is archived"
          );
          mirroredTargetRefs = [...mirroredTargets];
          const touchedAt = nowIso();
          for (const targetRef of mirroredTargetRefs) {
            const targetRecord = stagedRecords.get(targetRef);
            targetRecord.revision += 1;
            targetRecord.frontmatter.updatedAt = touchedAt;
            index.entries[targetRef] = targetRecord;
          }
          index.entries[record.id] = record;
          await writeArtifact(rootPath, record);
          for (const targetRef of mirroredTargetRefs) {
            await writeArtifact(rootPath, index.entries[targetRef]);
          }
          await persistIndex(index);
          return cloneValue(record);
        },
        async () => {
          if (!previousIndex) return;
          index = previousIndex;
          for (const targetRef of mirroredTargetRefs) {
            await writeArtifact(rootPath, previousIndex.entries[targetRef]);
          }
          await removeArtifact(rootPath, record);
          await writeIndexAtomic(indexPath, previousIndex);
        }
      );
    }
    async function updateDocument(ref, patch) {
      /** @type {import("./types.mjs").StoreIndex | null} */
      let previousIndex = null;
      /** @type {import("./types.mjs").DocumentRecord | null} */
      let next = null;
      /** @type {string[]} */
      let mirroredTargetRefs = [];
      return runMutation(
        "update",
        () => {
          previousIndex = cloneValue(index);
          const current = previousIndex.entries[ref];
          if (!current) throw new DanglingReferenceError(ref, ref);
          next = patchRecord(current, patch, registry);
          return { ref, path: next.path, revision: next.revision };
        },
        async () => {
          if (!next || !previousIndex) throw new DocStoreError("Update mutation missing state.", { code: "MUTATION_STATE_MISSING" });
          const stagedRecords = new Map([[ref, next]]);
          const mirroredTargets = syncInboundRefMirrors(
            previousIndex,
            stagedRecords,
            ref,
            previousIndex.entries[ref].refs,
            next.refs,
            "updateDocument target is archived"
          );
          mirroredTargetRefs = [...mirroredTargets];
          const touchedAt = nowIso();
          for (const targetRef of mirroredTargetRefs) {
            if (targetRef === ref) continue;
            const targetRecord = stagedRecords.get(targetRef);
            targetRecord.revision += 1;
            targetRecord.frontmatter.updatedAt = touchedAt;
            index.entries[targetRef] = targetRecord;
          }
          index.entries[ref] = next;
          await writeArtifact(rootPath, next);
          for (const targetRef of mirroredTargetRefs) {
            if (targetRef === ref) continue;
            await writeArtifact(rootPath, index.entries[targetRef]);
          }
          await persistIndex(index);
          return cloneValue(next);
        },
        async () => {
          if (!previousIndex) return;
          index = previousIndex;
          await writeArtifact(rootPath, previousIndex.entries[ref]);
          for (const targetRef of mirroredTargetRefs) {
            if (targetRef === ref) continue;
            await writeArtifact(rootPath, previousIndex.entries[targetRef]);
          }
          await writeIndexAtomic(indexPath, previousIndex);
        }
      );
    }
    async function archiveDocument(ref) {
      /** @type {import("./types.mjs").StoreIndex | null} */
      let previousIndex = null;
      /** @type {import("./types.mjs").DocumentRecord | null} */
      let next = null;
      let previousPath = "";
      return runMutation(
        "archive",
        () => {
          previousIndex = cloneValue(index);
          const current = previousIndex.entries[ref];
          if (!current) throw new DanglingReferenceError(ref, ref);
          if (current.archived) {
            // Archive is intentionally not idempotent so callers get the same immutable failure mode as updateDocument().
            throw new ArchiveImmutableError(ref, "archiveDocument target is already archived");
          }
          next = cloneValue(current);
          next.archived = true;
          next.revision += 1;
          next.path = buildArtifactPath(current.kind, current.frontmatter.slug, true);
          next.frontmatter.archivedAt = nowIso();
          next.frontmatter.updatedAt = next.frontmatter.archivedAt;
          previousPath = resolveArtifactPath(rootPath, current);
          return { ref, path: next.path, previousPath: current.path, revision: next.revision };
        },
        async () => {
          if (!next || !previousIndex) throw new DocStoreError("Archive mutation missing state.", { code: "MUTATION_STATE_MISSING" });
          index.entries[ref] = next;
          await writeArtifact(rootPath, next);
          await fs.rm(previousPath, { force: true });
          await persistIndex(index);
          return cloneValue(next);
        },
        async () => {
          if (!previousIndex || !next) return;
          index = previousIndex;
          await removeArtifact(rootPath, next);
          await writeArtifact(rootPath, previousIndex.entries[ref]);
          await writeIndexAtomic(indexPath, previousIndex);
        }
      );
    }

    async function linkDocuments(fromRef, toRef, relation) {
      /** @type {import("./types.mjs").StoreIndex | null} */
      let previousIndex = null;
      /** @type {import("./types.mjs").DocumentRecord | null} */
      let from = null;
      /** @type {import("./types.mjs").DocumentRecord | null} */
      let to = null;
      return runMutation(
        "link",
        () => {
          previousIndex = cloneValue(index);
          from = cloneValue(previousIndex.entries[fromRef] ?? null);
          to = cloneValue(previousIndex.entries[toRef] ?? null);
          if (!from) throw new DanglingReferenceError(fromRef, fromRef);
          if (!to) throw new DanglingReferenceError(fromRef, toRef);
          if (from.archived) {
            throw new ArchiveImmutableError(fromRef, "linkDocuments source is archived");
          }
          if (to.archived) {
            throw new ArchiveImmutableError(toRef, "linkDocuments target is archived");
          }
          return {
            ref: fromRef,
            toRef,
            relation,
            path: from.path,
            toPath: to.path,
            revision: from.revision + 1,
            toRevision: to.revision + 1
          };
        },
        async () => {
          if (!from || !to || !previousIndex) throw new DocStoreError("Link mutation missing state.", { code: "MUTATION_STATE_MISSING" });
          /** @type {import("./types.mjs").DocumentRelation} */
          const outbound = { to: toRef, relation, strength: "strong" };
          if (!from.refs.some((item) => item.to === toRef && item.relation === relation)) {
            from.refs.push(outbound);
          }
          addInboundMirror(to, fromRef, outbound);
          from.revision += 1;
          to.revision += 1;
          from.frontmatter.updatedAt = nowIso();
          to.frontmatter.updatedAt = from.frontmatter.updatedAt;
          index.entries[fromRef] = from;
          index.entries[toRef] = to;
          await writeArtifact(rootPath, from);
          await writeArtifact(rootPath, to);
          await persistIndex(index);
        },
        async () => {
          if (!previousIndex) return;
          index = previousIndex;
          await writeArtifact(rootPath, previousIndex.entries[fromRef]);
          await writeArtifact(rootPath, previousIndex.entries[toRef]);
          await writeIndexAtomic(indexPath, previousIndex);
        }
      );
    }

    async function getIndex() {
      await reloadIndex();
      return cloneValue(index);
    }

    async function query(filter = {}) {
      await reloadIndex();
      const records = Object.values(index.entries).map((record) => cloneValue(record));
      if (typeof filter === "function") return records.filter((record) => filter(record));
      return records.filter((record) =>
        Object.entries(filter).every(([key, value]) => record[key] === value || record.frontmatter[key] === value)
      );
    }

    async function validate() {
      await reloadIndex();
      return validateStore(rootPath, index);
    }

    /** @param {{ name: string, kind?: string, artifactSchemaVersion?: string }} spec */
    async function registerExtensionType(spec) {
      const normalized = { ...spec, kind: spec.kind ?? "process", artifactSchemaVersion: spec.artifactSchemaVersion ?? "process@1.0.0" };
      /** @type {import("./types.mjs").StoreIndex | null} */
      let previousIndex = null;
      return runMutation(
        "register-extension-type",
        normalized,
        async () => {
          previousIndex = cloneValue(index);
          registry.set(normalized.name, normalized);
          const nextIndex = cloneValue(index);
          nextIndex.extensions.registeredTypes = Object.fromEntries(registry);
          await persistIndex(nextIndex);
        },
        async () => restoreIndexSnapshot(previousIndex)
      );
    }

    async function unregisterExtensionType(name) {
      /** @type {import("./types.mjs").StoreIndex | null} */
      let previousIndex = null;
      return runMutation(
        "unregister-extension-type",
        { name },
        async () => {
          previousIndex = cloneValue(index);
          registry.delete(name);
          const nextIndex = cloneValue(index);
          nextIndex.extensions.registeredTypes = Object.fromEntries(registry);
          await persistIndex(nextIndex);
        },
        async () => restoreIndexSnapshot(previousIndex)
      );
    }

    async function close() {
      closed = true;
      if (OPEN_HANDLES.get(rootPath) === api) {
        OPEN_HANDLES.delete(rootPath);
      }
    }

    /** @type {import("./index.mjs").ManagedDocStore} */
    const api = {
      close,
      createDocument,
      updateDocument,
      archiveDocument,
      linkDocuments,
      resolveDocumentRef,
      getIndex,
      query,
      validate,
      registerExtensionType,
      unregisterExtensionType,
      createDesign: (input) => createDocument("design", input),
      createDecision: (input) => createDocument("decision", input),
      createProcessEntry: (input) => createDocument("process", input),
      closeSprint: (sprintId) =>
        createDocument("process", { title: `Sprint ${sprintId} closed`, subtype: "sprint-close", metadata: { sprintId, closedAt: nowIso() } })
    };
    OPEN_HANDLES.set(rootPath, api);
    return api;
  } catch (error) {
    if (OPEN_HANDLES.get(rootPath) === openingToken) {
      OPEN_HANDLES.delete(rootPath);
    }
    throw error;
  }
}
