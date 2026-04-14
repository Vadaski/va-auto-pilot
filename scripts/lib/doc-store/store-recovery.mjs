import fs from "node:fs/promises";
import path from "node:path";

import { appendEntry, readAll } from "./journal.mjs";
import { writeArtifact } from "./artifacts.mjs";
import { readIndex, writeIndexAtomic } from "./index-file.mjs";
import { buildDefaultIndex } from "./store-models.mjs";
import { nowIso, pathExists, readJsonIfExists } from "./shared.mjs";

function revisionOf(value) {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

async function removeArtifactAt(rootPath, relativePath) {
  if (!relativePath) return;
  await fs.rm(path.join(rootPath, relativePath), { force: true });
}

async function restoreRecordArtifact(rootPath, record, fallbackPath = "") {
  if (record) {
    await writeArtifact(rootPath, record);
    return;
  }
  await removeArtifactAt(rootPath, fallbackPath);
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
    const artifactExists = artifactPath ? await pathExists(path.join(rootPath, artifactPath)) : false;
    /** @type {import("./types.mjs").JournalEntry["status"]} */
    let status = "aborted";
    if (entry.op === "update" && ref) {
      const pendingRevision = revisionOf(entry.payload.revision);
      const committed = Boolean(record && pendingRevision !== null && record.revision >= pendingRevision);
      if (committed) {
        await restoreRecordArtifact(rootPath, record, expectedPath);
        status = "committed";
      } else {
        // Recovery prefers rolling artifacts back to the last durable INDEX snapshot for in-place mutations.
        await restoreRecordArtifact(rootPath, record, expectedPath);
      }
    } else if (entry.op === "link" && ref && typeof entry.payload.toRef === "string") {
      const toRef = entry.payload.toRef;
      const fromRecord = index.entries[ref] ?? null;
      const toRecord = index.entries[toRef] ?? null;
      const fromCommitted = Boolean(fromRecord && fromRecord.revision >= (revisionOf(entry.payload.revision) ?? Number.POSITIVE_INFINITY));
      const toCommitted = Boolean(toRecord && toRecord.revision >= (revisionOf(entry.payload.toRevision) ?? Number.POSITIVE_INFINITY));
      if (fromCommitted && toCommitted) {
        await restoreRecordArtifact(rootPath, fromRecord, expectedPath);
        await restoreRecordArtifact(rootPath, toRecord, typeof entry.payload.toPath === "string" ? entry.payload.toPath : "");
        status = "committed";
      } else {
        await restoreRecordArtifact(rootPath, fromRecord, expectedPath);
        await restoreRecordArtifact(rootPath, toRecord, typeof entry.payload.toPath === "string" ? entry.payload.toPath : "");
      }
    } else if (entry.op === "archive" && ref) {
      const pendingRevision = revisionOf(entry.payload.revision);
      const originalPath = typeof entry.payload.previousPath === "string" ? entry.payload.previousPath : record?.path ?? "";
      const archivedArtifact = expectedPath ? await readJsonIfExists(path.join(rootPath, expectedPath)) : null;
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
        await restoreRecordArtifact(rootPath, record, expectedPath);
        await removeArtifactAt(rootPath, originalPath && originalPath !== expectedPath ? originalPath : "");
        status = "committed";
      } else if (recoverableArchive) {
        index.entries[ref] = archivedRecord;
        await writeIndexAtomic(indexPath, index);
        await removeArtifactAt(rootPath, originalPath && originalPath !== expectedPath ? originalPath : "");
        status = "committed";
      } else {
        await restoreRecordArtifact(rootPath, record, originalPath);
        await removeArtifactAt(rootPath, expectedPath);
      }
    } else if (ref) {
      if (indexMatches && artifactExists) {
        status = "committed";
      } else if (!indexMatches && artifactExists) {
        await removeArtifactAt(rootPath, artifactPath);
      } else if (indexMatches && !artifactExists) {
        delete index.entries[ref];
        await writeIndexAtomic(indexPath, index);
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
