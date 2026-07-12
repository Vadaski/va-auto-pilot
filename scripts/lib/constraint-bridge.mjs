import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { DEFAULT_LEARNED_CONSTRAINT_HALF_LIFE_DAYS } from "./constants.mjs";

const TYPE_ORDER = new Map([["boundary", 0], ["invariant", 1], ["prerequisite", 2], ["trade-off", 3], ["anti-pattern", 4]]);
const LEARNED_CONSTRAINT_STATUSES = new Set(["probation", "active", "retired"]);
const DEFAULT_MIN_LEARNED_CONFIDENCE = 0.35;
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
      ? { sourceFactorIds: item.sourceFactorIds.map((value) => normalizeFactorId(value)) }
      : {}),
  };
}

function normalizeFactorId(value) {
  const factorId = String(value ?? "").trim();
  return /^pf-\d+$/i.test(factorId) ? factorId.toUpperCase() : factorId;
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
  const origin = String(rawGovernance.origin ?? (legacyLearnedRule ? "pitfall" : "curated"));
  const status = String(rawGovernance.status ?? (origin === "pitfall" ? "probation" : "active")).toLowerCase();
  const feedback = rawGovernance.feedback && typeof rawGovernance.feedback === "object"
    ? rawGovernance.feedback
    : {};
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
      origin,
      status,
      learnedAt: String(rawGovernance.learnedAt ?? ""),
      lastValidatedAt: String(rawGovernance.lastValidatedAt ?? ""),
      halfLifeDays: Number.isFinite(Number(rawGovernance.halfLifeDays))
        ? Number(rawGovernance.halfLifeDays)
        : (origin === "pitfall" ? DEFAULT_LEARNED_CONSTRAINT_HALF_LIFE_DAYS : null),
      feedback: {
        effectiveCount: Math.max(0, Number.parseInt(String(feedback.effectiveCount ?? "0"), 10) || 0),
        ineffectiveCount: Math.max(0, Number.parseInt(String(feedback.ineffectiveCount ?? "0"), 10) || 0),
        lastOutcome: String(feedback.lastOutcome ?? ""),
        lastEvidence: String(feedback.lastEvidence ?? ""),
      },
      conflictsWith: Array.isArray(rawGovernance.conflictsWith)
        ? rawGovernance.conflictsWith.map(normalizeFactorId).filter(Boolean)
        : [],
    },
    raw: document,
  };
}

function constraintFactorIds(setRecord) {
  return new Set(setRecord.payload.constraints.flatMap((constraint) => constraint.sourceFactorIds ?? []));
}

function resolveNowMs(value) {
  if (value === undefined) return Date.now();
  if (value instanceof Date) return value.getTime();
  const numeric = typeof value === "number" ? value : Date.parse(String(value));
  return Number.isFinite(numeric) ? numeric : Date.now();
}

function applyLearnedDecay(setRecord, nowMs, minimumConfidence) {
  if (setRecord.governance.origin !== "pitfall" || setRecord.governance.status !== "active") {
    return { setRecord, decayed: false, reason: "" };
  }
  const halfLifeDays = setRecord.governance.halfLifeDays;
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) {
    return { setRecord, decayed: true, reason: "learned constraint has no valid half-life" };
  }
  const referenceMs = Date.parse(setRecord.governance.lastValidatedAt || setRecord.governance.learnedAt);
  if (!Number.isFinite(referenceMs)) {
    return { setRecord, decayed: true, reason: "learned constraint has no valid validation timestamp" };
  }
  const ageDays = Math.max(0, nowMs - referenceMs) / 86_400_000;
  const multiplier = 2 ** (-ageDays / halfLifeDays);
  const constraints = setRecord.payload.constraints.map((constraint) => ({
    ...constraint,
    confidence: constraint.confidence * multiplier,
  }));
  const strongestConfidence = Math.max(0, ...constraints.map((constraint) => constraint.confidence));
  if (strongestConfidence < minimumConfidence) {
    return {
      setRecord,
      decayed: true,
      reason: `learned constraint decayed below ${minimumConfidence.toFixed(2)} (effective confidence ${strongestConfidence.toFixed(2)})`,
    };
  }
  return {
    setRecord: {
      ...setRecord,
      payload: { ...setRecord.payload, constraints },
    },
    decayed: false,
    reason: "",
  };
}

function detectSelectedConflicts(setRecords) {
  const byFactorId = new Map();
  for (const setRecord of setRecords) {
    for (const factorId of constraintFactorIds(setRecord)) {
      const matches = byFactorId.get(factorId) ?? [];
      matches.push(setRecord);
      byFactorId.set(factorId, matches);
    }
  }
  const conflicts = new Map();
  for (const setRecord of setRecords) {
    for (const targetFactorId of setRecord.governance.conflictsWith) {
      for (const target of byFactorId.get(targetFactorId) ?? []) {
        if (target.id === setRecord.id) continue;
        const current = conflicts.get(setRecord.id) ?? new Set();
        current.add(targetFactorId);
        conflicts.set(setRecord.id, current);
        const reciprocal = conflicts.get(target.id) ?? new Set();
        for (const sourceFactorId of constraintFactorIds(setRecord)) reciprocal.add(sourceFactorId);
        conflicts.set(target.id, reciprocal);
      }
    }
  }
  return conflicts;
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
 * @param {{ maxFactors?: number, signal?: AbortSignal, configEnabled?: boolean, configPath?: string, constraintsDir?: string, includeAllWhenUnmatched?: boolean, now?: Date|string|number, minLearnedConfidence?: number }} [options]
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
    const minimumConfidence = Number.isFinite(Number(options.minLearnedConfidence))
      ? Number(options.minLearnedConfidence)
      : DEFAULT_MIN_LEARNED_CONFIDENCE;
    const eligible = [];
    const suppressed = [];
    for (const setRecord of selected) {
      const status = setRecord.governance.status;
      if (!LEARNED_CONSTRAINT_STATUSES.has(status) || status !== "active") {
        suppressed.push({
          id: setRecord.id,
          reason: `constraint set status is ${status || "unknown"}`,
          origin: setRecord.governance.origin,
        });
        continue;
      }
      const decayed = applyLearnedDecay(setRecord, resolveNowMs(options.now), minimumConfidence);
      if (decayed.decayed) {
        suppressed.push({ id: setRecord.id, reason: decayed.reason, origin: setRecord.governance.origin });
        continue;
      }
      eligible.push(decayed.setRecord);
    }
    const conflicts = detectSelectedConflicts(eligible);
    const active = eligible.filter((setRecord) => {
      const targets = conflicts.get(setRecord.id);
      if (!targets || targets.size === 0) return true;
      suppressed.push({
        id: setRecord.id,
        reason: `constraint conflicts with ${[...targets].sort().join(", ")}`,
        origin: setRecord.governance.origin,
      });
      return false;
    });
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
