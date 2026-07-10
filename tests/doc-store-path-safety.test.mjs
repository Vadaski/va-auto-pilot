import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveArtifactPath, writeArtifact } from "../scripts/lib/doc-store/artifacts.mjs";
import { JournalCorruptError } from "../scripts/lib/doc-store/errors.mjs";
import { writeIndexAtomic } from "../scripts/lib/doc-store/index-file.mjs";
import { appendEntry, readAll } from "../scripts/lib/doc-store/journal.mjs";
import { normalizePublicInput, validateDocumentRecord } from "../scripts/lib/doc-store/schema.mjs";
import { buildDefaultIndex, createRecord, createRegistry } from "../scripts/lib/doc-store/store-models.mjs";
import { recoverPendingTransactions } from "../scripts/lib/doc-store/store-recovery.mjs";
import { buildArtifactPath, ensureStoreLayout } from "../scripts/lib/doc-store/shared.mjs";

function record(overrides = {}) {
  return {
    id: "design:safe",
    kind: "design",
    subtype: null,
    path: path.join("designs", "safe.json"),
    refs: [],
    inboundRefs: [],
    revision: 1,
    storeFormatVersion: "1.0.0",
    artifactSchemaVersion: "design@1.0.0",
    managed: true,
    archived: false,
    frontmatter: { title: "Safe", slug: "safe", body: "", metadata: {} },
    extensions: {},
    ...overrides,
  };
}

test("document record schema rejects non-canonical traversal paths", () => {
  const result = validateDocumentRecord(record({ path: "../escaped.json" }));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.includes("canonical artifact path")));
});

test("artifact resolver rejects absolute and root-escaping paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-doc-path-"));
  assert.throws(() => resolveArtifactPath(root, record({ path: "../escaped.json" })), /escapes the store root/);
  assert.throws(() => resolveArtifactPath(root, record({ path: path.join(root, "absolute.json") })), /must be relative/);
});

test("artifact writes reject symlinked parent directories", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink creation is not consistently available on Windows CI");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-doc-root-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "va-doc-outside-"));
  fs.symlinkSync(outside, path.join(root, "designs"), "dir");

  await assert.rejects(() => writeArtifact(root, record()), /must not be a symbolic link/);
  assert.equal(fs.existsSync(path.join(outside, "safe.json")), false);
});

test("document slugs reject path syntax before they can alias store control files", () => {
  for (const slug of ["../INDEX", ".", "..", "nested/slug", "nested\\slug", "has.dot"]) {
    const result = validateDocumentRecord(
      record({
        id: `design:${slug}`,
        path: "INDEX.json",
        frontmatter: { title: "Unsafe", slug, body: "", metadata: {} },
      }),
    );
    assert.equal(result.ok, false, `expected slug ${slug} to be rejected`);
    assert.ok(result.errors.some((error) => error.includes("frontmatter.slug")));
    assert.throws(() => buildArtifactPath("design", slug), /slug is not path-safe/);
  }

  assert.throws(
    () => normalizePublicInput({ title: "Unsafe", slug: "../INDEX" }),
    /slug must not be empty or contain path syntax/,
  );
});

async function initializeRecoveryStore(root) {
  await ensureStoreLayout(root);
  await writeIndexAtomic(path.join(root, "INDEX.json"), buildDefaultIndex());
  fs.writeFileSync(path.join(root, ".journal", "current.jsonl"), "", "utf8");
}

function writeRawPendingEntry(root, entry) {
  fs.writeFileSync(
    path.join(root, ".journal", "current.jsonl"),
    `${JSON.stringify({
      txId: "malicious-pending",
      timestamp: new Date().toISOString(),
      status: "pending",
      ...entry,
    })}\n`,
    "utf8",
  );
}

test("recovery rejects root-escaping pending journal paths without reading or deleting sentinels", async (context) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "va-doc-recovery-boundary-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));

  const deleteRoot = path.join(parent, "delete-store");
  fs.mkdirSync(deleteRoot);
  await initializeRecoveryStore(deleteRoot);
  const deleteSentinel = path.join(parent, "delete-sentinel.json");
  fs.writeFileSync(deleteSentinel, "do-not-delete", "utf8");
  writeRawPendingEntry(deleteRoot, {
    op: "create",
    payload: { ref: "design:delete-sentinel", kind: "design", path: "../delete-sentinel.json" },
  });

  await assert.rejects(
    () => recoverPendingTransactions(
      path.join(deleteRoot, ".journal", "current.jsonl"),
      path.join(deleteRoot, "INDEX.json"),
      deleteRoot,
    ),
    (error) => error instanceof JournalCorruptError && /payload\.path/.test(error.message),
  );
  assert.equal(fs.readFileSync(deleteSentinel, "utf8"), "do-not-delete");

  const readRoot = path.join(parent, "read-store");
  fs.mkdirSync(readRoot);
  await initializeRecoveryStore(readRoot);
  const readSentinel = path.join(parent, "read-sentinel.json");
  fs.writeFileSync(readSentinel, "not-json-and-must-not-be-read", "utf8");
  writeRawPendingEntry(readRoot, {
    op: "archive",
    payload: {
      ref: "design:read-sentinel",
      path: "../read-sentinel.json",
      previousPath: path.join("designs", "read-sentinel.json"),
      revision: 2,
    },
  });

  await assert.rejects(
    () => recoverPendingTransactions(
      path.join(readRoot, ".journal", "current.jsonl"),
      path.join(readRoot, "INDEX.json"),
      readRoot,
    ),
    (error) => error instanceof JournalCorruptError && /payload\.path/.test(error.message),
  );
  assert.equal(fs.readFileSync(readSentinel, "utf8"), "not-json-and-must-not-be-read");

  const mismatchRoot = path.join(parent, "mismatch-store");
  fs.mkdirSync(mismatchRoot);
  await initializeRecoveryStore(mismatchRoot);
  const managedSentinel = path.join(mismatchRoot, "designs", "victim.json");
  fs.writeFileSync(managedSentinel, "managed-but-not-this-transaction", "utf8");
  writeRawPendingEntry(mismatchRoot, {
    op: "create",
    payload: { ref: "design:attacker", kind: "design", path: path.join("designs", "victim.json") },
  });

  await assert.rejects(
    () => recoverPendingTransactions(
      path.join(mismatchRoot, ".journal", "current.jsonl"),
      path.join(mismatchRoot, "INDEX.json"),
      mismatchRoot,
    ),
    (error) => error instanceof JournalCorruptError && /canonical artifact path/.test(error.message),
  );
  assert.equal(fs.readFileSync(managedSentinel, "utf8"), "managed-but-not-this-transaction");
});

test("recovery refuses canonical journal paths routed through a symlinked managed directory", async (context) => {
  if (process.platform === "win32") {
    context.skip("symlink creation is not consistently available on Windows CI");
    return;
  }
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "va-doc-recovery-symlink-"));
  context.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, "store");
  const outside = path.join(parent, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  await initializeRecoveryStore(root);
  fs.rmSync(path.join(root, "designs"), { recursive: true });
  fs.symlinkSync(outside, path.join(root, "designs"), "dir");
  const sentinel = path.join(outside, "sentinel.json");
  fs.writeFileSync(sentinel, "outside", "utf8");
  writeRawPendingEntry(root, {
    op: "create",
    payload: { ref: "design:sentinel", kind: "design", path: path.join("designs", "sentinel.json") },
  });

  await assert.rejects(
    () => recoverPendingTransactions(
      path.join(root, ".journal", "current.jsonl"),
      path.join(root, "INDEX.json"),
      root,
    ),
    (error) => error instanceof JournalCorruptError && /symbolic link/.test(error.message),
  );
  assert.equal(fs.readFileSync(sentinel, "utf8"), "outside");
});

test("recovery still restores a normal pending update from the durable index", async (context) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-doc-recovery-normal-"));
  context.after(() => fs.rmSync(root, { recursive: true, force: true }));
  await initializeRecoveryStore(root);

  const durable = createRecord("design", { title: "Recovery safe" }, createRegistry());
  const index = buildDefaultIndex();
  index.entries[durable.id] = durable;
  await writeIndexAtomic(path.join(root, "INDEX.json"), index);
  await writeArtifact(root, {
    ...durable,
    revision: 2,
    frontmatter: { ...durable.frontmatter, body: "uncommitted" },
  });
  await appendEntry(path.join(root, ".journal", "current.jsonl"), {
    txId: "normal-pending-update",
    timestamp: new Date().toISOString(),
    op: "update",
    payload: { ref: durable.id, path: durable.path, revision: 2 },
    status: "pending",
  });

  await recoverPendingTransactions(
    path.join(root, ".journal", "current.jsonl"),
    path.join(root, "INDEX.json"),
    root,
  );

  const recoveredArtifact = JSON.parse(fs.readFileSync(path.join(root, durable.path), "utf8"));
  const recoveredJournal = await readAll(path.join(root, ".journal", "current.jsonl"));
  assert.equal(recoveredArtifact.revision, 1);
  assert.equal(recoveredArtifact.frontmatter.body, "");
  assert.equal(recoveredJournal.at(-1)?.status, "aborted");
});
