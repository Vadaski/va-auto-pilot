#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { openManagedDocStore } from "./lib/doc-store/index.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "doc-store-demo-"));
const store = await openManagedDocStore(root);

const design = await store.createDesign({ title: "ManagedDocStore Demo Design" });
console.log("design", design.id);

const decision = await store.createDecision({ title: "ManagedDocStore Demo Decision" });
console.log("decision", decision.id);

await store.linkDocuments(design.id, decision.id, "depends");
console.log("linked", design.id, "->", decision.id);

console.log("validate", await store.validate());
await store.archiveDocument(decision.id);
console.log("archived", decision.id);

await store.close();
console.log("root", root);
