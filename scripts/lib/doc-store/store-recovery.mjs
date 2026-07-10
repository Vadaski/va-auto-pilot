import fs from "node:fs/promises";
import path from "node:path";

import { appendEntry, readAll } from "./journal.mjs";
import { assertSafeArtifactParent, writeArtifact } from "./artifacts.mjs";
import { JournalCorruptError } from "./errors.mjs";
import { readIndex, writeIndexAtomic } from "./index-file.mjs";
import { buildDefaultIndex } from "./store-models.mjs";
import {
  DOCUMENT_KINDS,
  buildArtifactPath,
  buildDocumentId,
  isSafeArtifactSlug,
  nowIso,
  readJsonIfExists
} from "./shared.mjs";

const ARTIFACT_PATH_OPS = new Set(["create", "import-legacy", "adopt-legacy", "update", "link", "archive"]);

function revisionOf(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function corruptPath(journalPath, detail) {
  throw new JournalCorruptError(journalPath, detail);
}

function documentIdentityFromRef(journalPath, fieldName, ref) {
  if (typeof ref !== "string") {
    corruptPath(journalPath, `${fieldName} requires a canonical document ref`);
  }
  const separator = ref.indexOf(":");
  const kind = separator > 0 ? ref.slice(0, separator) : "";
  const slug = separator > 0 ? ref.slice(separator + 1) : "";
  if (!DOCUMENT_KINDS.includes(kind) || !isSafeArtifactSlug(slug) || ref !== buildDocumentId(kind, slug)) {
    corruptPath(journalPath, `${fieldName} cannot be bound to an artifact because ref is not canonical: ${ref}`);
  }
  return { kind, slug };
}

function assertPayloadPath(journalPath, entry, fieldName, expectedPath) {
  if (!Object.hasOwn(entry.payload, fieldName)) {
    return;
  }
  const value = entry.payload[fieldName];
  if (typeof value !== "string" || !value) {
    corruptPath(journalPath, `payload.${fieldName} must be a non-empty canonical artifact path`);
  }
  if (value !== expectedPath) {
    corruptPath(journalPath, `payload.${fieldName} must equal canonical artifact path ${expectedPath}`);
  }
}

function assertRecoveryJournalPaths(journalPath, entry) {
  const hasArtifactPath = Object.hasOwn(entry.payload, "path");
  const hasPreviousPath = Object.hasOwn(entry.payload, "previousPath");
  const hasToPath = Object.hasOwn(entry.payload, "toPath");
  if (!hasArtifactPath && !hasPreviousPath && !hasToPath) {
    return;
  }
  if (!ARTIFACT_PATH_OPS.has(entry.op)) {
    corruptPath(journalPath, `artifact paths are not allowed for journal operation ${entry.op}`);
  }

  const identity = documentIdentityFromRef(journalPath, "payload.path", entry.payload.ref);
  if (Object.hasOwn(entry.payload, "kind") && entry.payload.kind !== identity.kind) {
    corruptPath(journalPath, `payload.kind does not match payload.ref: ${String(entry.payload.kind)}`);
  }
  assertPayloadPath(
    journalPath,
    entry,
    "path",
    buildArtifactPath(identity.kind, identity.slug, entry.op === "archive")
  );

  if (hasPreviousPath) {
    if (entry.op !== "archive") {
      corruptPath(journalPath, `payload.previousPath is only valid for archive operations`);
    }
    assertPayloadPath(journalPath, entry, "previousPath", buildArtifactPath(identity.kind, identity.slug));
  }

  if (hasToPath) {
    if (entry.op !== "link") {
      corruptPath(journalPath, `payload.toPath is only valid for link operations`);
    }
    const targetIdentity = documentIdentityFromRef(journalPath, "payload.toPath", entry.payload.toRef);
    assertPayloadPath(journalPath, entry, "toPath", buildArtifactPath(targetIdentity.kind, targetIdentity.slug));
  }
}

async function resolveRecoveryArtifactPath(rootPath, relativePath, journalPath) {
  const root = path.resolve(rootPath);
  if (path.isAbsolute(relativePath)) {
    corruptPath(journalPath, `artifact path must be relative: ${relativePath}`);
  }
  const target = path.resolve(root, relativePath);
  const relative = path.relative(root, target);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    corruptPath(journalPath, `artifact path escapes the store root: ${relativePath}`);
  }
  try {
    await assertSafeArtifactParent(root, target);
    const targetStat = await fs.lstat(target).catch((error) => {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        return null;
      }
      throw error;
    });
    if (targetStat?.isSymbolicLink()) {
      corruptPath(journalPath, `artifact path must not be a symbolic link: ${relativePath}`);
    }
  } catch (error) {
    if (error instanceof JournalCorruptError) {
      throw error;
    }
    corruptPath(journalPath, `artifact path is not safe: ${relativePath} (${error instanceof Error ? error.message : String(error)})`);
  }
  return target;
}

async function artifactExistsAt(rootPath, relativePath, journalPath) {
  const artifactPath = await resolveRecoveryArtifactPath(rootPath, relativePath, journalPath);
  try {
    await fs.access(artifactPath);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readArtifactJsonAt(rootPath, relativePath, journalPath) {
  const artifactPath = await resolveRecoveryArtifactPath(rootPath, relativePath, journalPath);
  return readJsonIfExists(artifactPath);
}

async function removeArtifactAt(rootPath, relativePath, journalPath) {
  if (!relativePath) return;
  const artifactPath = await resolveRecoveryArtifactPath(rootPath, relativePath, journalPath);
  await fs.rm(artifactPath, { force: true });
}

async function restoreRecordArtifact(rootPath, record, fallbackPath, journalPath) {
  if (record) {
    await writeArtifact(rootPath, record);
    return;
  }
  await removeArtifactAt(rootPath, fallbackPath, journalPath);
}

async function restoreMirroredTargets(rootPath, index, mirroredTargetRefs, journalPath) {
  if (!Array.isArray(mirroredTargetRefs)) {
    return;
  }
  for (const targetRef of mirroredTargetRefs) {
    const targetRecord = index.entries[targetRef] ?? null;
    await restoreRecordArtifact(rootPath, targetRecord, targetRecord?.path ?? "", journalPath);
  }
}

function hydrateRecoveredRecord(record, artifactBody, artifactPath) {
  return {
    ...(record ?? { managed: true }),
    ...artifactBody,
    path: artifactPath,
    managed: record?.managed ?? true
  };
}

export async function recoverPendingTransactions(journalPath, indexPath, rootPath) {
  const entries = await readAll(journalPath);
  if (entries.length === 0) {
    return;
  }
  const latestByTxId = new Map(entries.map((entry) => [entry.txId, entry]));
  for (const entry of latestByTxId.values()) {
    if (entry.status === "pending") {
      assertRecoveryJournalPaths(journalPath, entry);
    }
  }
  const index = (await readIndex(indexPath)) ?? buildDefaultIndex();
  for (const entry of latestByTxId.values()) {
    if (entry.status !== "pending") {
      continue;
    }
    const ref = typeof entry.payload.ref === "string" ? entry.payload.ref : "";
    const expectedPath = typeof entry.payload.path === "string" ? entry.payload.path : "";
    const record = ref ? index.entries[ref] : null;
    const indexMatches = Boolean(record && (!expectedPath || record.path === expectedPath));
    const artifactPath = expectedPath || record?.path || "";
    const artifactExists = artifactPath ? await artifactExistsAt(rootPath, artifactPath, journalPath) : false;
    /** @type {import("./types.mjs").JournalEntry["status"]} */
    let status = "aborted";
    if (entry.op === "update" && ref) {
      const pendingRevision = revisionOf(entry.payload.revision);
      const committed = Boolean(record && pendingRevision !== null && record.revision >= pendingRevision);
      if (committed) {
        await restoreRecordArtifact(rootPath, record, expectedPath, journalPath);
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
        status = "committed";
      } else {
        // Recovery prefers rolling artifacts back to the last durable INDEX snapshot for in-place mutations.
        await restoreRecordArtifact(rootPath, record, expectedPath, journalPath);
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
      }
    } else if (entry.op === "link" && ref && typeof entry.payload.toRef === "string") {
      const toRef = entry.payload.toRef;
      const fromRecord = index.entries[ref] ?? null;
      const toRecord = index.entries[toRef] ?? null;
      const fromCommitted = Boolean(fromRecord && fromRecord.revision >= (revisionOf(entry.payload.revision) ?? Number.POSITIVE_INFINITY));
      const toCommitted = Boolean(toRecord && toRecord.revision >= (revisionOf(entry.payload.toRevision) ?? Number.POSITIVE_INFINITY));
      if (fromCommitted && toCommitted) {
        await restoreRecordArtifact(rootPath, fromRecord, expectedPath, journalPath);
        await restoreRecordArtifact(rootPath, toRecord, typeof entry.payload.toPath === "string" ? entry.payload.toPath : "", journalPath);
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
        status = "committed";
      } else {
        await restoreRecordArtifact(rootPath, fromRecord, expectedPath, journalPath);
        await restoreRecordArtifact(rootPath, toRecord, typeof entry.payload.toPath === "string" ? entry.payload.toPath : "", journalPath);
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
      }
    } else if (entry.op === "archive" && ref) {
      const pendingRevision = revisionOf(entry.payload.revision);
      const originalPath = typeof entry.payload.previousPath === "string" ? entry.payload.previousPath : record?.path ?? "";
      const archivedArtifact = expectedPath ? await readArtifactJsonAt(rootPath, expectedPath, journalPath) : null;
      const archivedRecord = archivedArtifact ? hydrateRecoveredRecord(record, archivedArtifact, expectedPath) : null;
      const committed = Boolean(record && expectedPath && record.path === expectedPath && pendingRevision !== null && record.revision >= pendingRevision);
      const recoverableArchive = Boolean(
        archivedRecord &&
          archivedRecord.id === ref &&
          archivedRecord.path === expectedPath &&
          pendingRevision !== null &&
          archivedRecord.revision >= pendingRevision
      );
      if (committed) {
        await restoreRecordArtifact(rootPath, record, expectedPath, journalPath);
        await removeArtifactAt(rootPath, originalPath && originalPath !== expectedPath ? originalPath : "", journalPath);
        status = "committed";
      } else if (recoverableArchive) {
        index.entries[ref] = archivedRecord;
        await writeIndexAtomic(indexPath, index);
        await removeArtifactAt(rootPath, originalPath && originalPath !== expectedPath ? originalPath : "", journalPath);
        status = "committed";
      } else {
        await restoreRecordArtifact(rootPath, record, originalPath, journalPath);
        await removeArtifactAt(rootPath, expectedPath, journalPath);
      }
    } else if (ref) {
      if (indexMatches && artifactExists) {
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
        status = "committed";
      } else if (!indexMatches && artifactExists) {
        await removeArtifactAt(rootPath, artifactPath, journalPath);
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
      } else if (indexMatches && !artifactExists) {
        delete index.entries[ref];
        await writeIndexAtomic(indexPath, index);
        await restoreMirroredTargets(rootPath, index, entry.payload.mirroredTargetRefs, journalPath);
      }
    } else if (
      entry.op === "register-extension-type" &&
      typeof entry.payload.name === "string" &&
      index.extensions.registeredTypes?.[entry.payload.name]
    ) {
      status = "committed";
    } else if (
      entry.op === "unregister-extension-type" &&
      typeof entry.payload.name === "string" &&
      !index.extensions.registeredTypes?.[entry.payload.name]
    ) {
      status = "committed";
    }
    /** @type {import("./types.mjs").JournalEntry} */
    const recoveredEntry = {
      ...entry,
      timestamp: nowIso(),
      status
    };
    await appendEntry(journalPath, recoveredEntry);
  }
}
