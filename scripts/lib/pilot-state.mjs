import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import { acquireLock, releaseLock } from "./doc-store/locking.mjs";

function resolveLockPath(filePath) {
  return `${path.resolve(filePath)}.lock`;
}

export async function withPilotFileLock(filePath, work, options = {}) {
  const lock = await acquireLock(resolveLockPath(filePath), options);
  try {
    return await work();
  } finally {
    await releaseLock(lock);
  }
}

export function writeTextFileAtomicSync(filePath, content) {
  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const tempPath = `${resolved}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  fs.writeFileSync(tempPath, content, "utf8");
  fs.renameSync(tempPath, resolved);
}

export function writeJsonFileAtomicSync(filePath, value) {
  writeTextFileAtomicSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function fsyncDirectorySync(dirPath) {
  let fd;
  try {
    fd = fs.openSync(dirPath, "r");
    fs.fsyncSync(fd);
  } catch (error) {
    // Directory fsync is unavailable on some supported Windows/filesystem
    // combinations. Ignore only capability/permission errors; real I/O errors
    // must remain visible to the caller.
    if (!new Set(["EACCES", "EINVAL", "EISDIR", "ENOTSUP", "EPERM"]).has(error?.code)) {
      throw error;
    }
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Write + fsync + rename + directory fsync for crash-recovery metadata. */
export function writeJsonFileDurableAtomicSync(filePath, value) {
  const resolved = path.resolve(filePath);
  const dir = path.dirname(resolved);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${resolved}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  let fd;
  try {
    fd = fs.openSync(tempPath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tempPath, resolved);
    fsyncDirectorySync(dir);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fs.rmSync(tempPath, { force: true });
    throw error;
  }
}

/** Remove a durable intent only after syncing its parent directory. */
export function removeFileDurableSync(filePath) {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return false;
  fs.unlinkSync(resolved);
  fsyncDirectorySync(path.dirname(resolved));
  return true;
}
