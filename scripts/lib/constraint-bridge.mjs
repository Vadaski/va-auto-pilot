import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";

const TYPE_ORDER = new Map([["boundary", 0], ["invariant", 1], ["prerequisite", 2], ["trade-off", 3], ["anti-pattern", 4]]);
const DEFAULT_CONFIG = path.resolve(process.cwd(), ".va-auto-pilot/config.yaml");
const SKIPPED_SOURCE = /** @type {"skipped"} */ ("skipped");
const YAML_SOURCE = /** @type {"yaml"} */ ("yaml");

function isTruthy(value) {
  return /^(1|true|on|yes)$/i.test(String(value ?? "").trim());
}

function shortError(error) {
  return String(error?.message ?? error ?? "unknown error").split("\n")[0].trim() || "unknown error";
}

function readConstraintInjectionConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return false;
    const parsed = parseYaml(fs.readFileSync(configPath, "utf8"));
    return Boolean(parsed?.constraintInjection?.enabled === true || isTruthy(parsed?.constraintInjection?.enabled));
  } catch {
    return false;
  }
}

function isEnabled(options) {
  if (isTruthy(process.env.VA_AUTO_PILOT_CONSTRAINTS)) return true;
  if (typeof options.configEnabled === "boolean") return options.configEnabled;
  return readConstraintInjectionConfig(options.configPath ?? DEFAULT_CONFIG);
}

function emptyResult(durationMs, error) {
  return {
    engineAvailable: false,
    constraints: [],
    blindSpots: [],
    suppressed: [],
    diagnostics: [],
    durationMs,
    source: SKIPPED_SOURCE,
    ...(error ? { error } : {}),
  };
}

function resolveProjectRoot(configPath) {
  const initialDir = path.dirname(path.resolve(configPath ?? DEFAULT_CONFIG));
  let current = initialDir;
  while (true) {
    if (path.basename(current) === ".va-auto-pilot") return path.dirname(current);
    const parent = path.dirname(current);
    if (parent === current) return initialDir;
    current = parent;
  }
}

function resolveConstraintsDir(options) {
  return options.constraintsDir
    ? path.resolve(options.constraintsDir)
    : path.join(resolveProjectRoot(options.configPath), ".va-auto-pilot", "constraints");
}

function normalizeConstraint(item) {
  const statement = String(item?.statement ?? "").trim();
  const type = String(item?.type ?? "").trim();
  if (!statement || !TYPE_ORDER.has(type)) return null;
  const confidence = Number(item?.confidence);
  return {
    statement,
    type,
    confidence: Number.isFinite(confidence) ? confidence : 0,
    ...(Array.isArray(item?.sourceFactorIds) && item.sourceFactorIds.length > 0
      ? { sourceFactorIds: item.sourceFactorIds.map((value) => String(value)) }
      : {}),
  };
}

function normalizeConstraintSet(document, filePath) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new Error(`${path.basename(filePath)} must contain a YAML object`);
  }
  if (String(document.type ?? "").trim() !== "auto-pilot-constraint-set") {
    throw new Error(`${path.basename(filePath)} has unsupported type`);
  }
  const payload = document.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`${path.basename(filePath)} is missing a payload object`);
  }
  const blindSpots = Array.isArray(payload.blindSpots)
    ? payload.blindSpots.map((item) => String(item).trim()).filter(Boolean)
    : [];
  const legacyLearnedRule = blindSpots.some((item) => item.toLowerCase() === "auto-generated-from-pitfall");
  const rawGovernance = document.governance && typeof document.governance === "object"
    ? document.governance
    : {};
  const status = String(rawGovernance.status ?? (legacyLearnedRule ? "probation" : "active")).toLowerCase();
  return {
    id: String(document.id ?? "").trim(),
    type: "auto-pilot-constraint-set",
    payload: {
      domain: String(payload.domain ?? "").trim(),
      tags: Array.isArray(payload.tags) ? payload.tags.map((item) => String(item).trim()).filter(Boolean) : [],
      synthesis: typeof payload.synthesis === "string" ? payload.synthesis.trim() : "",
      constraints: (Array.isArray(payload.constraints) ? payload.constraints : []).map(normalizeConstraint).filter(Boolean),
      blindSpots,
    },
    governance: {
      origin: String(rawGovernance.origin ?? (legacyLearnedRule ? "pitfall" : "curated")),
      status,
      learnedAt: String(rawGovernance.learnedAt ?? ""),
      halfLifeDays: Number.isFinite(Number(rawGovernance.halfLifeDays))
        ? Number(rawGovernance.halfLifeDays)
        : null,
    },
    raw: document,
  };
}

function loadConstraintSets(constraintsDir) {
  if (!fs.existsSync(constraintsDir) || !fs.statSync(constraintsDir).isDirectory()) return { loaded: [], errors: [] };
  const loaded = [];
  const errors = [];
  const files = fs.readdirSync(constraintsDir).filter((name) => /\.ya?ml$/i.test(name)).sort((a, b) => a.localeCompare(b));
  for (const name of files) {
    const filePath = path.join(constraintsDir, name);
    try {
      // PoC fallback: parse YAML directly because va-constraint is not a repo dep here.
      loaded.push(normalizeConstraintSet(parseYaml(fs.readFileSync(filePath, "utf8")), filePath));
    } catch (error) {
      errors.push(shortError(error));
    }
  }
  return { loaded, errors };
}

const QUERY_STOP_WORDS = new Set([
  "add", "build", "change", "create", "fix", "implement", "improve", "make", "task", "update", "use",
]);
const WORD_SEGMENTER = new Intl.Segmenter("und", { granularity: "word" });

/** @returns {string[]} */
function textTokens(value) {
  const tokens = Array.from(WORD_SEGMENTER.segment(String(value ?? "").toLowerCase()))
    .filter((entry) => entry.isWordLike)
    .map((entry) => entry.segment);
  return [...new Set(tokens.filter((token) => token.length > 1 && !QUERY_STOP_WORDS.has(token)))];
}

function matchesQuery(setRecord, queryTokens) {
  if (queryTokens.length === 0) return false;
  const query = new Set(queryTokens);
  const identityTokens = textTokens([
    setRecord.id,
    setRecord.payload.domain,
    ...setRecord.payload.tags,
  ].join(" "));
  if (identityTokens.some((token) => query.has(token))) return true;
  return setRecord.payload.constraints.some((constraint) => {
    const overlap = textTokens(constraint.statement).filter((token) => query.has(token));
    return new Set(overlap).size >= 2;
  });
}

function compareConstraints(left, right) {
  const typeDelta = TYPE_ORDER.get(left.type) - TYPE_ORDER.get(right.type);
  if (typeDelta !== 0) return typeDelta;
  const confidenceDelta = right.confidence - left.confidence;
  return confidenceDelta !== 0 ? confidenceDelta : left.statement.localeCompare(right.statement);
}

function dedupeConstraints(sets, maxFactors) {
  const deduped = new Map();
  for (const setRecord of sets) {
    for (const constraint of setRecord.payload.constraints) {
      const key = constraint.statement.toLowerCase();
      const previous = deduped.get(key);
      if (!previous || compareConstraints(constraint, previous) < 0) deduped.set(key, constraint);
    }
  }
  return [...deduped.values()].sort(compareConstraints).slice(0, maxFactors);
}

function mergeBlindSpots(sets, maxBlindSpots) {
  const seen = new Set();
  const blindSpots = [];
  for (const setRecord of sets) {
    for (const blindSpot of setRecord.payload.blindSpots) {
      const key = blindSpot.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      blindSpots.push(blindSpot);
    }
  }
  return blindSpots.slice(0, maxBlindSpots);
}

/**
 * @typedef {Object} TypedConstraint
 * @property {string} statement
 * @property {"boundary"|"invariant"|"trade-off"|"prerequisite"|"anti-pattern"} type
 * @property {number} confidence
 * @property {string[]=} sourceFactorIds
 */

/**
 * @param {string} query
 * @param {{ maxFactors?: number, signal?: AbortSignal, configEnabled?: boolean, configPath?: string, constraintsDir?: string, includeAllWhenUnmatched?: boolean }} [options]
 * @returns {Promise<{
 *   engineAvailable: boolean,
 *   constraints: TypedConstraint[],
 *   blindSpots: string[],
 *   suppressed: Array<{ id: string, reason: string, origin: string }>,
 *   diagnostics: string[],
 *   synthesis?: string,
 *   durationMs: number,
 *   error?: string,
 *   source: "yaml"|"skipped"
 * }>}
 */
export async function collectConstraints(query, options = {}) {
  if (!isEnabled(options)) return emptyResult(0);
  const startedAt = Date.now();
  const maxFactors = Number.isFinite(Number(options.maxFactors)) ? Number(options.maxFactors) : 5;
  try {
    const { loaded, errors } = loadConstraintSets(resolveConstraintsDir(options));
    if (loaded.length === 0) {
      const reason = errors.length > 0 ? errors.join("; ") : undefined;
      if (reason) process.stderr.write(`[constraint-bridge] skipped: ${reason}\n`);
      return emptyResult(Date.now() - startedAt, reason);
    }
    const matched = loaded.filter((setRecord) => matchesQuery(setRecord, textTokens(query)));
    const selected = matched.length > 0 ? matched : (options.includeAllWhenUnmatched ? [loaded[0]] : []);
    const active = selected.filter((setRecord) => setRecord.governance.status === "active");
    const suppressed = selected
      .filter((setRecord) => setRecord.governance.status !== "active")
      .map((setRecord) => ({
        id: setRecord.id,
        reason: `constraint set status is ${setRecord.governance.status || "unknown"}`,
        origin: setRecord.governance.origin,
      }));
    return {
      engineAvailable: true,
      constraints: dedupeConstraints(active, maxFactors),
      blindSpots: mergeBlindSpots(active, maxFactors),
      suppressed,
      diagnostics: suppressed.map((item) => `${item.id}: ${item.reason}`),
      synthesis: active.find((setRecord) => setRecord.payload.synthesis)?.payload.synthesis ?? "",
      durationMs: Date.now() - startedAt,
      source: YAML_SOURCE,
    };
  } catch (error) {
    const reason = shortError(error);
    process.stderr.write(`[constraint-bridge] skipped: ${reason}\n`);
    return emptyResult(Date.now() - startedAt, reason);
  }
}

/**
 * @param {{ constraints?: TypedConstraint[], blindSpots?: string[], synthesis?: string }} result
 * @returns {string}
 */
export function formatConstraintsForPrompt(result = {}) {
  const constraints = (Array.isArray(result.constraints) ? result.constraints : []).map(normalizeConstraint).filter(Boolean).sort(compareConstraints);
  const blindSpots = Array.isArray(result.blindSpots) ? result.blindSpots.map((value) => String(value).trim()).filter(Boolean) : [];
  const synthesis = typeof result.synthesis === "string" ? result.synthesis.trim() : "";
  if (constraints.length === 0 && blindSpots.length === 0 && !synthesis) return "";
  const sections = [];
  if (constraints.length > 0 || synthesis) {
    const lines = ["## Constraints (hard rules first)"];
    if (synthesis) lines.push(`Synthesis: ${synthesis}`);
    constraints.forEach((constraint) => {
      const detail = [`confidence ${constraint.confidence.toFixed(2)}`];
      if (constraint.sourceFactorIds?.length) detail.push(`sources: ${constraint.sourceFactorIds.join(", ")}`);
      lines.push(`- [${constraint.type}] ${constraint.statement} (${detail.join("; ")})`);
    });
    sections.push(lines.join("\n"));
  }
  if (blindSpots.length > 0) {
    sections.push(["## Blind spots (not covered — use judgment)", ...blindSpots.map((item) => `- ${item}`)].join("\n"));
  }
  return sections.join("\n\n");
}
