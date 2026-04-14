import fs from "node:fs/promises";
import path from "node:path";

import { readIndex, writeIndexAtomic } from "./index-file.mjs";
import { readAll } from "./journal.mjs";
import { openManagedDocStore } from "./managed-doc-store.mjs";
import { validateStore } from "./store-validation.mjs";
import { buildDefaultIndex } from "./store-models.mjs";
import { canonicalizeManagedRoots } from "./managed-roots.mjs";
import { JOURNAL_FILE, SUPPORTED_STORE_FORMAT_VERSION, ensureStoreLayout, pathExists } from "./shared.mjs";
import { buildDefaultConfig, readStoreConfig, validateStoreConfig, writeStoreConfigAtomic } from "./store-config.mjs";
import { ConfigIndexDriftError, ConfigMissingError, ConfigValidationError, DocStoreError } from "./errors.mjs";
import { detectConfigIndexDrift } from "./config-index-drift.mjs";

export const STORE_DIRNAME = ".docstore";
export const SCHEMA_VERSION_FILE = ".schema-version";

function defaultManagedRoots() {
  return ["designs", "decisions", "process", "archive"].map((root) => `.docstore/${root}`);
}

function buildBootstrapIndex() {
  return { ...buildDefaultIndex(), managedRoots: defaultManagedRoots(), entries: {}, extensions: { registeredTypes: {} } };
}

function parseListOption(value) {
  if (value === undefined) return undefined;
  if (value.trim() === "") return [];
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function parseBooleanOption(value, key) {
  if (value === undefined) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new ConfigValidationError(`${key} must be true or false`);
}

function latestJournalEntries(entries) {
  return [...new Map(entries.map((entry) => [entry.txId, entry])).values()];
}

async function readSchemaVersion(schemaPath) {
  try {
    return (await fs.readFile(schemaPath, "utf8")).trim();
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function writeSchemaVersion(schemaPath, version) {
  await fs.writeFile(schemaPath, `${version}\n`, "utf8");
}

async function ensureFreshStore(storeRoot) {
  await fs.mkdir(storeRoot, { recursive: true });
  const store = await openManagedDocStore(storeRoot);
  await store.close();
}

async function ensureRepairableStore(paths) {
  await ensureStoreLayout(paths.storeRoot);
  if (!(await pathExists(paths.indexPath))) {
    await writeIndexAtomic(paths.indexPath, buildDefaultIndex());
  }
  if (!(await pathExists(paths.journalPath))) {
    await fs.writeFile(paths.journalPath, "", "utf8");
  }
}

function buildConfigForInit(baseConfig, indexManagedRoots, options = {}, force = false) {
  const config = { ...buildDefaultConfig(), ...baseConfig };
  const explicitManagedRoots = parseListOption(options["managed-roots"]);
  const baseManagedRoots = Array.isArray(baseConfig?.managedRoots) && baseConfig.managedRoots.length > 0
    ? baseConfig.managedRoots
    : null;
  const indexedManagedRoots = Array.isArray(indexManagedRoots) && indexManagedRoots.length > 0
    ? indexManagedRoots
    : null;
  const managedRoots = canonicalizeManagedRoots(
    explicitManagedRoots ?? baseManagedRoots ?? indexedManagedRoots ?? defaultManagedRoots()
  );
  config.managedRoots = managedRoots;
  if (force || !baseConfig?.mode) {
    if (options.mode !== undefined) config.mode = options.mode;
    if (options["legacy-roots"] !== undefined) config.legacyRoots = parseListOption(options["legacy-roots"]) ?? [];
    if (options["tracked-external-paths"] !== undefined) {
      config.trackedExternalPaths = parseListOption(options["tracked-external-paths"]) ?? [];
    }
    const preferGitMove = parseBooleanOption(options["prefer-git-move"], "prefer-git-move");
    const leaveLegacyStubWhenMoved = parseBooleanOption(
      options["leave-legacy-stub-when-moved"],
      "leave-legacy-stub-when-moved"
    );
    config.adoptionPolicy = {
      ...config.adoptionPolicy,
      ...(preferGitMove === undefined ? {} : { preferGitMove }),
      ...(leaveLegacyStubWhenMoved === undefined ? {} : { leaveLegacyStubWhenMoved })
    };
  }
  const validation = validateStoreConfig(config);
  if (!validation.ok || !validation.value) {
    throw new ConfigValidationError(validation.errors.join("; "));
  }
  return validation.value;
}

async function readJsonObjectIfPossible(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch {
    return null;
  }
}

function findingFromError(source, error) {
  return {
    source,
    code: error instanceof DocStoreError ? error.code : "DOCTOR_ERROR",
    message: error instanceof Error ? error.message : String(error),
    suggestion: error instanceof DocStoreError ? error.recoverySuggestion ?? "Inspect the store metadata." : "Inspect the store metadata."
  };
}

export function resolveStorePaths(projectRoot = process.cwd()) {
  const root = path.resolve(projectRoot);
  const storeRoot = path.join(root, STORE_DIRNAME);
  return {
    projectRoot: root,
    storeRoot,
    indexPath: path.join(storeRoot, "INDEX.json"),
    configPath: path.join(storeRoot, "store.config.json"),
    journalPath: path.join(storeRoot, JOURNAL_FILE),
    schemaPath: path.join(storeRoot, SCHEMA_VERSION_FILE)
  };
}

export async function initStore(projectRoot, options = {}) {
  const paths = resolveStorePaths(projectRoot);
  const force = options.force ?? false;
  const storeExists = await pathExists(paths.storeRoot);
  if (!storeExists) {
    await ensureFreshStore(paths.storeRoot);
  } else if (force) {
    await ensureRepairableStore(paths);
  } else {
    const [hasConfig, hasIndex, hasJournal, hasSchema] = await Promise.all([
      pathExists(paths.configPath),
      pathExists(paths.indexPath),
      pathExists(paths.journalPath),
      pathExists(paths.schemaPath)
    ]);
    let configReadable = false;
    let indexReadable = false;
    if (hasConfig) {
      try {
        await readStoreConfig(paths.storeRoot);
        configReadable = true;
      } catch (error) {
        if (!(error instanceof ConfigMissingError) && !(error instanceof ConfigValidationError)) {
          throw error;
        }
      }
    }
    if (hasIndex) {
      try {
        await readIndex(paths.indexPath);
        indexReadable = true;
      } catch (error) {
        throw new DocStoreError("Existing INDEX.json is corrupt. Re-run doc-store:init --force to rebuild it.", {
          code: error instanceof DocStoreError ? error.code : "INDEX_READ_FAILED",
          context: { indexPath: paths.indexPath },
          recoverySuggestion: "Run doc-store:init --force to rebuild INDEX.json; artifact files and journal will be preserved."
        });
      }
    }
    if (hasConfig && hasIndex && hasJournal && hasSchema && configReadable && indexReadable) {
      return { ok: true, action: "doctor", doctor: await runDoctor(projectRoot) };
    }
    await ensureRepairableStore(paths);
  }

  let index;
  const warnings = [];
  if (force) {
    try {
      index = (await readIndex(paths.indexPath)) ?? buildBootstrapIndex();
    } catch {
      index = buildBootstrapIndex();
      warnings.push("init --force: rebuilding INDEX.json from bootstrap defaults; prior entries discarded");
    }
  } else {
    index = (await readIndex(paths.indexPath)) ?? buildBootstrapIndex();
  }
  const existingConfig = storeExists ? await readStoreConfig(paths.storeRoot).catch((error) => {
    if (error instanceof ConfigMissingError || error instanceof ConfigValidationError) {
      return buildDefaultConfig();
    }
    throw error;
  }) : buildDefaultConfig();
  const config = buildConfigForInit(existingConfig, index.managedRoots, options, force || !storeExists);
  const nextIndex = { ...index, managedRoots: [...config.managedRoots] };
  await writeIndexAtomic(paths.indexPath, nextIndex);
  await writeStoreConfigAtomic(paths.storeRoot, config);
  await writeSchemaVersion(paths.schemaPath, nextIndex.storeFormatVersion ?? SUPPORTED_STORE_FORMAT_VERSION);
  return { ok: true, action: storeExists ? (force ? "forced" : "repaired") : "initialized", warnings };
}

export function runDoctorOnSnapshot(config, index) {
  const report = { ok: true, findings: [] };

  if (!config) {
    report.findings.push({
      source: "config",
      code: "CONFIG_MISSING",
      message: "Staged store.config.json is missing.",
      suggestion: "Stage .docstore/store.config.json or do not delete it."
    });
  }

  if (!index) {
    report.findings.push({
      source: "index",
      code: "INDEX_MISSING",
      message: "Staged INDEX.json is missing.",
      suggestion: "Stage .docstore/INDEX.json."
    });
  }

  if (config && index) {
    const drift = detectConfigIndexDrift(config, index);
    if (!drift.ok) {
      const error = new ConfigIndexDriftError(drift.drifts);
      report.findings.push({ ...findingFromError("drift", error), drifts: drift.drifts });
    }
  }

  report.ok = report.findings.length === 0;
  return report;
}

export async function runDoctor(projectRoot) {
  const paths = resolveStorePaths(projectRoot);
  const report = { ok: true, storeRoot: paths.storeRoot, findings: [] };
  let config = null;
  let index = null;
  let rawConfig = null;
  let rawIndex = null;

  try {
    config = await readStoreConfig(paths.storeRoot);
  } catch (error) {
    report.findings.push(findingFromError("config", error));
    rawConfig = await readJsonObjectIfPossible(paths.configPath);
  }
  try {
    index = await readIndex(paths.indexPath);
    if (!index) {
      report.findings.push({
        source: "index",
        code: "INDEX_MISSING",
        message: `Store index is missing: ${paths.indexPath}`,
        suggestion: "Run doc-store:init to bootstrap INDEX.json."
      });
    }
  } catch (error) {
    report.findings.push(findingFromError("index", error));
    rawIndex = await readJsonObjectIfPossible(paths.indexPath);
  }

  const driftConfig = config ?? rawConfig;
  const driftIndex = index ?? rawIndex;
  if (driftConfig && driftIndex) {
    const drift = detectConfigIndexDrift(driftConfig, driftIndex);
    if (!drift.ok) {
      const error = new ConfigIndexDriftError(drift.drifts);
      report.findings.push({ ...findingFromError("drift", error), drifts: drift.drifts });
    }
  }

  const schemaVersion = await readSchemaVersion(paths.schemaPath);
  if (!schemaVersion) {
    report.findings.push({
      source: "schema",
      code: "SCHEMA_VERSION_MISSING",
      message: `Schema version file is missing: ${paths.schemaPath}`,
      suggestion: "Run doc-store:init to recreate .schema-version."
    });
  } else if (index && schemaVersion !== index.storeFormatVersion) {
    report.findings.push({
      source: "schema",
      code: "SCHEMA_VERSION_MISMATCH",
      message: `.schema-version (${schemaVersion}) does not match INDEX.storeFormatVersion (${index.storeFormatVersion}).`,
      suggestion: "Re-run doc-store:init --force after confirming the intended store format."
    });
  }

  if (index) {
    const validation = await validateStore(paths.storeRoot, index);
    for (const violation of validation.violations) {
      report.findings.push({
        source: "validate",
        code: violation.type,
        message: violation.message,
        suggestion: "Repair the dangling/orphaned store state before the next write."
      });
    }
  }

  try {
    const entries = await readAll(paths.journalPath);
    for (const entry of latestJournalEntries(entries)) {
      if (entry.status === "pending") {
        report.findings.push({
          source: "journal",
          code: "JOURNAL_PENDING",
          message: `Pending journal entry requires recovery review: ${entry.txId}`,
          suggestion: "Open the store through ManagedDocStore to let recovery run, then rerun doctor."
        });
      }
    }
  } catch (error) {
    report.findings.push(findingFromError("journal", error));
  }

  report.ok = report.findings.length === 0;
  return report;
}
