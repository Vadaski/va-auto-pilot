#!/usr/bin/env node

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { test } from "node:test";

import {
  appendEntry,
  acquireLock,
  buildDefaultConfig,
  checkStagedDiff,
  openManagedDocStore,
  readAll,
  readIndex,
  readStoreConfig,
  releaseLock,
  writeIndexAtomic,
  writeStoreConfigAtomic
} from "./lib/doc-store/index.mjs";

const REPO_ROOT = process.cwd();
const CLI = path.join(REPO_ROOT, "scripts/doc-store-cli.mjs");

const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const writeJson = (file, value) => fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
const runCli = (cwd, ...args) => spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const readReport = (stdout) => JSON.parse(stdout || "{}");
const commitAll = (cwd, message) => git(cwd, "commit", "-qm", message);
const indexPathFor = (cwd) => path.join(cwd, ".docstore", "INDEX.json");
const configPathFor = (cwd) => path.join(cwd, ".docstore", "store.config.json");
const journalPathFor = (cwd) => path.join(cwd, ".docstore", ".journal", "current.jsonl");

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-store-mode-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "user.name", "Test User");
  return dir;
}

function stage(cwd, ...paths) {
  git(cwd, "add", ...paths);
}

function setMode(cwd, mode) {
  const configPath = configPathFor(cwd);
  const config = json(configPath);
  config.mode = mode;
  writeJson(configPath, config);
}

function bumpIndexTimestamp(cwd, updater = (index) => index) {
  const indexPath = indexPathFor(cwd);
  const index = json(indexPath);
  const next = updater(index);
  next.lastUpdated = new Date(Date.now() + 1000).toISOString();
  writeJson(indexPath, next);
}

function corruptIndex(cwd, transform) {
  const indexPath = indexPathFor(cwd);
  fs.writeFileSync(indexPath, transform(fs.readFileSync(indexPath, "utf8")), "utf8");
}

async function initStore(cwd, ...args) {
  const result = runCli(cwd, "init", ...args);
  assert.equal(result.status, 0, result.stderr);
  return result;
}

async function initManagedRepo(cwd) {
  await initStore(cwd);
  setMode(cwd, "managed");
  stage(cwd, ".docstore");
  commitAll(cwd, "init doc store");
}

async function createCommittedDesign(cwd, title = "Ground Truth") {
  const store = await openManagedDocStore(path.join(cwd, ".docstore"));
  const record = await store.createDesign({ title });
  await store.close();
  stage(cwd, ".docstore");
  commitAll(cwd, `create ${record.id}`);
  return record;
}

test("init on empty dir creates config, index, journal, and schema", async () => {
  const cwd = repo();
  await initStore(cwd);
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", "store.config.json")), true);
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", "INDEX.json")), true);
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", ".journal", "current.jsonl")), true);
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", ".schema-version")), true);
});

test("init on existing store is idempotent and delegates to doctor", async () => {
  const cwd = repo();
  await initStore(cwd);
  const result = runCli(cwd, "init");
  assert.equal(result.status, 0);
  assert.equal(readReport(result.stdout).ok, true);
});

test("init --force overwrites config mode and retains extensions journal and archive", async () => {
  const cwd = repo();
  await initStore(cwd);
  const store = await openManagedDocStore(path.join(cwd, ".docstore"));
  await store.registerExtensionType({ name: "ops-log", kind: "process" });
  const doc = await store.createDesign({ title: "Archived thing" });
  await store.archiveDocument(doc.id);
  await store.close();
  await appendEntry(path.join(cwd, ".docstore", ".journal", "current.jsonl"), { txId: "tx-1", timestamp: new Date().toISOString(), op: "noop", payload: {}, status: "committed" });
  await initStore(cwd, "--force", "--mode=managed");
  const index = await readIndex(path.join(cwd, ".docstore", "INDEX.json"));
  const config = await readStoreConfig(path.join(cwd, ".docstore"));
  assert.equal(config.mode, "managed");
  assert.equal(Boolean(index.extensions.registeredTypes["ops-log"]), true);
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", "archive")), true);
  assert.equal((await readAll(path.join(cwd, ".docstore", ".journal", "current.jsonl"))).length > 0, true);
});

test("init --force retains registered extensions", async () => {
  const cwd = repo();
  await initStore(cwd);
  const store = await openManagedDocStore(path.join(cwd, ".docstore"));
  await store.registerExtensionType({ name: "kept", kind: "process" });
  await store.close();
  await initStore(cwd, "--force");
  const index = await readIndex(path.join(cwd, ".docstore", "INDEX.json"));
  assert.equal(Boolean(index.extensions.registeredTypes.kept), true);
});

test("doctor on clean store returns ok and exits zero", async () => {
  const cwd = repo();
  await initStore(cwd);
  const result = runCli(cwd, "doctor");
  assert.equal(result.status, 0);
  assert.equal(readReport(result.stdout).ok, true);
});

test("doctor reports managedRoots drift and exits non-zero", async () => {
  const cwd = repo();
  await initStore(cwd);
  const configPath = configPathFor(cwd);
  const config = json(configPath);
  config.managedRoots = [".docstore/designs"];
  writeJson(configPath, config);
  const result = runCli(cwd, "doctor");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CONFIG_INDEX_DRIFT/);
});

test("doctor reports invalid config to stderr without crashing", async () => {
  const cwd = repo();
  await initStore(cwd);
  fs.writeFileSync(configPathFor(cwd), "{", "utf8");
  const result = runCli(cwd, "doctor");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_CONFIG/);
});

test("init --force rejects garbage config options", async () => {
  const cwd = repo();
  const result = runCli(cwd, "init", "--force", "--mode=oops");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Invalid store config/);
});

test("init recovers from partial config written mid-bootstrap", async () => {
  const cwd = repo();
  fs.mkdirSync(path.join(cwd, ".docstore"), { recursive: true });
  fs.writeFileSync(configPathFor(cwd), "{", "utf8");
  const result = runCli(cwd, "init");
  assert.equal(result.status, 0);
  assert.equal((await readStoreConfig(path.join(cwd, ".docstore"))).mode, "legacy");
});

test("enforce-staged with pending journal entry is read-only", async () => {
  const cwd = repo();
  await initStore(cwd);
  await appendEntry(path.join(cwd, ".docstore", ".journal", "current.jsonl"), { txId: "pending-a", timestamp: new Date().toISOString(), op: "create", payload: { ref: "x" }, status: "pending" });
  const before = await readAll(path.join(cwd, ".docstore", ".journal", "current.jsonl"));
  fs.writeFileSync(path.join(cwd, "README.md"), "hi\n", "utf8");
  stage(cwd, "README.md");
  const result = runCli(cwd, "enforce-staged");
  const after = await readAll(path.join(cwd, ".docstore", ".journal", "current.jsonl"));
  assert.equal(result.status, 0);
  assert.equal(after.length, before.length);
});

test("doctor reports pending journal entry without repairing it", async () => {
  const cwd = repo();
  await initStore(cwd);
  await appendEntry(path.join(cwd, ".docstore", ".journal", "current.jsonl"), { txId: "pending-b", timestamp: new Date().toISOString(), op: "create", payload: { ref: "x" }, status: "pending" });
  const result = runCli(cwd, "doctor");
  const journal = await readAll(path.join(cwd, ".docstore", ".journal", "current.jsonl"));
  assert.equal(result.status, 1);
  assert.match(result.stdout, /JOURNAL_PENDING/);
  assert.equal(journal.at(-1)?.status, "pending");
});

test("enforce-staged succeeds while lock file is held", async () => {
  const cwd = repo();
  await initStore(cwd);
  const lock = await acquireLock(path.join(cwd, ".docstore", ".lock"));
  fs.writeFileSync(path.join(cwd, "README.md"), "noop\n", "utf8");
  stage(cwd, "README.md");
  const result = runCli(cwd, "enforce-staged");
  await releaseLock(lock);
  assert.equal(result.status, 0);
});

test("two concurrent init calls on a fresh root both exit cleanly", async () => {
  const cwd = repo();
  const run = () => new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "init"], { cwd, stdio: "pipe" });
    child.on("exit", (code) => resolve(code));
  });
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual([a, b].sort(), [0, 0]);
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", "store.config.json")), true);
});

test("doctor remains read-only while the write lock is held", async () => {
  const cwd = repo();
  await initStore(cwd);
  const lock = await acquireLock(path.join(cwd, ".docstore", ".lock"));
  const result = runCli(cwd, "doctor");
  await releaseLock(lock);
  assert.equal(result.status, 0);
});

test("init --force can synchronize config and INDEX managedRoots", async () => {
  const cwd = repo();
  await initStore(cwd, "--force", "--managed-roots=.docstore/designs,.docstore/process");
  const config = await readStoreConfig(path.join(cwd, ".docstore"));
  const index = await readIndex(path.join(cwd, ".docstore", "INDEX.json"));
  assert.deepEqual(config.managedRoots, index.managedRoots);
});

test("doctor detects reverse drift when INDEX.managedRoots is edited by hand", async () => {
  const cwd = repo();
  await initStore(cwd);
  const indexPath = indexPathFor(cwd);
  const index = await readIndex(indexPath);
  await writeIndexAtomic(indexPath, { ...index, managedRoots: [".docstore/process"] });
  const result = runCli(cwd, "doctor");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CONFIG_INDEX_DRIFT/);
});

test("init canonicalizes managedRoots store subdirs to .docstore-prefixed paths", async () => {
  const cwd = repo();
  await initStore(cwd, "--force", "--managed-roots=designs");
  const config = await readStoreConfig(path.join(cwd, ".docstore"));
  const index = await readIndex(indexPathFor(cwd));
  assert.deepEqual(config.managedRoots, [".docstore/designs"]);
  assert.deepEqual(index.managedRoots, [".docstore/designs"]);
});

test("doctor flags bare managedRoots in config as canonicalization drift", async () => {
  const cwd = repo();
  await initStore(cwd);
  const config = json(configPathFor(cwd));
  config.managedRoots = ["designs"];
  writeJson(configPathFor(cwd), config);
  const result = runCli(cwd, "doctor");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /CONFIG_INDEX_DRIFT/);
});

test("init --force preserves authoritative managedRoots from existing config when INDEX is truncated", async () => {
  const cwd = repo();
  await initStore(cwd);
  const storeRoot = path.join(cwd, ".docstore");
  const config = await readStoreConfig(storeRoot);
  await writeStoreConfigAtomic(storeRoot, { ...config, managedRoots: [".docstore/process"] });
  corruptIndex(cwd, (content) => content.slice(0, 12));

  const result = runCli(cwd, "init", "--force");
  const repairedConfig = await readStoreConfig(storeRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repairedConfig.managedRoots, [".docstore/process"]);
});

test("init --force still lets explicit --managed-roots override existing config authority", async () => {
  const cwd = repo();
  await initStore(cwd);
  const storeRoot = path.join(cwd, ".docstore");
  const config = await readStoreConfig(storeRoot);
  await writeStoreConfigAtomic(storeRoot, { ...config, managedRoots: [".docstore/process"] });
  corruptIndex(cwd, (content) => content.slice(0, 12));

  const result = runCli(cwd, "init", "--force", "--managed-roots=.docstore/designs");
  const repairedConfig = await readStoreConfig(storeRoot);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(repairedConfig.managedRoots, [".docstore/designs"]);
});

test("mode enforcement stays permissive in legacy mode", () => {
  const result = checkStagedDiff({ stagedFiles: [{ path: ".docstore/designs/x.json", status: "M" }], config: { ...buildDefaultConfig(), managedRoots: [".docstore/designs"] }, index: { entries: {} } });
  assert.equal(result.ok, true);
});

test("mode enforcement ignores unmanaged paths in mixed mode", () => {
  const result = checkStagedDiff({ stagedFiles: [{ path: "docs/legacy.md", status: "M" }], config: { ...buildDefaultConfig(), mode: "mixed", managedRoots: [".docstore/designs"] }, index: { entries: {} } });
  assert.equal(result.ok, true);
});

test("mode enforcement flags bare managed modify in mixed mode", () => {
  const result = checkStagedDiff({ stagedFiles: [{ path: ".docstore/designs/x.json", status: "M" }], config: { ...buildDefaultConfig(), mode: "mixed", managedRoots: [".docstore/designs"] }, index: { entries: {} } });
  assert.equal(result.violations[0]?.type, "BARE_MANAGED_MODIFY");
});

test("mode enforcement flags unregistered managed add in mixed mode", () => {
  const result = checkStagedDiff({ stagedFiles: [{ path: ".docstore/designs/x.json", status: "A" }], config: { ...buildDefaultConfig(), mode: "mixed", managedRoots: [".docstore/designs"] }, index: { entries: {} } });
  assert.equal(result.violations[0]?.type, "UNREGISTERED_MANAGED_ADD");
});

test("mode enforcement flags bare managed modify in managed mode", () => {
  const result = checkStagedDiff({ stagedFiles: [{ path: ".docstore/process/x.json", status: "M" }], config: { ...buildDefaultConfig(), mode: "managed", managedRoots: [".docstore/process"] }, index: { entries: {} } });
  assert.equal(result.violations[0]?.type, "BARE_MANAGED_MODIFY");
});

test("mode enforcement flags untracked managed delete", () => {
  const result = checkStagedDiff({
    stagedFiles: [{ path: ".docstore/designs/x.json", status: "D" }],
    config: { ...buildDefaultConfig(), mode: "managed", managedRoots: [".docstore/designs"] },
    index: { entries: { "design:x": { path: "designs/x.json", archived: false, revision: 2 } } },
    previousIndex: { entries: { "design:x": { path: "designs/x.json", archived: false, revision: 1 } } }
  });
  assert.equal(result.violations[0]?.type, "UNTRACKED_MANAGED_DELETE");
});

test("enforce-staged end to end returns non-zero and prints violation", async () => {
  const cwd = repo();
  await initStore(cwd);
  setMode(cwd, "managed");
  fs.mkdirSync(path.join(cwd, ".docstore", "designs"), { recursive: true });
  writeJson(path.join(cwd, ".docstore", "designs", "manual.json"), { title: "manual" });
  stage(cwd, ".docstore/store.config.json", ".docstore/designs/manual.json");
  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNREGISTERED_MANAGED_ADD/);
});

test("enforce-staged rejects bare managed modify with orthogonal INDEX tweak", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  const record = await createCommittedDesign(cwd, "Orthogonal Index");
  const artifactPath = path.join(cwd, ".docstore", record.path);

  const artifact = json(artifactPath);
  artifact.frontmatter.body = "hand edit";
  writeJson(artifactPath, artifact);
  bumpIndexTimestamp(cwd);
  stage(cwd, ".docstore/INDEX.json", `.docstore/${record.path}`);

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BARE_MANAGED_MODIFY/);
});

test("enforce-staged catches managed modify under canonicalized init managedRoots", async () => {
  const cwd = repo();
  await initStore(cwd, "--force", "--mode=managed", "--managed-roots=designs");
  fs.mkdirSync(path.join(cwd, ".docstore", "designs"), { recursive: true });
  writeJson(path.join(cwd, ".docstore", "designs", "foo.json"), { title: "baseline" });
  stage(cwd, ".docstore");
  commitAll(cwd, "seed bare managed artifact");

  writeJson(path.join(cwd, ".docstore", "designs", "foo.json"), { title: "edited" });
  stage(cwd, ".docstore/designs/foo.json");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BARE_MANAGED_MODIFY/);
});

test("enforce-staged rejects unregistered managed .json add", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);

  writeJson(path.join(cwd, ".docstore", "designs", "foo.json"), {
    id: "design:foo",
    frontmatter: { title: "Foo" }
  });
  bumpIndexTimestamp(cwd);
  stage(cwd, ".docstore/INDEX.json", ".docstore/designs/foo.json");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNREGISTERED_MANAGED_ADD/);
});

test("enforce-staged uses staged INDEX instead of working tree INDEX", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  const record = await createCommittedDesign(cwd, "Staged Truth");
  const artifactPath = path.join(cwd, ".docstore", record.path);

  const artifact = json(artifactPath);
  artifact.frontmatter.body = "staged change";
  writeJson(artifactPath, artifact);
  bumpIndexTimestamp(cwd);
  stage(cwd, ".docstore/INDEX.json", `.docstore/${record.path}`);

  bumpIndexTimestamp(cwd, (index) => {
    index.entries[record.id].revision += 1;
    return index;
  });

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /BARE_MANAGED_MODIFY/);
});

test("enforce-staged accepts valid managed write with bumped revision", async () => {
  const cwd = repo();
  await initStore(cwd);
  setMode(cwd, "managed");
  const store = await openManagedDocStore(path.join(cwd, ".docstore"));
  await store.createDesign({ title: "Healthy Baseline" });
  await store.close();
  stage(cwd, ".docstore");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 0, result.stderr);
});

test("enforce-staged rejects staged config with bare managedRoots before diff enforcement", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  const config = json(configPathFor(cwd));
  config.managedRoots = ["designs"];
  writeJson(configPathFor(cwd), config);

  writeJson(path.join(cwd, ".docstore", "designs", "manual.json"), { title: "manual" });
  stage(cwd, ".docstore/store.config.json", ".docstore/designs/manual.json");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /NON_CANONICAL_STAGED_CONFIG/);
});

test("enforce-staged rejects invalid staged store.config.json", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  fs.writeFileSync(configPathFor(cwd), "{\n", "utf8");
  stage(cwd, ".docstore/store.config.json");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /INVALID_STAGED_CONFIG/);
});

test("enforce-staged accepts staged canonical config with no managed violations", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  const config = json(configPathFor(cwd));
  config.managedRoots = [".docstore/designs", ".docstore/process"];
  writeJson(configPathFor(cwd), config);
  stage(cwd, ".docstore/store.config.json");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 0, result.stderr);
});

test("enforce-staged rejects managed delete with manual INDEX revision bump", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  const record = await createCommittedDesign(cwd, "Delete Me");

  git(cwd, "rm", "-q", `.docstore/${record.path}`);
  bumpIndexTimestamp(cwd);
  stage(cwd, ".docstore/INDEX.json");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /UNTRACKED_MANAGED_DELETE/);
});

test("enforce-staged accepts archive flow that removes original managed artifact path", async () => {
  const cwd = repo();
  await initManagedRepo(cwd);
  const record = await createCommittedDesign(cwd, "Archive Me");
  const store = await openManagedDocStore(path.join(cwd, ".docstore"));
  await store.archiveDocument(record.id);
  await store.close();
  stage(cwd, ".docstore");

  const result = runCli(cwd, "enforce-staged");
  assert.equal(result.status, 0, result.stderr);
});

test("init --force rebuilds truncated INDEX.json and preserves journal plus extensions dir", async () => {
  const cwd = repo();
  await initStore(cwd);
  const store = await openManagedDocStore(path.join(cwd, ".docstore"));
  const record = await store.createDesign({ title: "Survivor" });
  await store.close();
  fs.mkdirSync(path.join(cwd, ".docstore", "extensions"), { recursive: true });
  fs.writeFileSync(path.join(cwd, ".docstore", "extensions", "sentinel.txt"), "keep\n", "utf8");
  await appendEntry(journalPathFor(cwd), { txId: "rebuild-a", timestamp: new Date().toISOString(), op: "noop", payload: {}, status: "committed" });
  const beforeJournal = fs.readFileSync(journalPathFor(cwd), "utf8");
  corruptIndex(cwd, (content) => content.slice(0, 10));

  const result = runCli(cwd, "init", "--force");
  const rebuiltIndex = await readIndex(indexPathFor(cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /init --force: rebuilding INDEX\.json from bootstrap defaults; prior entries discarded/);
  assert.deepEqual(rebuiltIndex.entries, {});
  assert.equal(fs.existsSync(path.join(cwd, ".docstore", record.path)), true);
  assert.equal(fs.readFileSync(path.join(cwd, ".docstore", "extensions", "sentinel.txt"), "utf8"), "keep\n");
  assert.equal(fs.readFileSync(journalPathFor(cwd), "utf8"), beforeJournal);
});

test("init --force rebuilds checksum-corrupt INDEX.json", async () => {
  const cwd = repo();
  await initStore(cwd);
  corruptIndex(cwd, (content) => content.replace(/"__checksum":\s*"[^"]+"/, "\"__checksum\": \"broken\""));

  const result = runCli(cwd, "init", "--force");
  const rebuiltIndex = await readIndex(indexPathFor(cwd));
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /init --force: rebuilding INDEX\.json from bootstrap defaults; prior entries discarded/);
  assert.deepEqual(rebuiltIndex.entries, {});
});

test("init without --force fails on corrupt INDEX.json and points to --force", async () => {
  const cwd = repo();
  await initStore(cwd);
  corruptIndex(cwd, (content) => content.slice(0, 10));

  const result = runCli(cwd, "init");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /--force/);
});
