import fs from "node:fs/promises";

import { TransactionConflictError } from "./errors.mjs";
import { nowIso } from "./shared.mjs";
import { DEFAULT_GATE_TIMEOUT_MS } from "../constants.mjs";

function sleep(durationMs) {
  return new Promise((resolve) => setTimeout(resolve, durationMs));
}

async function unlinkIfPresent(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error) || error.code !== "ENOENT") {
      throw error;
    }
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
 * @param {string} lockPath
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ path: string, fd: import('node:fs/promises').FileHandle }>}
 */
export async function acquireLock(lockPath, options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
  const startedAt = Date.now();
  let delayMs = 25;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const fd = await fs.open(lockPath, "wx");
      await fd.writeFile(JSON.stringify({ pid: process.pid, acquiredAt: nowIso() }), "utf8");
      await fd.sync();
      return { path: lockPath, fd };
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error) || error.code !== "EEXIST") {
        throw error;
      }
      try {
        const raw = await fs.readFile(lockPath, "utf8");
        if (!raw.trim()) {
          await sleep(delayMs);
          delayMs = Math.min(delayMs * 2, 500);
          continue;
        }
        let current;
        try {
          current = JSON.parse(raw);
        } catch {
          await unlinkIfPresent(lockPath);
          continue;
        }
        if (!pidExists(current.pid)) {
          await unlinkIfPresent(lockPath);
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
 * @param {{ path: string, fd: import('node:fs/promises').FileHandle }} lockHandle
 * @returns {Promise<void>}
 */
export async function releaseLock(lockHandle) {
  await lockHandle.fd.close();
  try {
    await fs.unlink(lockHandle.path);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }
}
