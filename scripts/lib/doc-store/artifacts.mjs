import fs from "node:fs/promises";
import path from "node:path";

import { buildArtifactPath, toStableJson } from "./shared.mjs";
import { InvalidInputError } from "./errors.mjs";

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
  const root = path.resolve(rootPath);
  if (path.isAbsolute(record.path)) {
    throw new InvalidInputError(`artifact path must be relative: ${record.path}`);
  }
  const target = path.resolve(root, record.path);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new InvalidInputError(`artifact path escapes the store root: ${record.path}`);
  }
  const expected = buildArtifactPath(record.kind, record.frontmatter?.slug, record.archived === true);
  if (record.path !== expected) {
    throw new InvalidInputError(`artifact path is not canonical: expected ${expected}, got ${record.path}`);
  }
  return target;
}

export async function assertSafeArtifactParent(rootPath, targetPath) {
  const root = path.resolve(rootPath);
  const parent = path.dirname(path.resolve(targetPath));
  const relative = path.relative(root, parent);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let current = root;
  for (const segment of ["", ...segments]) {
    if (segment) current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new InvalidInputError(`artifact parent must not be a symbolic link: ${current}`);
      }
      if (!stat.isDirectory()) {
        throw new InvalidInputError(`artifact parent must be a directory: ${current}`);
      }
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
  }
}

/**
 * @param {string} rootPath
 * @param {import("./types.mjs").DocumentRecord} record
 * @returns {Promise<void>}
 */
export async function writeArtifact(rootPath, record) {
  const artifactPath = resolveArtifactPath(rootPath, record);
  await assertSafeArtifactParent(rootPath, artifactPath);
  await writeAtomic(artifactPath, toStableJson(artifactBodyFromRecord(record)));
}

/**
 * @param {string} rootPath
 * @param {import("./types.mjs").DocumentRecord} record
 * @returns {Promise<void>}
 */
export async function removeArtifact(rootPath, record) {
  const artifactPath = resolveArtifactPath(rootPath, record);
  await assertSafeArtifactParent(rootPath, artifactPath);
  await fs.rm(artifactPath, { force: true });
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
