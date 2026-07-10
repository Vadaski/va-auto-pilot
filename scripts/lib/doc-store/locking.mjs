import crypto from "node:crypto";
import fs from "node:fs/promises";

import { TransactionConflictError } from "./errors.mjs";
import { nowIso } from "./shared.mjs";
import { DEFAULT_GATE_TIMEOUT_MS } from "../constants.mjs";

const EMPTY_LOCK_RECOVERY_GRACE_MS = 1_000;

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

/**
 * @typedef {{
 *   stat: import("node:fs").Stats,
 *   raw: string,
 *   owner: Record<string, unknown> | null
 * }} OwnerSnapshot
 */

function isMissingFileError(error) {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function parseOwner(raw) {
  try {
    const value = JSON.parse(raw);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Read metadata and inode information through one open handle. This prevents
 * a stat/read pair from accidentally describing two different owners.
 *
 * @param {string} filePath
 * @returns {Promise<OwnerSnapshot | null>}
 */
async function readOwnerSnapshot(filePath) {
  let fd;
  try {
    fd = await fs.open(filePath, "r");
  } catch (error) {
    if (isMissingFileError(error)) {
      return null;
    }
    throw error;
  }

  try {
    const stat = await fd.stat();
    const raw = await fd.readFile("utf8");
    return { stat, raw, owner: parseOwner(raw) };
  } finally {
    await fd.close();
  }
}

function snapshotsHaveSameOwner(expected, current) {
  if (expected.stat.dev !== current.stat.dev || expected.stat.ino !== current.stat.ino) {
    return false;
  }
  const expectedToken = expected.owner?.ownerToken;
  return typeof expectedToken !== "string" || current.owner?.ownerToken === expectedToken;
}

/**
 * Remove a path only while it still names the inode and owner token that was
 * inspected. A replacement owner is never removed merely because the old
 * owner's PID is dead.
 *
 * @param {string} filePath
 * @param {OwnerSnapshot} expected
 */
async function unlinkOwnedSnapshot(filePath, expected) {
  const current = await readOwnerSnapshot(filePath);
  if (!current || !snapshotsHaveSameOwner(expected, current)) {
    return false;
  }
  try {
    await fs.unlink(filePath);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) {
      return false;
    }
    throw error;
  }
}

function pidExists(pid) {
  if (typeof pid !== "number" || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

/**
 * Publish a fully-written reaper marker atomically. Writing the marker to an
 * exclusive temporary inode first avoids treating a live reaper's brief empty
 * file initialization window as corruption.
 *
 * @param {string} reaperPath
 * @returns {Promise<OwnerSnapshot | null>}
 */
async function tryAcquireReaper(reaperPath) {
  const ownerToken = crypto.randomUUID();
  const tempPath = `${reaperPath}.${process.pid}.${ownerToken}.tmp`;
  const metadata = JSON.stringify({ pid: process.pid, acquiredAt: nowIso(), ownerToken });
  let temp;
  try {
    temp = await fs.open(tempPath, "wx");
    await temp.writeFile(metadata, "utf8");
    await temp.sync();
    await temp?.close();
  } catch (error) {
    await temp?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }

  let linkError = null;
  try {
    await fs.link(tempPath, reaperPath);
  } catch (error) {
    linkError = error;
  }
  let cleanupError = null;
  try {
    await fs.unlink(tempPath);
  } catch (error) {
    cleanupError = isMissingFileError(error) ? null : error;
  }
  if (linkError) {
    if (typeof linkError !== "object" || !("code" in linkError) || linkError.code !== "EEXIST") {
      throw linkError;
    }
    return null;
  }
  if (cleanupError) {
    throw cleanupError;
  }

  const snapshot = await readOwnerSnapshot(reaperPath);
  return snapshot?.owner?.ownerToken === ownerToken ? snapshot : null;
}

/**
 * Recover a marker left by a crashed reaper. The inode/token comparison keeps
 * a concurrently-created replacement marker intact.
 *
 * @param {string} reaperPath
 * @returns {Promise<boolean>} true when no live reaper marker remains
 */
async function recoverStaleReaper(reaperPath) {
  const snapshot = await readOwnerSnapshot(reaperPath);
  if (!snapshot) {
    return true;
  }
  if (pidExists(snapshot.owner?.pid)) {
    return false;
  }
  await unlinkOwnedSnapshot(reaperPath, snapshot);
  return (await readOwnerSnapshot(reaperPath)) === null;
}

async function reapStaleLock(lockPath) {
  const reaperPath = `${lockPath}.reap`;
  const reaper = await tryAcquireReaper(reaperPath);
  if (!reaper) {
    return false;
  }

  try {
    const lock = await readOwnerSnapshot(lockPath);
    if (!lock || pidExists(lock.owner?.pid)) {
      return false;
    }
    if (!lock.raw.trim() && Date.now() - lock.stat.mtimeMs < EMPTY_LOCK_RECOVERY_GRACE_MS) {
      return false;
    }
    return unlinkOwnedSnapshot(lockPath, lock);
  } finally {
    await unlinkOwnedSnapshot(reaperPath, reaper);
  }
}

async function tryAcquireLockFile(lockPath) {
  const ownerToken = crypto.randomUUID();
  const tempPath = `${lockPath}.${process.pid}.${ownerToken}.tmp`;
  const metadata = JSON.stringify({ pid: process.pid, acquiredAt: nowIso(), ownerToken });
  let temp;
  try {
    temp = await fs.open(tempPath, "wx");
    await temp.writeFile(metadata, "utf8");
    await temp.sync();
    await temp.close();
  } catch (error) {
    await temp?.close().catch(() => {});
    await fs.unlink(tempPath).catch(() => {});
    throw error;
  }

  try {
    await fs.link(tempPath, lockPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => {});
    if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
      return null;
    }
    throw error;
  }
  await fs.unlink(tempPath).catch(() => {});

  const fd = await fs.open(lockPath, "r");
  const raw = await fd.readFile("utf8");
  const owner = parseOwner(raw);
  if (owner?.ownerToken !== ownerToken) {
    await fd.close();
    return null;
  }
  return { path: lockPath, fd, ownerToken };
}

/**
 * @param {string} lockPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ path: string, fd: import('node:fs/promises').FileHandle, ownerToken: string }>}
 */
export async function acquireLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const startedAt = Date.now();
  let delayMs = 25;

  while (Date.now() - startedAt <= timeoutMs) {
    if (!(await recoverStaleReaper(`${lockPath}.reap`))) {
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 500);
      continue;
    }
    try {
      const acquired = await tryAcquireLockFile(lockPath);
      if (acquired) {
        return acquired;
      }
      throw Object.assign(new Error(`lock exists: ${lockPath}`), { code: "EEXIST" });
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      try {
        const lock = await readOwnerSnapshot(lockPath);
        if (!lock) {
          continue;
        }
        if (!lock.raw.trim()) {
          await reapStaleLock(lockPath);
          continue;
        }
        if (!lock.owner) {
          await reapStaleLock(lockPath);
          continue;
        }
        if (!pidExists(lock.owner.pid)) {
          await reapStaleLock(lockPath);
          continue;
        }
      } catch (readError) {
        if (readError && typeof readError === "object" && "code" in readError && readError.code === "ENOENT") {
          continue;
        }
        throw readError;
      }
      await sleep(delayMs);
      delayMs = Math.min(delayMs * 2, 500);
    }
  }

  throw new TransactionConflictError(lockPath, timeoutMs);
}

/**
 * @param {{ path: string, fd: import('node:fs/promises').FileHandle, ownerToken?: string }} lockHandle
 * @returns {Promise<void>}
 */
export async function releaseLock(lockHandle) {
  const heldStat = await lockHandle.fd.stat();
  await lockHandle.fd.close();
  await unlinkOwnedSnapshot(lockHandle.path, {
    stat: heldStat,
    raw: "",
    owner: lockHandle.ownerToken ? { ownerToken: lockHandle.ownerToken } : null,
  });
}
