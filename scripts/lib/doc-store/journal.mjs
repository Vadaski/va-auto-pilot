import fs from "node:fs/promises";

import { JournalCorruptError } from "./errors.mjs";
import { nowIso } from "./shared.mjs";
import { validateJournalEntry } from "./schema.mjs";

/**
 * @param {string} journalPath
 * @param {import("./types.mjs").JournalEntry} entry
 * @returns {Promise<void>}
 */
export async function appendEntry(journalPath, entry) {
  const validation = validateJournalEntry(entry);
  if (!validation.ok) {
    throw new JournalCorruptError(journalPath, validation.errors.join("; "));
  }
  const handle = await fs.open(journalPath, "a");
  try {
    await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * @param {string} journalPath
 * @returns {Promise<import("./types.mjs").JournalEntry[]>}
 */
export async function readAll(journalPath) {
  let content;
  try {
    content = await fs.readFile(journalPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  /** @type {import("./types.mjs").JournalEntry[]} */
  const entries = [];
  const lines = content.split("\n");
  const lastLineIndex = lines.length - 1;
  for (const [index, line] of lines.entries()) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed = JSON.parse(line);
      const validation = validateJournalEntry(parsed);
      if (!validation.ok) {
        throw new JournalCorruptError(journalPath, validation.errors.join("; "));
      }
      entries.push(parsed);
    } catch (error) {
      const isTruncatedTail = index === lastLineIndex && !content.endsWith("\n");
      if (isTruncatedTail) {
        break;
      }
      if (error instanceof JournalCorruptError) {
        throw error;
      }
      throw new JournalCorruptError(journalPath, "Failed to parse NDJSON entry");
    }
  }
  return entries;
}

/**
 * @param {string} journalPath
 * @param {'abort-pending' | 'commit-pending'} policy
 * @returns {Promise<import("./types.mjs").JournalEntry[]>}
 */
export async function replay(journalPath, policy) {
  const entries = await readAll(journalPath);
  const latestByTxId = new Map(entries.map((entry) => [entry.txId, entry]));
  const recovered = [];
  for (const entry of latestByTxId.values()) {
    if (entry.status !== "pending") {
      continue;
    }
    /** @type {import("./types.mjs").JournalEntry} */
    const recoveredEntry = {
      ...entry,
      timestamp: nowIso(),
      status: policy === "commit-pending" ? "committed" : "aborted"
    };
    await appendEntry(journalPath, recoveredEntry);
    recovered.push(recoveredEntry);
  }
  return /** @type {import("./types.mjs").JournalEntry[]} */ (recovered);
}
