import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

import { withPilotFileLock, writeTextFileAtomicSync } from "./pilot-state.mjs";

export const OBSERVABILITY_SCHEMA_VERSION = 1;

export const EVENT_TYPES = Object.freeze([
  "run.lifecycle",
  "plan.reviewed",
  "plan.approved",
  "checkpoint.stale",
  "dispatch.queued",
  "task.started",
  "task.command",
  "task.gate",
  "task.review",
  "task.completed",
  "task.failed",
  "intervention",
  "commit",
  "journal",
  "run.closed",
]);

export const BUNDLE_TYPES = Object.freeze(["task", "run"]);
export const BUNDLE_STATES = Object.freeze(["open", "completed", "failed", "abandoned"]);
export const OUTCOME_STATES = Object.freeze(["completed", "failed", "abandoned"]);
export const PROVENANCE_SOURCES = Object.freeze([
  "auto-pilot-orchestrate",
  "auto-pilot-loop",
  "worker",
  "manual",
]);

const TEXT_KIND_SUFFIXES = new Set([
  ".log",
  ".txt",
  ".json",
  ".jsonl",
  ".md",
  ".patch",
  ".yaml",
  ".yml",
]);

export const DEFAULT_REDACTION_RULES = Object.freeze([
  {
    name: "env-secrets",
    pattern: /^(.*(?:SECRET|_TOKEN|PASSWORD|API_KEY|ACCESS_KEY)\s*[:=]\s*).+$/gim,
    replacement: "$1[REDACTED:env-secrets]",
  },
  {
    name: "auth-headers",
    pattern: /((?:Authorization|Bearer|Basic)\s*[:\s]+)(Bearer\s+)?\S+/gi,
    replacement: "$1$2[REDACTED:auth-headers]",
  },
  {
    name: "paths",
  },
]);

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function resolveEvidenceDir(workDir = process.cwd()) {
  return path.resolve(workDir, ".va-auto-pilot", "evidence");
}

export function observabilityPaths(workDir = process.cwd()) {
  const evidenceDir = resolveEvidenceDir(workDir);
  return {
    evidenceDir,
    eventsLog: path.join(evidenceDir, "events.jsonl"),
    bundlesDir: evidenceDir,
    redactedShareableDir: path.join(evidenceDir, "redacted"),
  };
}

export function taskEvidenceBundleDir(workDir, runId, taskId) {
  return path.resolve(resolveEvidenceDir(workDir), runId ?? "unknown", taskId ?? "unknown");
}

export function taskEvidenceBundlePaths(workDir, runId, taskId) {
  const dir = taskEvidenceBundleDir(workDir, runId, taskId);
  return {
    dir,
    manifest: path.join(dir, "manifest.json"),
    eventsLog: path.join(dir, "events.jsonl"),
    artifactsDir: path.join(dir, "artifacts"),
    findingsDir: path.join(dir, "findings"),
    redactedDir: path.join(dir, "redacted"),
    redactedManifest: path.join(dir, "redacted", "manifest.json"),
  };
}

export function createEventId() {
  return `evt-${crypto.randomUUID()}`;
}

export function createBundleId() {
  return `bnd-${crypto.randomUUID().slice(0, 8)}`;
}

export function hashText(text) {
  return crypto.createHash("sha256").update(String(text ?? ""), "utf8").digest("hex");
}

export function buildEvent({ eventType, runId, taskId, phase, payload, provenance }) {
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    eventType,
    eventId: createEventId(),
    runId,
    taskId: taskId ?? undefined,
    phase: phase ?? undefined,
    timestamp: new Date().toISOString(),
    payload: payload ?? {},
    provenance: {
      source: provenance?.source ?? "manual",
      host: provenance?.host ?? os.hostname(),
      pid: provenance?.pid ?? process.pid,
    },
    redaction: {
      applied: false,
      rules: [],
      fieldsRemoved: [],
    },
  };
}

export function validateEvent(event) {
  const errors = [];
  if (event?.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${OBSERVABILITY_SCHEMA_VERSION}`);
  }
  if (!EVENT_TYPES.includes(event?.eventType)) {
    errors.push(`eventType must be one of ${EVENT_TYPES.join(", ")}`);
  }
  if (!isNonEmptyString(event?.eventId)) {
    errors.push("eventId is required");
  }
  if (!isNonEmptyString(event?.runId)) {
    errors.push("runId is required");
  }
  if (Number.isNaN(Date.parse(event?.timestamp ?? ""))) {
    errors.push("timestamp must be a parseable ISO-8601 string");
  }
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    errors.push("payload must be an object");
  }
  if (!PROVENANCE_SOURCES.includes(event?.provenance?.source)) {
    errors.push(`provenance.source must be one of ${PROVENANCE_SOURCES.join(", ")}`);
  }
  if (typeof event?.redaction?.applied !== "boolean") {
    errors.push("redaction.applied must be a boolean");
  }
  return { ok: errors.length === 0, errors };
}

function isTextArtifact(artifactName) {
  const ext = path.extname(artifactName).toLowerCase();
  return TEXT_KIND_SUFFIXES.has(ext);
}

export function redactText(text, rules = DEFAULT_REDACTION_RULES) {
  let redacted = String(text ?? "");
  let count = 0;
  const appliedRules = [];

  for (const rule of rules) {
    const before = redacted;
    if (rule.name === "paths") {
      const home = os.homedir();
      if (home && home !== "/") {
        redacted = redacted.replaceAll(home, "~");
      }
    } else {
      redacted = redacted.replace(rule.pattern, rule.replacement);
    }
    if (redacted !== before) {
      appliedRules.push(rule.name);
      count += 1;
    }
  }

  return { text: redacted, applied: count > 0, count, rules: appliedRules };
}

function redactValue(value, rules, pathPrefix, removed) {
  if (typeof value === "string") {
    const result = redactText(value, rules);
    if (result.applied) {
      removed.push(pathPrefix);
    }
    return result.text;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactValue(item, rules, `${pathPrefix}[${index}]`, removed));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = redactValue(child, rules, pathPrefix ? `${pathPrefix}.${key}` : key, removed);
    }
    return out;
  }
  return value;
}

export function redactEvent(event, rules = DEFAULT_REDACTION_RULES) {
  const removed = [];
  const redactedPayload = redactValue(event?.payload, rules, "payload", removed);
  return {
    ...event,
    payload: redactedPayload,
    redaction: {
      applied: removed.length > 0,
      rules: removed.length > 0 ? [...new Set(rules.map((r) => r.name))] : [],
      fieldsRemoved: removed,
    },
  };
}

export async function appendEventLog(logFile, event) {
  fs.mkdirSync(path.dirname(path.resolve(logFile)), { recursive: true });
  const line = `${JSON.stringify(event)}\n`;
  await withPilotFileLock(logFile, async () => {
    const existing = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    writeTextFileAtomicSync(logFile, `${existing}${line}`);
  });
}

export function readEventLog(logFile) {
  if (!fs.existsSync(logFile)) {
    return [];
  }
  const content = fs.readFileSync(logFile, "utf8");
  const events = [];
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    try {
      events.push(JSON.parse(trimmed));
    } catch {
      // Skip corrupt lines; append-only logs should not lose the whole stream.
    }
  }
  return events;
}

export function buildBundleManifest({
  bundleType,
  runId,
  taskId,
  state,
  outcome,
  timeline,
  artifacts,
  gates,
  review = null,
  eventsLog,
  redactedShareable,
}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
    bundleId: createBundleId(),
    bundleType,
    runId,
    taskId: taskId ?? undefined,
    state,
    outcome: outcome ?? { state },
    createdAt: now,
    updatedAt: now,
    timeline: timeline ?? [],
    artifacts: artifacts ?? [],
    gates: gates ?? [],
    review: review ?? undefined,
    eventsLog: eventsLog ?? "events.jsonl",
    redactedShareable: redactedShareable ?? "redacted/manifest.json",
  };
}

function validateArtifact(artifact, index) {
  const errors = [];
  const prefix = `artifacts[${index}]`;
  for (const key of ["name", "path", "kind", "sha256"]) {
    if (!isNonEmptyString(artifact?.[key])) {
      errors.push(`${prefix}.${key} is required`);
    }
  }
  if (typeof artifact?.sizeBytes !== "number" || artifact.sizeBytes < 0 || !Number.isInteger(artifact.sizeBytes)) {
    errors.push(`${prefix}.sizeBytes must be a non-negative integer`);
  }
  if (typeof artifact?.redacted !== "boolean") {
    errors.push(`${prefix}.redacted must be a boolean`);
  }
  return errors;
}

function validateGate(gate, index) {
  const errors = [];
  const prefix = `gates[${index}]`;
  if (!isNonEmptyString(gate?.name)) {
    errors.push(`${prefix}.name is required`);
  }
  for (const key of ["required", "passed"]) {
    if (typeof gate?.[key] !== "boolean") {
      errors.push(`${prefix}.${key} must be a boolean`);
    }
  }
  if (typeof gate?.exitCode !== "number" || !Number.isInteger(gate.exitCode)) {
    errors.push(`${prefix}.exitCode must be an integer`);
  }
  if (typeof gate?.durationMs !== "number" || gate.durationMs < 0 || !Number.isInteger(gate.durationMs)) {
    errors.push(`${prefix}.durationMs must be a non-negative integer`);
  }
  return errors;
}

function validateTimelineEntry(entry, index) {
  const errors = [];
  const prefix = `timeline[${index}]`;
  if (Number.isNaN(Date.parse(entry?.at ?? ""))) {
    errors.push(`${prefix}.at must be a parseable ISO-8601 string`);
  }
  for (const key of ["phase", "eventId", "note"]) {
    if (!isNonEmptyString(entry?.[key])) {
      errors.push(`${prefix}.${key} is required`);
    }
  }
  return errors;
}

export function validateBundleManifest(manifest) {
  const errors = [];
  if (manifest?.schemaVersion !== OBSERVABILITY_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${OBSERVABILITY_SCHEMA_VERSION}`);
  }
  if (!isNonEmptyString(manifest?.bundleId)) {
    errors.push("bundleId is required");
  }
  if (!BUNDLE_TYPES.includes(manifest?.bundleType)) {
    errors.push(`bundleType must be one of ${BUNDLE_TYPES.join(", ")}`);
  }
  if (!isNonEmptyString(manifest?.runId)) {
    errors.push("runId is required");
  }
  if (manifest?.bundleType === "task" && !isNonEmptyString(manifest?.taskId)) {
    errors.push("taskId is required for task bundles");
  }
  if (!BUNDLE_STATES.includes(manifest?.state)) {
    errors.push(`state must be one of ${BUNDLE_STATES.join(", ")}`);
  }
  if (!OUTCOME_STATES.includes(manifest?.outcome?.state)) {
    errors.push(`outcome.state must be one of ${OUTCOME_STATES.join(", ")}`);
  }
  if (Number.isNaN(Date.parse(manifest?.createdAt ?? ""))) {
    errors.push("createdAt must be a parseable ISO-8601 string");
  }
  if (Number.isNaN(Date.parse(manifest?.updatedAt ?? ""))) {
    errors.push("updatedAt must be a parseable ISO-8601 string");
  }
  if (!Array.isArray(manifest?.timeline)) {
    errors.push("timeline must be an array");
  } else {
    manifest.timeline.forEach((entry, index) => errors.push(...validateTimelineEntry(entry, index)));
  }
  if (!Array.isArray(manifest?.artifacts)) {
    errors.push("artifacts must be an array");
  } else {
    manifest.artifacts.forEach((artifact, index) => errors.push(...validateArtifact(artifact, index)));
  }
  if (!Array.isArray(manifest?.gates)) {
    errors.push("gates must be an array");
  } else {
    manifest.gates.forEach((gate, index) => errors.push(...validateGate(gate, index)));
  }
  if (manifest?.review) {
    if (!isNonEmptyString(manifest.review.findingsIndexArtifact)) {
      errors.push("review.findingsIndexArtifact is required when review is present");
    }
    for (const key of ["criticalCount", "warningCount"]) {
      if (typeof manifest.review[key] !== "number" || manifest.review[key] < 0 || !Number.isInteger(manifest.review[key])) {
        errors.push(`review.${key} must be a non-negative integer`);
      }
    }
  }
  if (!isNonEmptyString(manifest?.eventsLog)) {
    errors.push("eventsLog is required");
  }
  if (!isNonEmptyString(manifest?.redactedShareable)) {
    errors.push("redactedShareable is required");
  }
  return { ok: errors.length === 0, errors };
}

export function writeBundleManifest(manifestPath, manifest) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeTextFileAtomicSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function ensureBundleDirs(bundleDir) {
  fs.mkdirSync(path.join(bundleDir, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(bundleDir, "findings"), { recursive: true });
}

export function writeArtifact(artifactPath, content) {
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  writeTextFileAtomicSync(artifactPath, content);
}

export function redactBundle(bundleDir, rules = DEFAULT_REDACTION_RULES) {
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Bundle manifest not found: ${manifestPath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const redactedDir = path.join(bundleDir, "redacted");
  fs.mkdirSync(path.join(redactedDir, "artifacts"), { recursive: true });
  fs.mkdirSync(path.join(redactedDir, "findings"), { recursive: true });

  const redactedArtifacts = [];
  for (const artifact of manifest.artifacts ?? []) {
    const sourcePath = path.join(bundleDir, artifact.path);
    const redactedPath = path.join(redactedDir, artifact.path);
    let sizeBytes = artifact.sizeBytes;
    let sha256 = artifact.sha256;
    let redacted = artifact.redacted;

    if (isTextArtifact(artifact.name) && fs.existsSync(sourcePath)) {
      const raw = fs.readFileSync(sourcePath, "utf8");
      const result = redactText(raw, rules);
      if (result.applied) {
        writeTextFileAtomicSync(redactedPath, result.text);
        sizeBytes = Buffer.byteLength(result.text, "utf8");
        sha256 = hashText(result.text);
        redacted = true;
      } else {
        writeTextFileAtomicSync(redactedPath, raw);
      }
    }

    redactedArtifacts.push({
      ...artifact,
      path: path.relative(redactedDir, redactedPath),
      sizeBytes,
      sha256,
      redacted,
    });
  }

  const redactedManifest = {
    ...manifest,
    bundleId: `${manifest.bundleId}-redacted`,
    artifacts: redactedArtifacts,
    eventsLog: manifest.eventsLog,
    redactedShareable: "manifest.json",
  };
  writeBundleManifest(path.join(redactedDir, "manifest.json"), redactedManifest);

  const updatedManifest = {
    ...manifest,
    redactedShareable: "redacted/manifest.json",
  };
  writeBundleManifest(manifestPath, updatedManifest);

  return { redactedDir, redactedManifest, updatedManifest };
}
