import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export const SUPPORTED_STORE_FORMAT_VERSION = "1.0.0";
export const DOCUMENT_KINDS = ["design", "decision", "process"];
export const JOURNAL_FILE = ".journal/current.jsonl";
export const KIND_DIRECTORIES = {
  design: "designs",
  decision: "decisions",
  process: "process",
  archive: "archive"
};

const SAFE_ARTIFACT_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function nowIso() {
  return new Date().toISOString();
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export function checksumPathFor(filePath) {
  return path.join(path.dirname(filePath), ".checksum");
}

export function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

export function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

export function sortKeysDeep(value) {
  if (Array.isArray(value)) {
    return value.map((item) => sortKeysDeep(item));
  }
  if (!isPlainObject(value)) {
    return value;
  }
  return Object.keys(value)
    .sort()
    .reduce((result, key) => {
      result[key] = sortKeysDeep(value[key]);
      return result;
    }, {});
}

export function toStableJson(value) {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}

export function majorVersion(version) {
  const raw = String(version ?? "").split("@").pop() ?? "";
  const major = Number.parseInt(raw.split(".")[0] ?? "", 10);
  return Number.isNaN(major) ? null : major;
}

export function directoryForKind(kind, archived = false) {
  if (archived) {
    return KIND_DIRECTORIES.archive;
  }
  return KIND_DIRECTORIES[kind];
}

export function slugify(value) {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || `doc-${crypto.randomUUID().slice(0, 8)}`;
}

export function buildDocumentId(kind, slug) {
  return `${kind}:${slug}`;
}

/**
 * Artifact slugs are persisted as filenames, so accepting path syntax here
 * would turn an otherwise canonical-looking record into a path traversal.
 * Generated slugs already use this alphabet via slugify().
 *
 * @param {unknown} slug
 * @returns {slug is string}
 */
export function isSafeArtifactSlug(slug) {
  return typeof slug === "string" && SAFE_ARTIFACT_SLUG.test(slug);
}

export function buildArtifactPath(kind, slug, archived = false) {
  if (!DOCUMENT_KINDS.includes(kind)) {
    throw new TypeError(`unsupported document kind: ${kind}`);
  }
  if (!isSafeArtifactSlug(slug)) {
    throw new TypeError(`artifact slug is not path-safe: ${String(slug)}`);
  }
  // Archived filenames now include kind to avoid cross-kind slug collisions. No migration is needed yet because there is no existing archived data.
  return path.join(directoryForKind(kind, archived), `${archived ? `${kind}__` : ""}${slug}.json`);
}

export async function ensureStoreLayout(rootPath) {
  const directories = [
    rootPath,
    path.join(rootPath, ".journal"),
    path.join(rootPath, KIND_DIRECTORIES.design),
    path.join(rootPath, KIND_DIRECTORIES.decision),
    path.join(rootPath, KIND_DIRECTORIES.process),
    path.join(rootPath, KIND_DIRECTORIES.archive)
  ];
  await Promise.all(directories.map((directory) => fs.mkdir(directory, { recursive: true })));
}

export async function readJsonIfExists(filePath) {
  try {
    const content = await fs.readFile(filePath, "utf8");
    return JSON.parse(content);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}
