// @ts-check
/**
 * meta-problems.mjs — storage, validation, and lifecycle for meta-problem records.
 *
 * A meta-problem is a defect or friction in va-auto-pilot itself (gates,
 * orchestration, protocol, CLI UX, state handling), observed while running it
 * inside an adopted project. Records live in `.va-auto-pilot/meta-problems.json`
 * inside the project and never leave the local disk.
 *
 * Design doc: docs/plans/meta-problem-awareness.md
 */

import fs from "node:fs";
import path from "node:path";

import { nowIso } from "./sprint-utils.mjs";
import { VAPilotError } from "./errors.mjs";

/**
 * @typedef {Object} MetaProblemContext
 * @property {string} [command]
 * @property {number | null} [exitCode]
 * @property {string} [outputExcerpt]
 * @property {string} [component]
 * @property {string} [taskId]
 * @property {string[]} [files]
 */

/**
 * @typedef {Object} MetaProblemEntry
 * @property {string} id
 * @property {string} category
 * @property {string} severity
 * @property {string} title
 * @property {string} symptom
 * @property {string} expected
 * @property {string} actual
 * @property {string} hypothesis
 * @property {string} suggestion
 * @property {MetaProblemContext} context
 * @property {string} source
 * @property {string} resolution
 * @property {string | null} resolvedAt
 * @property {string} createdAt
 */

/**
 * @typedef {Object} MetaProblemData
 * @property {number} version
 * @property {MetaProblemEntry[]} entries
 */

export const META_PROBLEMS_VERSION = 1;
export const DEFAULT_META_FILE = ".va-auto-pilot/meta-problems.json";
export const VALID_CATEGORIES = ["architecture", "gate", "protocol", "ux", "state", "integration"];
export const VALID_SEVERITIES = ["blocker", "major", "minor", "nit"];
export const VALID_SOURCES = ["agent", "human"];
export const OUTPUT_EXCERPT_MAX = 500;

/** Severity ordering for report clustering: lower rank surfaces first. */
export const SEVERITY_RANK = { blocker: 0, major: 1, minor: 2, nit: 3 };

const ID_PREFIX = "MP-";

/**
 * @param {string} filePath
 * @returns {MetaProblemData}
 */
export function readMetaProblems(filePath) {
  if (!fs.existsSync(filePath)) {
    return { version: META_PROBLEMS_VERSION, entries: [] };
  }
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new VAPilotError("PARSE_ERROR", `Cannot parse meta-problems file: ${filePath} — ${error instanceof Error ? error.message : String(error)}`, { filePath });
  }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
    throw new VAPilotError("CONFIG_ERROR", `Invalid meta-problems file: 'entries' must be an array`, { filePath });
  }
  return parsed;
}

/**
 * @param {string} filePath
 * @param {MetaProblemData} data
 * @returns {void}
 */
export function writeMetaProblems(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

/**
 * @param {MetaProblemEntry[]} entries
 * @returns {string}
 */
export function nextMetaProblemId(entries) {
  let max = 0;
  for (const entry of entries) {
    const match = String(entry?.id ?? "").match(/^MP-(\d+)$/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `${ID_PREFIX}${String(max + 1).padStart(3, "0")}`;
}

/**
 * @param {unknown} value
 * @returns {value is string}
 */
function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Validate one entry against schemas/meta-problem.schema.json (hand-rolled,
 * no ajv — repo convention). Returns every violation found.
 *
 * @param {unknown} entry
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateMetaProblemEntry(entry) {
  const errors = [];
  const record = /** @type {Record<string, unknown>} */ (entry ?? {});
  if (typeof record !== "object" || record === null || Array.isArray(record)) {
    return { ok: false, errors: ["entry must be an object"] };
  }
  if (!isNonEmptyString(record.id) || !/^MP-\d{3,}$/.test(record.id)) {
    errors.push("id must match MP-NNN (zero-padded)");
  }
  if (!VALID_CATEGORIES.includes(/** @type {string} */ (record.category))) {
    errors.push(`category must be one of ${VALID_CATEGORIES.join(", ")}`);
  }
  if (!VALID_SEVERITIES.includes(/** @type {string} */ (record.severity))) {
    errors.push(`severity must be one of ${VALID_SEVERITIES.join(", ")}`);
  }
  for (const field of ["title", "symptom", "expected", "actual"]) {
    if (!isNonEmptyString(record[field])) {
      errors.push(`${field} is required`);
    }
  }
  if (record.hypothesis !== undefined && typeof record.hypothesis !== "string") {
    errors.push("hypothesis must be a string");
  }
  if (record.suggestion !== undefined && typeof record.suggestion !== "string") {
    errors.push("suggestion must be a string");
  }
  const context = /** @type {Record<string, unknown> | undefined} */ (record.context);
  if (!context || typeof context !== "object" || Array.isArray(context)) {
    errors.push("context must be an object");
  } else {
    if (context.command !== undefined && typeof context.command !== "string") {
      errors.push("context.command must be a string");
    }
    if (context.exitCode !== undefined && context.exitCode !== null && !Number.isInteger(context.exitCode)) {
      errors.push("context.exitCode must be an integer or null");
    }
    if (context.outputExcerpt !== undefined) {
      if (typeof context.outputExcerpt !== "string") {
        errors.push("context.outputExcerpt must be a string");
      } else if (context.outputExcerpt.length > OUTPUT_EXCERPT_MAX) {
        errors.push(`context.outputExcerpt must be <= ${OUTPUT_EXCERPT_MAX} chars`);
      }
    }
    if (context.component !== undefined && typeof context.component !== "string") {
      errors.push("context.component must be a string");
    }
    if (context.taskId !== undefined && typeof context.taskId !== "string") {
      errors.push("context.taskId must be a string");
    }
    if (context.files !== undefined && (!Array.isArray(context.files) || context.files.some((f) => typeof f !== "string"))) {
      errors.push("context.files must be an array of strings");
    }
  }
  if (!VALID_SOURCES.includes(/** @type {string} */ (record.source))) {
    errors.push(`source must be one of ${VALID_SOURCES.join(", ")}`);
  }
  if (typeof record.resolution !== "string") {
    errors.push("resolution must be a string (empty while open)");
  }
  if (record.resolvedAt !== null && Number.isNaN(Date.parse(/** @type {string} */ (record.resolvedAt) ?? ""))) {
    errors.push("resolvedAt must be null or a parseable ISO-8601 string");
  }
  if (Number.isNaN(Date.parse(/** @type {string} */ (record.createdAt) ?? ""))) {
    errors.push("createdAt must be a parseable ISO-8601 string");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Validate a whole meta-problems file payload.
 *
 * @param {unknown} data
 * @returns {{ ok: boolean, errors: string[], entryErrors: Array<{ index: number, id: string, errors: string[] }> }}
 */
export function validateMetaProblemsFile(data) {
  const errors = [];
  const entryErrors = [];
  const record = /** @type {Record<string, unknown>} */ (data ?? {});
  if (record.version !== META_PROBLEMS_VERSION) {
    errors.push(`version must be ${META_PROBLEMS_VERSION}`);
  }
  if (!Array.isArray(record.entries)) {
    errors.push("entries must be an array");
    return { ok: false, errors, entryErrors };
  }
  record.entries.forEach((entry, index) => {
    const result = validateMetaProblemEntry(entry);
    if (!result.ok) {
      entryErrors.push({
        index,
        id: String(/** @type {Record<string, unknown>} */ (entry)?.id ?? `index-${index}`),
        errors: result.errors,
      });
    }
  });
  return { ok: errors.length === 0 && entryErrors.length === 0, errors, entryErrors };
}

/**
 * @param {Record<string, string>} options
 * @returns {MetaProblemContext}
 */
function buildContext(options) {
  /** @type {MetaProblemContext} */
  const context = {};
  if (isNonEmptyString(options.command)) {
    context.command = options.command;
  }
  if (isNonEmptyString(options["exit-code"])) {
    const parsed = Number.parseInt(options["exit-code"], 10);
    if (Number.isNaN(parsed)) {
      throw new VAPilotError("CONFIG_ERROR", `Invalid --exit-code '${options["exit-code"]}'. Expected an integer.`, { option: "exit-code" });
    }
    context.exitCode = parsed;
  }
  if (isNonEmptyString(options["output-excerpt"])) {
    context.outputExcerpt = options["output-excerpt"].slice(0, OUTPUT_EXCERPT_MAX);
  }
  if (isNonEmptyString(options.component)) {
    context.component = options.component;
  }
  if (isNonEmptyString(options.task)) {
    context.taskId = options.task;
  }
  if (isNonEmptyString(options.files)) {
    context.files = options.files.split(",").map((f) => f.trim()).filter(Boolean);
  }
  return context;
}

/**
 * Append a new meta-problem record.
 *
 * @param {string} filePath
 * @param {Record<string, string>} options CLI options (kebab-case keys)
 * @returns {MetaProblemEntry}
 */
export function addMetaProblem(filePath, options) {
  const required = ["category", "severity", "title", "symptom", "expected", "actual"];
  for (const name of required) {
    if (!isNonEmptyString(options[name])) {
      throw new VAPilotError("CONFIG_ERROR", `Missing required option --${name}`, { option: name });
    }
  }
  if (!VALID_CATEGORIES.includes(options.category)) {
    throw new VAPilotError("CONFIG_ERROR", `Invalid --category '${options.category}'. Expected one of: ${VALID_CATEGORIES.join(", ")}`, { option: "category" });
  }
  if (!VALID_SEVERITIES.includes(options.severity)) {
    throw new VAPilotError("CONFIG_ERROR", `Invalid --severity '${options.severity}'. Expected one of: ${VALID_SEVERITIES.join(", ")}`, { option: "severity" });
  }
  const source = isNonEmptyString(options.source) ? options.source : "agent";
  if (!VALID_SOURCES.includes(source)) {
    throw new VAPilotError("CONFIG_ERROR", `Invalid --source '${source}'. Expected one of: ${VALID_SOURCES.join(", ")}`, { option: "source" });
  }

  const data = readMetaProblems(filePath);
  /** @type {MetaProblemEntry} */
  const entry = {
    id: nextMetaProblemId(data.entries),
    category: options.category,
    severity: options.severity,
    title: options.title,
    symptom: options.symptom,
    expected: options.expected,
    actual: options.actual,
    hypothesis: options.hypothesis ?? "",
    suggestion: options.suggestion ?? "",
    context: buildContext(options),
    source,
    resolution: "",
    resolvedAt: null,
    createdAt: nowIso(),
  };
  const validation = validateMetaProblemEntry(entry);
  if (!validation.ok) {
    throw new VAPilotError("CONFIG_ERROR", `Refusing to write invalid meta-problem: ${validation.errors.join("; ")}`, { errors: validation.errors });
  }
  data.entries.push(entry);
  writeMetaProblems(filePath, data);
  return entry;
}

/**
 * @param {string} filePath
 * @param {{ open?: boolean, category?: string }} [filter]
 * @returns {MetaProblemEntry[]}
 */
export function listMetaProblems(filePath, filter = {}) {
  const data = readMetaProblems(filePath);
  return data.entries.filter((entry) => {
    if (filter.open && entry.resolvedAt !== null) {
      return false;
    }
    if (filter.category && entry.category !== filter.category) {
      return false;
    }
    return true;
  });
}

/**
 * @param {string} filePath
 * @param {string} id
 * @param {string} resolution
 * @returns {MetaProblemEntry}
 */
export function resolveMetaProblem(filePath, id, resolution) {
  if (!isNonEmptyString(id)) {
    throw new VAPilotError("CONFIG_ERROR", "Missing required option --id", { option: "id" });
  }
  if (!isNonEmptyString(resolution)) {
    throw new VAPilotError("CONFIG_ERROR", "Resolution must not be empty", { metaProblemId: id });
  }
  const data = readMetaProblems(filePath);
  const entry = data.entries.find((candidate) => candidate.id === id);
  if (!entry) {
    throw new VAPilotError("CONFIG_ERROR", `Meta-problem not found: ${id}`, { metaProblemId: id });
  }
  if (entry.resolvedAt !== null) {
    throw new VAPilotError("CONFIG_ERROR", `Meta-problem ${id} is already resolved`, { metaProblemId: id });
  }
  entry.resolution = resolution;
  entry.resolvedAt = nowIso();
  writeMetaProblems(filePath, data);
  return entry;
}

/**
 * Resolve the meta-problems file for a project directory.
 *
 * @param {string} projectDir
 * @returns {string}
 */
export function metaFileForProject(projectDir) {
  return path.join(path.resolve(projectDir), DEFAULT_META_FILE);
}
