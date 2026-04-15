import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const SDK_IMPORT_SPEC = "va-tool-collision-engine";
const LOCAL_CLI_PATH = "/Users/vadaski/vadaski/Code/va-tool-collision-engine/dist/constraint-graph/cli.js";
const TYPE_ORDER = new Map([
  ["boundary", 0],
  ["invariant", 1],
  ["prerequisite", 2],
  ["trade-off", 3],
  ["anti-pattern", 4],
]);

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
  if (isTruthy(process.env.VA_AUTO_PILOT_CONSTRAINTS)) {
    return true;
  }
  if (typeof options.configEnabled === "boolean") {
    return options.configEnabled;
  }
  const configPath = options.configPath ?? path.resolve(process.cwd(), ".va-auto-pilot/config.yaml");
  return readConstraintInjectionConfig(configPath);
}

function emptyResult(durationMs, error) {
  return {
    engineAvailable: false,
    constraints: [],
    blindSpots: [],
    durationMs,
    ...(error ? { error } : {}),
  };
}

function normalizeConstraint(item) {
  const statement = String(item?.statement ?? "").trim();
  const type = String(item?.type ?? "").trim();
  if (!statement || !TYPE_ORDER.has(type)) {
    return null;
  }
  return {
    statement,
    type,
    confidence: Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : 0,
    ...(Array.isArray(item?.sourceFactorIds) && item.sourceFactorIds.length > 0
      ? { sourceFactorIds: item.sourceFactorIds.map((value) => String(value)) }
      : {}),
  };
}

function normalizePayload(payload) {
  const constraints = (Array.isArray(payload?.constraints) ? payload.constraints : [])
    .map(normalizeConstraint)
    .filter(Boolean);
  return {
    constraints,
    blindSpots: Array.isArray(payload?.blindSpots)
      ? payload.blindSpots.map((value) => String(value).trim()).filter(Boolean)
      : [],
    synthesis: typeof payload?.synthesis === "string" ? payload.synthesis.trim() : "",
  };
}

async function withTimeout(task, signal, timeoutMs) {
  let timeoutId = null;
  let abortListener = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  const abortPromise = signal
    ? new Promise((_, reject) => {
      abortListener = () => reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
      signal.addEventListener("abort", abortListener, { once: true });
    })
    : null;
  try {
    return await Promise.race([task(), timeoutPromise, ...(abortPromise ? [abortPromise] : [])]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (signal && abortListener) signal.removeEventListener("abort", abortListener);
  }
}

async function queryViaSdk(query, maxFactors, options, signal) {
  const loadSdk = options.sdkLoader ?? (() => import(SDK_IMPORT_SPEC));
  const mod = await loadSdk();
  if (typeof mod?.CollisionEngineTool !== "function") {
    throw new Error(`${SDK_IMPORT_SPEC} missing CollisionEngineTool export`);
  }
  const tool = new mod.CollisionEngineTool({
    storageDir: process.env.COLLISION_STORAGE_DIR,
  });
  const response = await withTimeout(
    () => tool.execute("constraint_query", { query, maxFactors }),
    signal,
    15_000,
  );
  if (!response?.success) {
    throw new Error(response?.error ?? "constraint_query failed");
  }
  return normalizePayload(response?.data ?? response);
}

async function queryViaCli(query, maxFactors, options, signal) {
  if (typeof options.cliInvoker === "function") {
    return normalizePayload(await withTimeout(() => options.cliInvoker({ query, maxFactors, signal }), signal, 15_000));
  }
  const cliPath = options.cliPath ?? (fs.existsSync(LOCAL_CLI_PATH) ? LOCAL_CLI_PATH : "");
  if (!cliPath && !options.cliCommand) {
    throw new Error("va-constraint CLI unavailable");
  }
  const command = options.cliCommand ?? process.execPath;
  const args = options.cliCommand
    ? ["query", query, "--limit", String(maxFactors), "--output", "json"]
    : [cliPath, "query", query, "--limit", String(maxFactors), "--output", "json"];
  const env = process.env.VA_CONSTRAINT_GRAPH_ROOT
    ? { ...process.env, VA_CONSTRAINT_GRAPH_ROOT: process.env.VA_CONSTRAINT_GRAPH_ROOT }
    : process.env;
  const { stdout } = await execFileAsync(command, args, {
    encoding: "utf8",
    env,
    signal,
    timeout: 15_000,
  });
  return normalizePayload(JSON.parse(stdout));
}

/**
 * Primary path is the in-process SDK import; if the package is not installed or
 * the tool is not configured, fall back to the read-only va-constraint CLI.
 *
 * @typedef {Object} TypedConstraint
 * @property {string} statement
 * @property {"boundary"|"invariant"|"trade-off"|"prerequisite"|"anti-pattern"} type
 * @property {number} confidence
 * @property {string[]=} sourceFactorIds
 */

/**
 * @param {string} query
 * @param {{ maxFactors?: number, signal?: AbortSignal, configEnabled?: boolean, configPath?: string, sdkLoader?: () => Promise<any>, cliInvoker?: Function, cliPath?: string, cliCommand?: string }} [options]
 * @returns {Promise<{ engineAvailable: boolean, constraints: TypedConstraint[], blindSpots: string[], synthesis?: string, durationMs: number, error?: string }>}
 */
export async function collectConstraints(query, options = {}) {
  if (!isEnabled(options)) {
    return emptyResult(0);
  }

  const startedAt = Date.now();
  const maxFactors = Number.isFinite(Number(options.maxFactors)) ? Number(options.maxFactors) : 5;
  const failures = [];

  try {
    const payload = await queryViaSdk(query, maxFactors, options, options.signal);
    return { engineAvailable: true, ...payload, durationMs: Date.now() - startedAt };
  } catch (error) {
    failures.push(shortError(error));
  }

  try {
    const payload = await queryViaCli(query, maxFactors, options, options.signal);
    return { engineAvailable: true, ...payload, durationMs: Date.now() - startedAt };
  } catch (error) {
    failures.push(shortError(error));
  }

  const reason = failures.filter(Boolean).join("; ");
  process.stderr.write(`[constraint-bridge] skipped: ${reason}\n`);
  return emptyResult(Date.now() - startedAt, reason);
}

/**
 * @param {{ constraints?: TypedConstraint[], blindSpots?: string[], synthesis?: string }} result
 * @returns {string}
 */
export function formatConstraintsForPrompt(result = {}) {
  const constraints = (Array.isArray(result.constraints) ? result.constraints : [])
    .map(normalizeConstraint)
    .filter(Boolean)
    .sort((left, right) => TYPE_ORDER.get(left.type) - TYPE_ORDER.get(right.type));
  const blindSpots = Array.isArray(result.blindSpots)
    ? result.blindSpots.map((value) => String(value).trim()).filter(Boolean)
    : [];
  const synthesis = typeof result.synthesis === "string" ? result.synthesis.trim() : "";
  if (constraints.length === 0 && blindSpots.length === 0 && !synthesis) {
    return "";
  }

  const sections = [];
  if (constraints.length > 0 || synthesis) {
    const lines = ["## Constraints (hard rules first)"];
    if (synthesis) lines.push(`Synthesis: ${synthesis}`);
    constraints.forEach((constraint) => {
      const detail = [`confidence ${constraint.confidence.toFixed(2)}`];
      if (constraint.sourceFactorIds?.length) {
        detail.push(`sources: ${constraint.sourceFactorIds.join(", ")}`);
      }
      lines.push(`- [${constraint.type}] ${constraint.statement} (${detail.join("; ")})`);
    });
    sections.push(lines.join("\n"));
  }
  if (blindSpots.length > 0) {
    sections.push([
      "## Blind spots (not covered — use judgment)",
      ...blindSpots.map((item) => `- ${item}`),
    ].join("\n"));
  }
  return sections.join("\n\n");
}
