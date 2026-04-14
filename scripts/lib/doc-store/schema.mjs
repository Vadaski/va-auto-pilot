import { InvalidInputError } from "./errors.mjs";
import { DOCUMENT_KINDS } from "./types.mjs";
import { isPlainObject } from "./shared.mjs";

function validateRelations(value, fieldName, errors) {
  if (!Array.isArray(value)) {
    errors.push(`${fieldName} must be an array`);
    return;
  }
  value.forEach((relation, index) => {
    if (!isPlainObject(relation)) {
      errors.push(`${fieldName}[${index}] must be an object`);
      return;
    }
    if (typeof relation.to !== "string" || relation.to.length === 0) {
      errors.push(`${fieldName}[${index}].to must be a non-empty string`);
    }
    if (typeof relation.relation !== "string" || relation.relation.length === 0) {
      errors.push(`${fieldName}[${index}].relation must be a non-empty string`);
    }
    if (relation.strength !== undefined && relation.strength !== "weak" && relation.strength !== "strong") {
      errors.push(`${fieldName}[${index}].strength must be weak or strong`);
    }
  });
}

function normalizeRelations(value) {
  return value.map((relation) => ({
    ...relation,
    strength: relation.strength ?? "weak"
  }));
}

/**
 * @param {unknown} input
 * @param {{ isPatch?: boolean }} [options]
 * @returns {{ ok: boolean, errors: string[], value: Record<string, any> | null }}
 */
export function validatePublicInput(input, options = {}) {
  const errors = [];
  if (!isPlainObject(input)) {
    return { ok: false, errors: ["input must be an object"], value: null };
  }
  const source = /** @type {Record<string, any>} */ (input);
  const value = { ...source };
  const isPatch = options.isPatch ?? false;

  if (source.title !== undefined && typeof source.title !== "string") {
    errors.push("title must be a string");
  }
  if (source.body !== undefined && typeof source.body !== "string") {
    errors.push("body must be a string");
  }
  if (source.slug !== undefined && typeof source.slug !== "string") {
    errors.push("slug must be a string");
  }
  if (!isPatch && source.id !== undefined && typeof source.id !== "string") {
    errors.push("id must be a string");
  }
  if (source.subtype !== undefined && source.subtype !== null && typeof source.subtype !== "string") {
    errors.push("subtype must be a string or null");
  }
  if (source.metadata !== undefined && !isPlainObject(source.metadata)) {
    errors.push("metadata must be an object");
  }
  if (!isPatch && source.extensions !== undefined && !isPlainObject(source.extensions)) {
    errors.push("extensions must be an object");
  }
  if (source.refs !== undefined) {
    const relationErrors = [];
    validateRelations(source.refs, "refs", relationErrors);
    errors.push(...relationErrors);
    if (relationErrors.length === 0) {
      value.refs = normalizeRelations(source.refs);
    }
  }

  return { ok: errors.length === 0, errors, value };
}

/**
 * @param {unknown} input
 * @param {{ isPatch?: boolean }} [options]
 * @returns {Record<string, any>}
 */
export function normalizePublicInput(input, options = {}) {
  const result = validatePublicInput(input, options);
  if (!result.ok || !result.value) {
    throw new InvalidInputError(result.errors[0] ?? "input is invalid");
  }
  return result.value;
}

/**
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateDocumentRecord(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ["DocumentRecord must be an object"] };
  }
  const record = /** @type {Record<string, any>} */ (obj);
  if (typeof record.id !== "string" || record.id.length === 0) {
    errors.push("id must be a non-empty string");
  }
  if (!DOCUMENT_KINDS.includes(record.kind)) {
    errors.push("kind must be one of design, decision, process");
  }
  if (record.subtype !== null && record.subtype !== undefined && typeof record.subtype !== "string") {
    errors.push("subtype must be a string or null");
  }
  if (typeof record.path !== "string" || record.path.length === 0) {
    errors.push("path must be a non-empty string");
  }
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 1) {
    errors.push("revision must be an integer >= 1");
  }
  if (typeof record.storeFormatVersion !== "string" || record.storeFormatVersion.length === 0) {
    errors.push("storeFormatVersion must be a non-empty string");
  }
  if (typeof record.artifactSchemaVersion !== "string" || record.artifactSchemaVersion.length === 0) {
    errors.push("artifactSchemaVersion must be a non-empty string");
  }
  validateRelations(record.refs, "refs", errors);
  if (record.inboundRefs !== undefined) {
    validateRelations(record.inboundRefs, "inboundRefs", errors);
  }
  if (!isPlainObject(record.frontmatter)) {
    errors.push("frontmatter must be an object");
  }
  if (!isPlainObject(record.extensions)) {
    errors.push("extensions must be an object");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStoreIndex(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ["StoreIndex must be an object"] };
  }
  const index = /** @type {Record<string, any>} */ (obj);
  if (typeof index.storeFormatVersion !== "string" || index.storeFormatVersion.length === 0) {
    errors.push("storeFormatVersion must be a non-empty string");
  }
  if (!Array.isArray(index.managedRoots) || index.managedRoots.some((item) => typeof item !== "string")) {
    errors.push("managedRoots must be an array of strings");
  }
  if (!isPlainObject(index.entries)) {
    errors.push("entries must be an object");
  } else {
    for (const [entryId, record] of Object.entries(index.entries)) {
      const result = validateDocumentRecord(record);
      if (!result.ok) {
        errors.push(`entries.${entryId}: ${result.errors.join(", ")}`);
      }
    }
  }
  if (!isPlainObject(index.extensions)) {
    errors.push("extensions must be an object");
  }
  if (index.lastUpdated !== undefined && typeof index.lastUpdated !== "string") {
    errors.push("lastUpdated must be a string when present");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * @param {unknown} obj
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateJournalEntry(obj) {
  const errors = [];
  if (!isPlainObject(obj)) {
    return { ok: false, errors: ["JournalEntry must be an object"] };
  }
  const entry = /** @type {Record<string, any>} */ (obj);
  if (typeof entry.txId !== "string" || entry.txId.length === 0) {
    errors.push("txId must be a non-empty string");
  }
  if (typeof entry.timestamp !== "string" || entry.timestamp.length === 0) {
    errors.push("timestamp must be a non-empty string");
  }
  if (typeof entry.op !== "string" || entry.op.length === 0) {
    errors.push("op must be a non-empty string");
  }
  if (!isPlainObject(entry.payload)) {
    errors.push("payload must be an object");
  }
  if (entry.status !== "pending" && entry.status !== "committed" && entry.status !== "aborted") {
    errors.push("status must be pending, committed, or aborted");
  }
  return { ok: errors.length === 0, errors };
}
