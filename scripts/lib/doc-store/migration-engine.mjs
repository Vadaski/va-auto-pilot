import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";


import { readIndex, writeIndexAtomic } from "./index-file.mjs";
import { appendEntry, readAll } from "./journal.mjs";
import { acquireLock, releaseLock } from "./locking.mjs";
import { readSchemaVersion, writeSchemaVersion, SCHEMA_VERSION_FILE } from "./lifecycle.mjs";
import { cloneValue, nowIso, pathExists, SUPPORTED_STORE_FORMAT_VERSION } from "./shared.mjs";

const MIGRATION_REGISTRY = new Map();

/**
 * @typedef {{
 *   storeFormatVersion: string,
 *   targetStoreFormatVersion: string,
 *   index: import("./types.mjs").StoreIndex,
 *   artifacts: Map<string, import("./types.mjs").DocumentRecord>,
 *   journal: import("./types.mjs").JournalEntry[],
 *   extensions: Record<string, unknown>,
 *   refMap: Map<string, string>,
 *   writeFile: (filePath: string, content: string | Uint8Array) => Promise<void>,
 *   moveFile: (from: string, to: string) => Promise<void>,
 *   rewriteRefs: (mapper: (ref: string) => string | undefined) => Promise<void>
 * }} MigrationContext
 *
 * @typedef {{
 *   status: "applied" | "skipped",
 *   details?: string,
 *   warning?: string
 * }} MigrationStepResult
 *
 * @param {string} fromVersion
 * @param {string} toVersion
 * @param {(ctx: MigrationContext) => Promise<MigrationStepResult[]>} migrator
 */
export function registerMigration(fromVersion, toVersion, migrator) {
  const key = `${fromVersion}→${toVersion}`;
  MIGRATION_REGISTRY.set(key, { fromVersion, toVersion, migrator });
}

function migrationKey(fromVersion, toVersion) {
  return `${fromVersion}→${toVersion}`;
}

function findMigrationPath(fromVersion, toVersion) {
  if (fromVersion === toVersion) {
    return [];
  }
  const direct = MIGRATION_REGISTRY.get(migrationKey(fromVersion, toVersion));
  if (direct) {
    return [direct];
  }
  return null;
}

async function ensureBackupDirectory(storeRoot) {
  const backupDir = path.join(storeRoot, "backups", "snapshots");
  await fs.mkdir(backupDir, { recursive: true });
  return backupDir;
}

async function createLightweightSnapshot(storeRoot, migrationId, index) {
  const backupDir = await ensureBackupDirectory(storeRoot);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const snapshotDir = path.join(backupDir, `${timestamp}_${migrationId}`);
  await fs.mkdir(snapshotDir, { recursive: true });

  const indexPath = path.join(storeRoot, "INDEX.json");
  await fs.copyFile(indexPath, path.join(snapshotDir, "INDEX.json"));

  const artifactBackups = [];
  for (const record of Object.values(index.entries ?? {})) {
    if (!record.managed || record.archived) continue;
    const artifactPath = path.join(storeRoot, record.path);
    if (await pathExists(artifactPath)) {
      const destDir = path.join(snapshotDir, path.dirname(record.path));
      await fs.mkdir(destDir, { recursive: true });
      const destPath = path.join(snapshotDir, record.path);
      await fs.copyFile(artifactPath, destPath);
      artifactBackups.push(record.path);
    }
  }

  const journalPath = path.join(storeRoot, ".journal", "current.jsonl");
  if (await pathExists(journalPath)) {
    await fs.copyFile(journalPath, path.join(snapshotDir, "current.jsonl"));
  }

  const configPath = path.join(storeRoot, "store.config.json");
  if (await pathExists(configPath)) {
    await fs.copyFile(configPath, path.join(snapshotDir, "store.config.json"));
  }

  const schemaPath = path.join(storeRoot, SCHEMA_VERSION_FILE);
  if (await pathExists(schemaPath)) {
    await fs.copyFile(schemaPath, path.join(snapshotDir, SCHEMA_VERSION_FILE));
  }

  return { snapshotDir, artifactBackups };
}

async function restoreSnapshot(snapshotDir, storeRoot) {
  const indexBackup = path.join(snapshotDir, "INDEX.json");
  if (await pathExists(indexBackup)) {
    await fs.copyFile(indexBackup, path.join(storeRoot, "INDEX.json"));
  }

  const journalBackup = path.join(snapshotDir, "current.jsonl");
  const journalPath = path.join(storeRoot, ".journal", "current.jsonl");
  if (await pathExists(journalBackup)) {
    await fs.copyFile(journalBackup, journalPath);
  }

  const configBackup = path.join(snapshotDir, "store.config.json");
  const configPath = path.join(storeRoot, "store.config.json");
  if (await pathExists(configBackup)) {
    await fs.copyFile(configBackup, configPath);
  }

  const schemaBackup = path.join(snapshotDir, SCHEMA_VERSION_FILE);
  const schemaPath = path.join(storeRoot, SCHEMA_VERSION_FILE);
  if (await pathExists(schemaBackup)) {
    await fs.copyFile(schemaBackup, schemaPath);
  }

  const backupEntries = await fs.readdir(snapshotDir, { withFileTypes: true }).catch(() => []);
  for (const entry of backupEntries) {
    if (entry.isDirectory() && ["designs", "decisions", "process", "archive"].includes(entry.name)) {
      const srcDir = path.join(snapshotDir, entry.name);
      const destDir = path.join(storeRoot, entry.name);
      const files = await fs.readdir(srcDir, { recursive: true });
      for (const relativePath of files) {
        const srcPath = path.join(srcDir, relativePath);
        const stat = await fs.stat(srcPath);
        if (stat.isFile()) {
          await fs.copyFile(srcPath, path.join(destDir, relativePath));
        }
      }
    }
  }
}

async function runPreflight(storeRoot, index, fromVersion, toVersion) {
  const findings = [];

  if (!index) {
    findings.push({ phase: "preflight", code: "INDEX_MISSING", message: "INDEX.json is missing or unreadable." });
    return { ok: false, findings };
  }

  const currentVersion = index.storeFormatVersion ?? "1.0.0";
  if (currentVersion !== fromVersion) {
    findings.push({
      phase: "preflight",
      code: "VERSION_MISMATCH",
      message: `Current store format version is ${currentVersion}, expected ${fromVersion}.`
    });
  }

  const migrationPath = findMigrationPath(fromVersion, toVersion);
  if (migrationPath === null) {
    findings.push({
      phase: "preflight",
      code: "NO_MIGRATION_PATH",
      message: `No registered migration from ${fromVersion} to ${toVersion}.`
    });
  }

  const lockPath = path.join(storeRoot, ".lock");
  try {
    const raw = await fs.readFile(lockPath, "utf8");
    const lockInfo = JSON.parse(raw);
    if (typeof lockInfo.pid === "number" && lockInfo.pid > 0) {
      try {
        process.kill(lockInfo.pid, 0);
        findings.push({ phase: "preflight", code: "STORE_LOCKED", message: "Store is locked by another process." });
      } catch {
        // stale lock file; process is dead
      }
    }
  } catch (error) {
    // ENOENT or invalid lock file means not locked
    if (error && typeof error === "object" && "code" in error && error.code !== "ENOENT") {
      findings.push({ phase: "preflight", code: "LOCK_ERROR", message: error instanceof Error ? error.message : String(error) });
    }
  }

  const indexPath = path.join(storeRoot, "INDEX.json");
  try {
    const stats = await fs.stat(indexPath);
    findings.push({ phase: "preflight", code: "DISK_CHECK", message: `INDEX size: ${stats.size} bytes` });
  } catch {
    findings.push({ phase: "preflight", code: "INDEX_UNREADABLE", message: "Cannot stat INDEX.json." });
  }

  const ok = !findings.some((f) => f.code !== "DISK_CHECK");
  return { ok, findings, migrationPath: ok ? migrationPath : null };
}

/**
 * @param {string} storeRoot
 * @param {import("./types.mjs").StoreIndex} index
 * @param {import("./types.mjs").JournalEntry[]} journal
 * @param {string} fromVersion
 * @param {string} toVersion
 */
function buildMigrationContext(storeRoot, index, journal, fromVersion, toVersion) {
  const artifacts = new Map();
  for (const [id, record] of Object.entries(index.entries ?? {})) {
    artifacts.set(id, cloneValue(record));
  }
  const refMap = new Map();
  for (const relation of index.relations ?? []) {
    refMap.set(`${relation.from}\u2192${relation.to}`, relation.relation);
  }

  return {
    storeFormatVersion: fromVersion,
    targetStoreFormatVersion: toVersion,
    index: cloneValue(index),
    artifacts,
    journal: cloneValue(journal),
    extensions: cloneValue(index.extensions ?? {}),
    refMap,
    async writeFile(filePath, content) {
      const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(storeRoot, filePath);
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      const tempPath = `${absolutePath}.${process.pid}.tmp`;
      await fs.writeFile(tempPath, content, typeof content === "string" ? "utf8" : undefined);
      await fs.rename(tempPath, absolutePath);
    },
    async moveFile(from, to) {
      const fromAbsolute = path.isAbsolute(from) ? from : path.join(storeRoot, from);
      const toAbsolute = path.isAbsolute(to) ? to : path.join(storeRoot, to);
      await fs.mkdir(path.dirname(toAbsolute), { recursive: true });
      await fs.rename(fromAbsolute, toAbsolute);
    },
    async rewriteRefs(mapper) {
      for (const record of artifacts.values()) {
        for (const ref of record.refs ?? []) {
          ref.to = mapper(ref.to) ?? ref.to;
        }
        for (const inbound of record.inboundRefs ?? []) {
          inbound.to = mapper(inbound.to) ?? inbound.to;
        }
      }
    }
  };
}

async function runApply(storeRoot, index, journal, migrationPath, migrationId) {
  const snapshot = await createLightweightSnapshot(storeRoot, migrationId, index);
  let nextIndex = cloneValue(index);
  const applied = [];
  const warnings = [];

  try {
    for (const step of migrationPath) {
      const ctx = buildMigrationContext(storeRoot, nextIndex, journal, step.fromVersion, step.toVersion);
      const stepResults = await step.migrator(ctx);
      nextIndex = { ...ctx.index, storeFormatVersion: step.toVersion };
      for (const result of stepResults) {
        applied.push({ step: `${step.fromVersion}→${step.toVersion}`, status: result.status, details: result.details });
        if (result.warning) warnings.push(result.warning);
      }
    }
    return { ok: true, nextIndex, applied, warnings, snapshot };
  } catch (error) {
    return {
      ok: false,
      nextIndex,
      applied,
      warnings,
      snapshot,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runVerify(storeRoot, expectedIndex, journalPath) {
  const findings = [];
  try {
    const freshIndex = await readIndex(path.join(storeRoot, "INDEX.json"));
    if (!freshIndex) {
      findings.push({ phase: "verify", code: "INDEX_MISSING", message: "INDEX.json not found after migration." });
      return { ok: false, findings };
    }
    if (freshIndex.storeFormatVersion !== expectedIndex.storeFormatVersion) {
      findings.push({
        phase: "verify",
        code: "VERSION_MISMATCH",
        message: `Expected storeFormatVersion ${expectedIndex.storeFormatVersion}, found ${freshIndex.storeFormatVersion}.`
      });
    }

    const schemaVersion = await readSchemaVersion(path.join(storeRoot, SCHEMA_VERSION_FILE));
    if (schemaVersion !== expectedIndex.storeFormatVersion) {
      findings.push({
        phase: "verify",
        code: "SCHEMA_VERSION_MISMATCH",
        message: `Expected .schema-version ${expectedIndex.storeFormatVersion}, found ${schemaVersion || "(missing)"}.`
      });
    }

    const sampleIds = Object.keys(expectedIndex.entries ?? {}).slice(0, 3);
    for (const id of sampleIds) {
      const expectedRecord = expectedIndex.entries[id];
      const actualRecord = freshIndex.entries[id];
      if (!actualRecord) {
        findings.push({ phase: "verify", code: "MISSING_RECORD", message: `Record ${id} missing from INDEX after migration.` });
        continue;
      }
      if (actualRecord.revision !== expectedRecord.revision) {
        findings.push({
          phase: "verify",
          code: "REVISION_MISMATCH",
          message: `Record ${id} revision mismatch: expected ${expectedRecord.revision}, got ${actualRecord.revision}.`
        });
      }
    }

    const journal = await readAll(journalPath);
    const migrateEntries = journal.filter((e) => e.op === "migrate" && e.status === "committed");
    if (migrateEntries.length === 0) {
      findings.push({ phase: "verify", code: "JOURNAL_MISSING", message: "No committed migrate journal entry found." });
    }
  } catch (error) {
    findings.push({ phase: "verify", code: "VERIFY_ERROR", message: error instanceof Error ? error.message : String(error) });
  }

  const ok = !findings.some((f) => f.code !== "DISK_CHECK");
  return { ok, findings };
}

async function runRollback(storeRoot, snapshot, migrationId, journalPath, reason) {
  try {
    await restoreSnapshot(snapshot.snapshotDir, storeRoot);
    const rollbackEntry = {
      entryId: `rollback-${migrationId}-${Date.now()}`,
      txId: crypto.randomUUID(),
      timestamp: nowIso(),
      op: "migrate-rollback",
      payload: { migrationId, reason },
      status: /** @type {const} */ ("committed")
    };
    await appendEntry(journalPath, rollbackEntry);
    return { ok: true, reason };
  } catch (error) {
    return { ok: false, reason, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * @param {string} storeRoot
 * @param {{ to?: string, from?: string, planOnly?: boolean, __testHooks?: Record<string, (...args: any[]) => Promise<void>> }} [options]
 * @returns {Promise<{ ok: boolean, migrationId?: string, preflight?: any, applied?: any[], verify?: any, rollback?: any, warnings: string[], error?: string }>}
 */
export async function runMigration(storeRoot, options = {}) {
  const toVersion = options.to ?? SUPPORTED_STORE_FORMAT_VERSION;
  const indexPath = path.join(storeRoot, "INDEX.json");
  const journalPath = path.join(storeRoot, ".journal", "current.jsonl");
  const index = await readIndex(indexPath).catch(() => null);
  const fromVersion = options.from ?? (index?.storeFormatVersion ?? "1.0.0");
  const migrationId = `migrate-${fromVersion}-to-${toVersion}-${Date.now()}`;
  const warnings = [];
  const testHooks = options.__testHooks ?? {};

  if (fromVersion === toVersion) {
    return { ok: true, migrationId, warnings: ["Store is already at target version. No migration needed."] };
  }

  const preflight = await runPreflight(storeRoot, index, fromVersion, toVersion);
  if (!preflight.ok) {
    return { ok: false, migrationId, preflight, warnings };
  }

  if (options.planOnly) {
    return {
      ok: true,
      migrationId,
      preflight,
      warnings: [`Plan: migrate ${fromVersion} → ${toVersion} in ${preflight.migrationPath?.length ?? 0} step(s).`]
    };
  }

  const journal = await readAll(journalPath).catch(() => []);
  const applyResult = await runApply(storeRoot, index, journal, preflight.migrationPath, migrationId);

  if (!applyResult.ok) {
    const rollback = await runRollback(storeRoot, applyResult.snapshot, migrationId, journalPath, applyResult.error ?? "apply failed");
    return { ok: false, migrationId, preflight, applied: applyResult.applied, rollback, warnings: applyResult.warnings };
  }

  const lockPath = path.join(storeRoot, ".lock");
  let lock = null;
  try {
    lock = await acquireLock(lockPath, { timeoutMs: 30_000 });
    await writeIndexAtomic(indexPath, applyResult.nextIndex);
    await testHooks.afterWriteIndex?.({ storeRoot, indexPath, journalPath });
    const migrateEntry = {
      entryId: `migrate-${migrationId}`,
      txId: crypto.randomUUID(),
      timestamp: nowIso(),
      op: "migrate",
      payload: { migrationId, fromStoreFormatVersion: fromVersion, toStoreFormatVersion: toVersion },
      status: /** @type {const} */ ("committed")
    };
    await appendEntry(journalPath, migrateEntry);
    await writeSchemaVersion(path.join(storeRoot, SCHEMA_VERSION_FILE), applyResult.nextIndex.storeFormatVersion);
  } catch (error) {
    const rollback = await runRollback(storeRoot, applyResult.snapshot, migrationId, journalPath, error instanceof Error ? error.message : String(error));
    return { ok: false, migrationId, preflight, applied: applyResult.applied, rollback, warnings: applyResult.warnings };
  } finally {
    if (lock) await releaseLock(lock);
  }

  const verify = await runVerify(storeRoot, applyResult.nextIndex, journalPath);
  if (!verify.ok) {
    const rollback = await runRollback(storeRoot, applyResult.snapshot, migrationId, journalPath, "verify failed");
    return { ok: false, migrationId, preflight, applied: applyResult.applied, verify, rollback, warnings: applyResult.warnings };
  }

  return {
    ok: true,
    migrationId,
    preflight,
    applied: applyResult.applied,
    verify,
    warnings: [...applyResult.warnings, ...warnings]
  };
}

export function listRegisteredMigrations() {
  return Array.from(MIGRATION_REGISTRY.entries()).map(([key, value]) => ({ key, ...value }));
}

export function clearMigrationRegistry() {
  MIGRATION_REGISTRY.clear();
}
