import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { openManagedDocStore } from "./lib/doc-store/managed-doc-store.mjs";

async function withTempStore(prefix, run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  let store = null;
  try {
    store = await openManagedDocStore(root);
    await run({ root, store });
  } finally {
    await store?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function testAdoption() {
  await withTempStore("va-doc-store-adopt-", async ({ root, store }) => {
    const testFile = path.join(root, "legacy.md");
    await fs.writeFile(testFile, "# My Legacy Doc\nSome content", "utf8");

    const record = await store.adoptDocument(testFile, { kind: "process", title: "My Legacy Doc" });
    const fileStillExists = await fs.stat(testFile).then(() => true).catch(() => false);

    assert.equal(record.frontmatter.title, "My Legacy Doc");
    assert.equal(fileStillExists, false, "File should be moved");
  });
  console.log("✔ adoptDocument works");
}

async function testImport() {
  await withTempStore("va-doc-store-import-", async ({ root, store }) => {
    const testFile = path.join(root, "legacy-import.md");
    await fs.writeFile(testFile, "# My Legacy Import\nSome content", "utf8");

    const record = await store.importLegacyDocument(testFile, { kind: "process", title: "My Legacy Import" });
    const fileStillExists = await fs.stat(testFile).then(() => true).catch(() => false);

    assert.equal(record.frontmatter.title, "My Legacy Import");
    assert.equal(fileStillExists, true, "File should remain");
  });
  console.log("✔ importLegacyDocument works");
}

await testAdoption();
await testImport();
