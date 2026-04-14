import fs from "node:fs/promises";
import path from "node:path";

import { buildArtifactPath, toStableJson } from "./shared.mjs";

function artifactBodyFromRecord(record) {
  return {
    id: record.id,
    kind: record.kind,
    subtype: record.subtype,
    refs: record.refs,
    inboundRefs: record.inboundRefs ?? [],
    revision: record.revision,
    storeFormatVersion: record.storeFormatVersion,
    artifactSchemaVersion: record.artifactSchemaVersion,
    archived: record.archived ?? false,
    frontmatter: record.frontmatter,
    extensions: record.extensions
  };
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
 * @param {string} rootPath
 * @param {import("./types.mjs").DocumentRecord} record
 * @returns {string}
 */
export function resolveArtifactPath(rootPath, record) {
  return path.join(rootPath, record.path);
}

/**
 * @param {string} rootPath
 * @param {import("./types.mjs").DocumentRecord} record
 * @returns {Promise<void>}
 */
export async function writeArtifact(rootPath, record) {
  await writeAtomic(resolveArtifactPath(rootPath, record), toStableJson(artifactBodyFromRecord(record)));
}

/**
 * @param {string} rootPath
 * @param {import("./types.mjs").DocumentRecord} record
 * @returns {Promise<void>}
 */
export async function removeArtifact(rootPath, record) {
  await fs.rm(resolveArtifactPath(rootPath, record), { force: true });
}

/**
 * @param {string} rootPath
 * @param {string} kind
 * @param {string} slug
 * @param {boolean} [archived]
 * @returns {Promise<string | null>}
 */
export async function readArtifactBackup(rootPath, kind, slug, archived = false) {
  const targetPath = path.join(rootPath, buildArtifactPath(kind, slug, archived));
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

/**
 * @param {string} rootPath
 * @returns {Promise<string[]>}
 */
export async function listArtifactFiles(rootPath) {
  const folders = ["designs", "decisions", "process", "archive"];
  const files = [];
  for (const folder of folders) {
    const absoluteFolder = path.join(rootPath, folder);
    /** @type {import("node:fs").Dirent[]} */
    let entries;
    try {
      entries = await fs.readdir(absoluteFolder, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".json")) {
        files.push(path.join(folder, entry.name));
      }
    }
  }
  return files;
}
