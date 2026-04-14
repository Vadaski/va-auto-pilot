import fs from "node:fs/promises";
import path from "node:path";

import { DocStoreError } from "./errors.mjs";
import { sha256, toStableJson } from "./shared.mjs";
import { validateStoreIndex } from "./schema.mjs";

const INDEX_CHECKSUM_FIELD = "__checksum";

function stripChecksum(index) {
  if (!index || typeof index !== "object" || Array.isArray(index)) {
    return index;
  }
  const canonical = { ...index };
  delete canonical[INDEX_CHECKSUM_FIELD];
  return canonical;
}

function serializeCanonicalIndex(index) {
  return toStableJson(stripChecksum(index));
}

/**
 * @param {string} indexPath
 * @returns {Promise<import("./types.mjs").StoreIndex | null>}
 */
export async function readIndex(indexPath) {
  let content;
  try {
    content = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }

  const parsed = JSON.parse(content);
  const expectedChecksum = typeof parsed?.[INDEX_CHECKSUM_FIELD] === "string" ? parsed[INDEX_CHECKSUM_FIELD].trim() : "";
  const canonical = stripChecksum(parsed);
  if (!expectedChecksum || sha256(serializeCanonicalIndex(canonical)) !== expectedChecksum) {
    throw new DocStoreError(`Checksum mismatch for ${indexPath}`, {
      code: "CHECKSUM_MISMATCH",
      context: { indexPath }
    });
  }
  const validation = validateStoreIndex(canonical);
  if (!validation.ok) {
    throw new DocStoreError(`Invalid index schema for ${indexPath}: ${validation.errors.join("; ")}`, {
      code: "INVALID_INDEX",
      context: { indexPath, errors: validation.errors }
    });
  }
  return canonical;
}

async function writeAtomic(filePath, content) {
  const tempPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.tmp`);
  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, filePath);
}

/**
 * @param {string} indexPath
 * @param {import("./types.mjs").StoreIndex} index
 * @returns {Promise<void>}
 */
export async function writeIndexAtomic(indexPath, index) {
  const canonical = stripChecksum(index);
  const content = toStableJson({
    ...canonical,
    [INDEX_CHECKSUM_FIELD]: sha256(serializeCanonicalIndex(canonical))
  });
  await writeAtomic(indexPath, content);
  await fs.rm(path.join(path.dirname(indexPath), ".checksum"), { force: true });
}
