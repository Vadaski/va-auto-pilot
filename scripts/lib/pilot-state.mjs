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
