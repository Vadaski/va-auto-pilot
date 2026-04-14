import path from "node:path";

import { listArtifactFiles } from "./artifacts.mjs";
import { DanglingReferenceError, DuplicatePathViolation, OrphanDocumentError } from "./errors.mjs";
import { pathExists } from "./shared.mjs";

export async function validateStore(rootPath, index) {
  const violations = [];
  const refsByPath = new Map();
  for (const record of Object.values(index.entries)) {
    const refs = refsByPath.get(record.path) ?? [];
    refs.push(record.id);
    refsByPath.set(record.path, refs);
  }
  for (const [recordPath, refs] of refsByPath) {
    if (refs.length > 1) {
      violations.push({ type: DuplicatePathViolation.name, ref: recordPath, message: new DuplicatePathViolation(recordPath, refs).message });
    }
  }
  const referencedPaths = new Set(refsByPath.keys());
  for (const artifactPath of await listArtifactFiles(rootPath)) {
    if (!referencedPaths.has(artifactPath)) {
      violations.push({ type: OrphanDocumentError.name, ref: artifactPath, message: new OrphanDocumentError(artifactPath).message });
    }
  }
  for (const record of Object.values(index.entries)) {
    if (!(await pathExists(path.join(rootPath, record.path)))) {
      violations.push({ type: DanglingReferenceError.name, ref: record.id, message: `Missing artifact: ${record.path}` });
    }
    for (const relation of record.refs) {
      if (!index.entries[relation.to]) {
        violations.push({ type: DanglingReferenceError.name, ref: record.id, message: new DanglingReferenceError(record.id, relation.to).message });
      }
    }
  }
  return { ok: violations.length === 0, violations };
}
