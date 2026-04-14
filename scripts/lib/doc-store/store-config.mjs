import fs from "node:fs/promises";
import path from "node:path";

import { ConfigMissingError, ConfigValidationError, InvalidStoreRootError } from "./errors.mjs";
import { canonicalizeManagedRoots, findNonCanonicalManagedRoots } from "./managed-roots.mjs";
import { isPlainObject, toStableJson } from "./shared.mjs";

/**
 * @typedef {{
 *   mode: 'legacy' | 'mixed' | 'managed',
 *   managedRoots: string[],
 *   legacyRoots: string[],
 *   trackedExternalPaths: string[],
 *   adoptionPolicy: {
 *     preferGitMove: boolean,
 *     leaveLegacyStubWhenMoved: boolean
 *   }
 * }} StoreConfig
 */

const CONFIG_FILE = "store.config.json";
const MODES = new Set(["legacy", "mixed", "managed"]);

export function buildDefaultConfig() {
  return {
    mode: "legacy",
    managedRoots: [],
    legacyRoots: [],
    trackedExternalPaths: [],
    adoptionPolicy: {
      preferGitMove: true,
      leaveLegacyStubWhenMoved: true
    }
  };
}

function validateStringArray(value, field, errors) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    errors.push(`${field} must be an array of strings`);
  }
}

export function validateStoreConfig(input) {
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["store config must be an object"], value: null };
  }
  const defaults = buildDefaultConfig();
  const config = { ...input };
  const errors = [];

  if (config.mode === undefined) {
    config.mode = defaults.mode;
  } else if (!MODES.has(config.mode)) {
    errors.push("mode must be legacy, mixed, or managed");
  }

  for (const field of ["managedRoots", "legacyRoots", "trackedExternalPaths"]) {
    if (config[field] === undefined) {
      config[field] = [...defaults[field]];
      continue;
    }
    validateStringArray(config[field], field, errors);
  }

  if (Array.isArray(config.managedRoots)) {
    const nonCanonicalManagedRoots = findNonCanonicalManagedRoots(config.managedRoots);
    if (nonCanonicalManagedRoots.length > 0) {
      errors.push(
        `managedRoots must use canonical repo-relative paths (${nonCanonicalManagedRoots.join(", ")})`
      );
    } else {
      config.managedRoots = canonicalizeManagedRoots(config.managedRoots);
    }
  }

  const rawPolicy = config.adoptionPolicy ?? {};
  if (!isPlainObject(rawPolicy)) {
    errors.push("adoptionPolicy must be an object");
  } else {
    config.adoptionPolicy = {
      ...rawPolicy,
      preferGitMove: rawPolicy.preferGitMove ?? defaults.adoptionPolicy.preferGitMove,
      leaveLegacyStubWhenMoved:
        rawPolicy.leaveLegacyStubWhenMoved ?? defaults.adoptionPolicy.leaveLegacyStubWhenMoved
    };
    if (typeof config.adoptionPolicy.preferGitMove !== "boolean") {
      errors.push("adoptionPolicy.preferGitMove must be a boolean");
    }
    if (typeof config.adoptionPolicy.leaveLegacyStubWhenMoved !== "boolean") {
      errors.push("adoptionPolicy.leaveLegacyStubWhenMoved must be a boolean");
    }
  }

  return { ok: errors.length === 0, errors, value: errors.length === 0 ? config : null };
}

function configPathFor(rootPath) {
  if (!path.isAbsolute(rootPath)) {
    throw new InvalidStoreRootError(rootPath, "Store root must be absolute.");
  }
  return path.join(rootPath, CONFIG_FILE);
}

export async function readStoreConfig(rootPath) {
  const configPath = configPathFor(rootPath);
  let content;
  try {
    content = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error) {
      if (error.code === "ENOENT") {
        throw new ConfigMissingError(configPath);
      }
      if (error.code === "ENOTDIR") {
        throw new InvalidStoreRootError(rootPath, "Store root does not exist.");
      }
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new ConfigValidationError("JSON parse failed", { configPath, cause: error instanceof Error ? error.message : String(error) });
  }
  const validation = validateStoreConfig(parsed);
  if (!validation.ok || !validation.value) {
    throw new ConfigValidationError(validation.errors.join("; "), { configPath });
  }
  return /** @type {StoreConfig} */ (validation.value);
}

export async function writeStoreConfigAtomic(rootPath, config) {
  const configPath = configPathFor(rootPath);
  const validation = validateStoreConfig(config);
  if (!validation.ok || !validation.value) {
    throw new ConfigValidationError(validation.errors.join("; "), { configPath });
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const tempPath = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`);
  const handle = await fs.open(tempPath, "w");
  try {
    await handle.writeFile(toStableJson(validation.value), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tempPath, configPath);
}
