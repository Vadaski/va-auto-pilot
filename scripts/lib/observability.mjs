import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

import { assertSafeRunId, assertSafeTaskId } from "./identifiers.mjs";
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
    name: "private-keys",
    pattern: /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    replacement: "[REDACTED:private-keys]",
  },
  {
    name: "cookie-headers",
    pattern: /(\b(?:set-cookie|cookie)\s*:\s*)[^\r\n]+/gi,
    replacement: "$1[REDACTED:cookie-headers]",
  },
  {
    name: "auth-headers",
    pattern: /(\b(?:proxy-)?authorization\s*:\s*)(?:(?:bearer|basic|token)\s+)?[A-Za-z0-9._~+/=-]+/gi,
    replacement: "$1[REDACTED:auth-headers]",
  },
  {
    name: "bearer-tokens",
    pattern: /(\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi,
    replacement: "$1[REDACTED:bearer-tokens]",
  },
  {
    name: "quoted-secrets",
    pattern: /((?:["']?(?:[A-Za-z][A-Za-z0-9_.-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|password|passwd|passphrase|client[_-]?secret|webhook[_-]?secret|private[_-]?key|secret|token)["']?)\s*[:=]\s*)(["'])(.*?)\2/gi,
    replacement: "$1$2[REDACTED:quoted-secrets]$2",
  },
  {
    name: "assigned-secrets",
    pattern: /(\b(?:[A-Za-z][A-Za-z0-9_.-]*[_-])?(?:api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|password|passwd|passphrase|client[_-]?secret|webhook[_-]?secret|private[_-]?key|secret|token)\s*[:=]\s*)(?!\[REDACTED:)[^\s,"';}\]]+/gi,
    replacement: "$1[REDACTED:assigned-secrets]",
  },
  {
    name: "secret-flags",
    pattern: /(^|\s)(--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|password|passphrase|client[-_]?secret|secret|token)(?:=|\s+))(?!\[REDACTED:)[^\s,"';}\]]+/gim,
    replacement: "$1$2[REDACTED:secret-flags]",
  },
  {
    name: "provider-tokens",
    pattern: /\b(?:sk-(?:ant|proj|svcacct)-[A-Za-z0-9_-]{8,}|sk-[A-Za-z0-9_-]{32,}|sk_live_[A-Za-z0-9]{8,}|github_pat_[A-Za-z0-9_]{8,}|gh[pousr]_[A-Za-z0-9]{8,}|xox[baprs]-[A-Za-z0-9-]{8,}|npm_[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
    replacement: "[REDACTED:provider-tokens]",
  },
  {
    name: "jwt-tokens",
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g,
    replacement: "[REDACTED:jwt-tokens]",
  },
  {
    name: "url-credentials",
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    replacement: "$1[REDACTED:url-credentials]$2",
  },
  {
    name: "paths",
  },
]);

export const PERSISTENCE_REDACTION_RULES = Object.freeze(
  DEFAULT_REDACTION_RULES.filter((rule) => rule.name !== "paths")
);

const SENSITIVE_FIELD_NAMES = new Set([
  "authorization",
  "proxyauthorization",
  "cookie",
  "setcookie",
  "apikey",
  "accesstoken",
  "refreshtoken",
  "authtoken",
  "bearertoken",
  "sessiontoken",
  "password",
  "passwd",
  "passphrase",
  "secret",
  "clientsecret",
  "webhooksecret",
  "privatekey",
  "signingkey",
  "credential",
  "credentials",
  "awsaccesskeyid",
  "awssecretaccesskey",
]);

const SENSITIVE_FIELD_SUFFIX = /(?:apikey|accesskey|privatekey|password|passwd|passphrase|secret|token)$/;
const SENSITIVE_ARG_FLAG = /^--?(?:api[-_]?key|access[-_]?token|refresh[-_]?token|auth[-_]?token|session[-_]?token|password|passwd|passphrase|client[-_]?secret|private[-_]?key|secret|token)$/i;
const REDACTED_SENSITIVE_FIELD = "[REDACTED:sensitive-field]";

function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function resolveEvidenceDir(workDir = process.cwd()) {
  return path.resolve(workDir, ".va-auto-pilot", "evidence");
}

/**
 * Validate and create a managed path without following symlinked components
 * below the trusted project root. The returned path stays in the caller's
 * lexical namespace, while checks run from the root's canonical location.
 */
export function ensureSafeManagedPath(baseRoot, targetPath, { directory = false, create = true } = {}) {
  const lexicalBase = path.resolve(baseRoot);
  const lexicalTarget = path.resolve(targetPath);
  const relative = path.relative(lexicalBase, lexicalTarget);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`managed path escapes its trusted root: ${targetPath}`);
  }

  const canonicalBase = fs.realpathSync(lexicalBase);
  const parts = relative.split(path.sep).filter(Boolean);
  const directoryParts = directory ? parts : parts.slice(0, -1);
  let current = canonicalBase;
  for (const part of directoryParts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) {
      if (!create) {
        throw new Error(`managed path component does not exist: ${current}`);
      }
      fs.mkdirSync(current);
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`managed path component must be a real directory: ${current}`);
    }
  }

  if (!directory) {
    const canonicalTarget = path.join(canonicalBase, ...parts);
    if (fs.existsSync(canonicalTarget)) {
      const stat = fs.lstatSync(canonicalTarget);
      if (stat.isSymbolicLink() || !stat.isFile()) {
        throw new Error(`managed file must be a regular file: ${canonicalTarget}`);
      }
    }
  }
  return lexicalTarget;
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
  return path.resolve(
    resolveEvidenceDir(workDir),
    assertSafeRunId(runId ?? "unknown"),
    assertSafeTaskId(taskId ?? "unknown")
  );
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

function invalidBundleSummary(relativeManifest, errors, expected = {}) {
  return {
    manifest: String(relativeManifest ?? ""),
    manifestValid: false,
    errors,
    runId: String(expected.runId ?? ""),
    taskId: String(expected.taskId ?? ""),
    state: "",
    outcome: "",
    gates: [],
    requiredGateCount: 0,
    passedRequiredGateCount: 0,
    failedGates: [],
    review: { present: false, verified: false, criticalCount: null, warningCount: null, disposition: "" },
  };
}

export function readTaskEvidenceSummary(workDir, relativeManifest, expected = {}) {
  const root = path.resolve(workDir);
  const evidenceRoot = resolveEvidenceDir(root);
  const manifestPath = path.resolve(root, String(relativeManifest ?? ""));
  const relativeToEvidence = path.relative(evidenceRoot, manifestPath);
  if (!relativeToEvidence
      || relativeToEvidence.startsWith("..")
      || path.isAbsolute(relativeToEvidence)
      || path.basename(manifestPath) !== "manifest.json") {
    return invalidBundleSummary(relativeManifest, ["manifest path escapes the managed evidence root"], expected);
  }

  try {
    ensureSafeManagedPath(root, manifestPath, { create: false });
  } catch (error) {
    return invalidBundleSummary(relativeManifest, [String(error?.message ?? error)], expected);
  }
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
    return invalidBundleSummary(relativeManifest, ["manifest file does not exist"], expected);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return invalidBundleSummary(relativeManifest, [`manifest JSON is invalid: ${String(error?.message ?? error)}`], expected);
  }
  const validation = validateBundleManifest(manifest);
  const errors = [...validation.errors];
  let parsedEvents = [];
  if (manifest.bundleType !== "task") errors.push("manifest must be a task bundle");
  if (expected.runId && manifest.runId !== expected.runId) {
    errors.push(`manifest runId ${manifest.runId ?? "<missing>"} does not match ${expected.runId}`);
  }
  if (expected.taskId && manifest.taskId !== expected.taskId) {
    errors.push(`manifest taskId ${manifest.taskId ?? "<missing>"} does not match ${expected.taskId}`);
  }
  if (manifest.state !== manifest.outcome?.state) {
    errors.push(`manifest state ${manifest.state ?? "<missing>"} does not match outcome ${manifest.outcome?.state ?? "<missing>"}`);
  }
  const boundRunId = expected.runId || String(manifest.runId ?? "");
  const boundTaskId = expected.taskId || String(manifest.taskId ?? "");

  const bundleDir = path.dirname(manifestPath);
  for (const [index, artifact] of (Array.isArray(manifest.artifacts) ? manifest.artifacts : []).entries()) {
    let artifactPath;
    try {
      artifactPath = resolveContainedBundlePath(bundleDir, artifact?.path, `artifacts[${index}].path`);
      if (fs.existsSync(artifactPath) && fs.lstatSync(artifactPath).isSymbolicLink()) {
        errors.push(`artifacts[${index}] must not be a symbolic link`);
        continue;
      }
      ensureSafeManagedPath(root, artifactPath, { create: false });
      if (!fs.existsSync(artifactPath)) {
        errors.push(`artifacts[${index}] file does not exist`);
        continue;
      }
      const artifactStat = fs.lstatSync(artifactPath);
      if (artifactStat.isSymbolicLink()) {
        errors.push(`artifacts[${index}] must not be a symbolic link`);
        continue;
      }
      if (!artifactStat.isFile()) {
        errors.push(`artifacts[${index}] is not a regular file`);
        continue;
      }
      const content = fs.readFileSync(artifactPath);
      if (content.byteLength !== artifact.sizeBytes) {
        errors.push(`artifacts[${index}] sizeBytes does not match file content`);
      }
      const actualSha256 = crypto.createHash("sha256").update(content).digest("hex");
      if (actualSha256 !== artifact.sha256) {
        errors.push(`artifacts[${index}] sha256 does not match file content`);
      }
    } catch (error) {
      errors.push(`artifacts[${index}] is invalid: ${String(error?.message ?? error)}`);
    }
  }
  const eventsPath = path.resolve(bundleDir, String(manifest.eventsLog ?? ""));
  const relativeEventsPath = path.relative(bundleDir, eventsPath);
  if (!relativeEventsPath || relativeEventsPath.startsWith("..") || path.isAbsolute(relativeEventsPath)) {
    errors.push("eventsLog escapes the evidence bundle");
  } else {
    try {
      ensureSafeManagedPath(root, eventsPath, { create: false });
      if (!fs.existsSync(eventsPath) || !fs.lstatSync(eventsPath).isFile()) {
        errors.push("eventsLog file does not exist");
      } else {
        const eventLines = fs.readFileSync(eventsPath, "utf8").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        const events = [];
        for (const [index, line] of eventLines.entries()) {
          try {
            const event = JSON.parse(line);
            const eventValidation = validateEvent(event);
            if (!eventValidation.ok) {
              errors.push(`eventsLog line ${index + 1}: ${eventValidation.errors.join("; ")}`);
            }
            if (boundRunId && event.runId !== boundRunId) {
              errors.push(`eventsLog line ${index + 1}: runId does not match ${boundRunId}`);
            }
            if (boundTaskId && event.taskId !== boundTaskId) {
              errors.push(`eventsLog line ${index + 1}: taskId does not match ${boundTaskId}`);
            }
            events.push(event);
          } catch (error) {
            errors.push(`eventsLog line ${index + 1}: invalid JSON (${String(error?.message ?? error)})`);
          }
        }
        if (events.length === 0) {
          errors.push("eventsLog contains no events");
        }
        const eventIds = new Set(events.map((event) => event.eventId));
        for (const entry of Array.isArray(manifest.timeline) ? manifest.timeline : []) {
          if (!eventIds.has(entry.eventId)) {
            errors.push(`timeline event ${entry.eventId} is missing from eventsLog`);
          }
        }
        parsedEvents = events;
      }
    } catch (error) {
      errors.push(String(error?.message ?? error));
    }
  }

  const gates = (Array.isArray(manifest.gates) ? manifest.gates : []).map((gate) => ({
    name: String(gate?.name ?? ""),
    required: gate?.required === true,
    passed: gate?.passed === true,
    exitCode: Number.isInteger(Number(gate?.exitCode)) ? Number(gate.exitCode) : 1,
    durationMs: Number.isInteger(Number(gate?.durationMs)) ? Number(gate.durationMs) : 0,
  }));
  const requiredGates = gates.filter((gate) => gate.required);
  const eventGates = parsedEvents
    .filter((event) => event.eventType === "task.gate")
    .map((event) => ({
      name: String(event.payload?.gateName ?? ""),
      required: event.payload?.required !== false,
      passed: event.payload?.passed === true,
      exitCode: Number.isInteger(Number(event.payload?.exitCode)) ? Number(event.payload.exitCode) : 1,
      durationMs: Number.isInteger(Number(event.payload?.durationMs)) ? Number(event.payload.durationMs) : 0,
    }));
  const gateKey = (gate) => JSON.stringify([
    gate.name,
    gate.required,
    gate.passed,
    gate.exitCode,
    gate.durationMs,
  ]);
  const manifestGateKeys = gates.map(gateKey).sort();
  const eventGateKeys = eventGates.map(gateKey).sort();
  if (JSON.stringify(manifestGateKeys) !== JSON.stringify(eventGateKeys)) {
    errors.push("manifest gates do not match task.gate events");
  }
  const requiredOutcomeEvent = manifest.outcome?.state === "completed"
    ? "task.completed"
    : manifest.outcome?.state === "failed"
      ? "task.failed"
      : "";
  const outcomeEvent = parsedEvents.find((event) => event.eventType === requiredOutcomeEvent);
  if (requiredOutcomeEvent && !outcomeEvent) {
    errors.push(`outcome is missing ${requiredOutcomeEvent} event`);
  } else if (outcomeEvent && outcomeEvent.payload?.state !== manifest.outcome?.state) {
    errors.push(`${requiredOutcomeEvent} state does not match manifest outcome`);
  } else if (requiredOutcomeEvent === "task.completed"
      && outcomeEvent.payload?.evidenceBundle !== path.relative(root, manifestPath).replace(/\\/g, "/")) {
    errors.push("task.completed evidenceBundle does not match manifest path");
  }

  const review = {
    present: Boolean(manifest.review),
    verified: false,
    criticalCount: null,
    warningCount: null,
    disposition: String(manifest.review?.disposition ?? ""),
  };
  if (manifest.review) {
    const findingsPath = path.resolve(bundleDir, String(manifest.review.findingsIndexArtifact ?? ""));
    const relativeFindingsPath = path.relative(bundleDir, findingsPath);
    if (!relativeFindingsPath || relativeFindingsPath.startsWith("..") || path.isAbsolute(relativeFindingsPath)) {
      errors.push("review findings index escapes the evidence bundle");
    } else {
      try {
        ensureSafeManagedPath(root, findingsPath, { create: false });
        const findings = JSON.parse(fs.readFileSync(findingsPath, "utf8"));
        const criticalCount = Number(findings?.summary?.critical);
        const warningCount = Number(findings?.summary?.warning);
        if (!Number.isInteger(criticalCount) || criticalCount < 0
            || !Number.isInteger(warningCount) || warningCount < 0) {
          errors.push("review findings index has invalid summary counts");
        } else {
          review.criticalCount = criticalCount;
          review.warningCount = warningCount;
          if (criticalCount !== manifest.review.criticalCount || warningCount !== manifest.review.warningCount) {
            errors.push("manifest review counts do not match findings index");
          }
        }
      } catch (error) {
        errors.push(`review findings index is invalid: ${String(error?.message ?? error)}`);
      }
    }
    const reviewEvent = parsedEvents.find((event) => (
      event.eventType === "task.review"
      && event.payload?.findingsIndexArtifact === manifest.review.findingsIndexArtifact
    ));
    if (!reviewEvent) {
      errors.push("manifest review is missing its task.review event");
    } else if (Number(reviewEvent.payload?.criticalCount) !== manifest.review.criticalCount
        || Number(reviewEvent.payload?.warningCount) !== manifest.review.warningCount) {
      errors.push("manifest review counts do not match task.review event");
    }
    review.verified = !errors.some((error) => error.startsWith("review ") || error.startsWith("manifest review"));
  }
  return {
    manifest: path.relative(root, manifestPath).replace(/\\/g, "/"),
    manifestValid: errors.length === 0,
    errors,
    runId: String(manifest.runId ?? ""),
    taskId: String(manifest.taskId ?? ""),
    state: String(manifest.state ?? ""),
    outcome: String(manifest.outcome?.state ?? ""),
    gates,
    requiredGateCount: requiredGates.length,
    passedRequiredGateCount: requiredGates.filter((gate) => gate.passed).length,
    failedGates: requiredGates.filter((gate) => !gate.passed),
    review,
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
    }
  }

  return {
    text: redacted,
    applied: appliedRules.length > 0,
    count: appliedRules.length,
    rules: appliedRules,
  };
}

function normalizeSensitiveFieldName(key) {
  return String(key ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveFieldName(key) {
  const normalized = normalizeSensitiveFieldName(key);
  return SENSITIVE_FIELD_NAMES.has(normalized) || SENSITIVE_FIELD_SUFFIX.test(normalized);
}

function addRedaction(redactedFields, appliedRules, pathPrefix, ruleName) {
  redactedFields.push(pathPrefix);
  appliedRules.push(ruleName);
}

function redactForcedValue(value, rules, pathPrefix, redactedFields, appliedRules) {
  if (value === null || value === undefined) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactForcedValue(
      item,
      rules,
      `${pathPrefix}[${index}]`,
      redactedFields,
      appliedRules
    ));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      redactForcedValue(
        child,
        rules,
        pathPrefix ? `${pathPrefix}.${key}` : key,
        redactedFields,
        appliedRules
      ),
    ]));
  }
  addRedaction(redactedFields, appliedRules, pathPrefix, "sensitive-fields");
  return REDACTED_SENSITIVE_FIELD;
}

function redactValue(value, rules, pathPrefix, redactedFields, appliedRules, forceRedact = false) {
  if (forceRedact) {
    return redactForcedValue(value, rules, pathPrefix, redactedFields, appliedRules);
  }
  if (typeof value === "string") {
    const result = redactText(value, rules);
    if (result.applied) {
      redactedFields.push(pathPrefix);
      appliedRules.push(...result.rules);
    }
    return result.text;
  }
  if (Array.isArray(value)) {
    let redactNext = false;
    return value.map((item, index) => {
      const itemPath = `${pathPrefix}[${index}]`;
      const redacted = redactValue(
        item,
        rules,
        itemPath,
        redactedFields,
        appliedRules,
        redactNext
      );
      redactNext = typeof item === "string" && SENSITIVE_ARG_FLAG.test(item.trim());
      return redacted;
    });
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      redactValue(
        child,
        rules,
        pathPrefix ? `${pathPrefix}.${key}` : key,
        redactedFields,
        appliedRules,
        isSensitiveFieldName(key)
      ),
    ]));
  }
  return value;
}

export function redactSensitiveValue(value, rules = DEFAULT_REDACTION_RULES, pathPrefix = "value") {
  const fieldsRedacted = [];
  const appliedRules = [];
  const redactedValue = redactValue(value, rules, pathPrefix, fieldsRedacted, appliedRules);
  return {
    value: redactedValue,
    applied: fieldsRedacted.length > 0,
    rules: [...new Set(appliedRules)],
    fieldsRedacted: [...new Set(fieldsRedacted)],
  };
}

export function redactEvent(event, rules = DEFAULT_REDACTION_RULES) {
  const result = redactSensitiveValue(event?.payload, rules, "payload");
  const previous = event?.redaction ?? {};
  const fieldsRemoved = [
    ...(Array.isArray(previous.fieldsRemoved) ? previous.fieldsRemoved : []),
    ...result.fieldsRedacted,
  ];
  const appliedRules = [
    ...(Array.isArray(previous.rules) ? previous.rules : []),
    ...result.rules,
  ];
  return {
    ...event,
    payload: result.value,
    redaction: {
      applied: previous.applied === true || result.applied,
      rules: [...new Set(appliedRules)],
      fieldsRemoved: [...new Set(fieldsRemoved)],
    },
  };
}

export async function appendEventLog(logFile, event, options = {}) {
  const target = options.safeRoot
    ? ensureSafeManagedPath(options.safeRoot, logFile)
    : path.resolve(logFile);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const line = `${JSON.stringify(redactEvent(event, PERSISTENCE_REDACTION_RULES))}\n`;
  await withPilotFileLock(target, async () => {
    const existing = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
    const safeExisting = redactEventLogText(existing, PERSISTENCE_REDACTION_RULES);
    writeTextFileAtomicSync(target, `${safeExisting}${line}`);
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

export function writeBundleManifest(manifestPath, manifest, options = {}) {
  const target = options.safeRoot
    ? ensureSafeManagedPath(options.safeRoot, manifestPath)
    : path.resolve(manifestPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const safeManifest = redactSensitiveValue(manifest, PERSISTENCE_REDACTION_RULES, "manifest").value;
  writeTextFileAtomicSync(target, `${JSON.stringify(safeManifest, null, 2)}\n`);
}

export function ensureBundleDirs(bundleDir, options = {}) {
  const target = path.resolve(bundleDir);
  if (options.safeRoot) {
    ensureSafeManagedPath(options.safeRoot, path.join(target, "artifacts"), { directory: true });
    ensureSafeManagedPath(options.safeRoot, path.join(target, "findings"), { directory: true });
  } else {
    fs.mkdirSync(path.join(target, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(target, "findings"), { recursive: true });
  }
}

export function writeArtifact(artifactPath, content, options = {}) {
  const target = options.safeRoot
    ? ensureSafeManagedPath(options.safeRoot, artifactPath)
    : path.resolve(artifactPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const input = String(content ?? "");
  const safeText = redactArtifactText(input, target, PERSISTENCE_REDACTION_RULES);
  writeTextFileAtomicSync(target, safeText);
  return {
    text: safeText,
    applied: safeText !== input,
  };
}

function resolveContainedBundlePath(rootDir, relativePath, label) {
  if (!isNonEmptyString(relativePath) || path.isAbsolute(relativePath)) {
    throw new Error(`${label} must be a non-empty relative path`);
  }
  const root = path.resolve(rootDir);
  const target = path.resolve(root, relativePath);
  if (target === root || !target.startsWith(`${root}${path.sep}`)) {
    throw new Error(`${label} escapes the evidence bundle: ${relativePath}`);
  }
  return target;
}

function redactEventLogText(content, rules) {
  const hadTrailingNewline = String(content).endsWith("\n");
  const lines = String(content).split("\n");
  if (hadTrailingNewline) {
    lines.pop();
  }
  const redactedLines = lines.map((line) => {
    if (!line.trim()) {
      return line;
    }
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.payload) {
        return JSON.stringify(redactEvent(parsed, rules));
      }
      return JSON.stringify(redactSensitiveValue(parsed, rules, "record").value);
    } catch {
      // Non-JSON diagnostic lines are still covered by text rules below.
    }
    return redactText(line, rules).text;
  });
  return `${redactedLines.join("\n")}${hadTrailingNewline ? "\n" : ""}`;
}

function redactJsonText(content, rules) {
  const input = String(content);
  try {
    const parsed = JSON.parse(input);
    const safeValue = redactSensitiveValue(parsed, rules, "artifact").value;
    const indent = input.includes("\n") ? 2 : 0;
    const trailingNewline = input.endsWith("\n") ? "\n" : "";
    return `${JSON.stringify(safeValue, null, indent)}${trailingNewline}`;
  } catch {
    return redactText(input, rules).text;
  }
}

function redactArtifactText(content, artifactPath, rules, eventLog = false) {
  if (eventLog || path.basename(artifactPath) === "events.jsonl") {
    return redactEventLogText(content, rules);
  }
  const extension = path.extname(artifactPath).toLowerCase();
  if (extension === ".json") {
    return redactJsonText(content, rules);
  }
  if (extension === ".jsonl") {
    return redactEventLogText(content, rules);
  }
  return redactText(content, rules).text;
}

function readSafeTextArtifact(sourcePath, rules, eventLog = false) {
  if (!fs.existsSync(sourcePath)) {
    return null;
  }
  const sourceStat = fs.lstatSync(sourcePath);
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`Evidence text artifact must not be a symbolic link: ${sourcePath}`);
  }
  if (!sourceStat.isFile()) {
    throw new Error(`Evidence text artifact must be a regular file: ${sourcePath}`);
  }
  const raw = fs.readFileSync(sourcePath, "utf8");
  const safeText = redactArtifactText(raw, sourcePath, rules, eventLog);
  if (safeText !== raw) {
    writeTextFileAtomicSync(sourcePath, safeText);
  }
  return { text: safeText, applied: safeText !== raw };
}

export function redactBundle(bundleDir, rules = DEFAULT_REDACTION_RULES, options = {}) {
  if (options.safeRoot) {
    ensureSafeManagedPath(options.safeRoot, bundleDir, { directory: true });
  }
  const manifestPath = path.join(bundleDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Bundle manifest not found: ${manifestPath}`);
  }
  const parsedManifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const manifest = redactSensitiveValue(
    parsedManifest,
    PERSISTENCE_REDACTION_RULES,
    "manifest"
  ).value;
  const redactedDir = path.join(bundleDir, "redacted");
  if (options.safeRoot) {
    ensureSafeManagedPath(options.safeRoot, path.join(redactedDir, "artifacts"), { directory: true });
    ensureSafeManagedPath(options.safeRoot, path.join(redactedDir, "findings"), { directory: true });
  } else {
    fs.mkdirSync(path.join(redactedDir, "artifacts"), { recursive: true });
    fs.mkdirSync(path.join(redactedDir, "findings"), { recursive: true });
  }

  const safeArtifacts = [];
  const redactedArtifacts = [];
  for (const artifact of manifest.artifacts ?? []) {
    const sourcePath = resolveContainedBundlePath(bundleDir, artifact.path, "artifact.path");
    const redactedPath = resolveContainedBundlePath(redactedDir, artifact.path, "artifact.path");
    if (options.safeRoot) {
      ensureSafeManagedPath(options.safeRoot, sourcePath);
      ensureSafeManagedPath(options.safeRoot, redactedPath);
    }
    let safeArtifact = { ...artifact };
    let redactedArtifact = {
      ...artifact,
      path: path.relative(redactedDir, redactedPath),
    };

    if (isTextArtifact(artifact.name) && fs.existsSync(sourcePath)) {
      const safeResult = readSafeTextArtifact(sourcePath, PERSISTENCE_REDACTION_RULES);
      if (!safeResult) {
        throw new Error(`Evidence text artifact disappeared while redacting: ${sourcePath}`);
      }
      const safeSizeBytes = Buffer.byteLength(safeResult.text, "utf8");
      const safeSha256 = hashText(safeResult.text);
      const primaryRedacted = artifact.redacted
        || safeResult.applied
        || artifact.sizeBytes !== safeSizeBytes
        || artifact.sha256 !== safeSha256;
      safeArtifact = {
        ...artifact,
        sizeBytes: safeSizeBytes,
        sha256: safeSha256,
        redacted: primaryRedacted,
      };

      const shareableText = redactArtifactText(safeResult.text, sourcePath, rules);
      fs.mkdirSync(path.dirname(redactedPath), { recursive: true });
      writeTextFileAtomicSync(redactedPath, shareableText);
      redactedArtifact = {
        ...safeArtifact,
        path: path.relative(redactedDir, redactedPath),
        sizeBytes: Buffer.byteLength(shareableText, "utf8"),
        sha256: hashText(shareableText),
        redacted: primaryRedacted || shareableText !== safeResult.text,
      };
    }

    safeArtifacts.push(safeArtifact);
    redactedArtifacts.push(redactedArtifact);
  }

  if (isNonEmptyString(manifest.eventsLog)) {
    const sourceEventsPath = resolveContainedBundlePath(bundleDir, manifest.eventsLog, "eventsLog");
    const redactedEventsPath = resolveContainedBundlePath(redactedDir, manifest.eventsLog, "eventsLog");
    if (options.safeRoot) {
      ensureSafeManagedPath(options.safeRoot, sourceEventsPath);
      ensureSafeManagedPath(options.safeRoot, redactedEventsPath);
    }
    const safeEvents = readSafeTextArtifact(sourceEventsPath, PERSISTENCE_REDACTION_RULES, true);
    if (safeEvents !== null) {
      fs.mkdirSync(path.dirname(redactedEventsPath), { recursive: true });
      writeTextFileAtomicSync(
        redactedEventsPath,
        redactArtifactText(safeEvents.text, sourceEventsPath, rules, true)
      );
    }
  }

  const redactedManifest = redactSensitiveValue({
    ...manifest,
    bundleId: `${manifest.bundleId}-redacted`,
    artifacts: redactedArtifacts,
    eventsLog: manifest.eventsLog,
    redactedShareable: "manifest.json",
  }, rules, "manifest").value;
  writeBundleManifest(path.join(redactedDir, "manifest.json"), redactedManifest, options);

  const updatedManifest = {
    ...manifest,
    artifacts: safeArtifacts,
    redactedShareable: "redacted/manifest.json",
  };
  writeBundleManifest(manifestPath, updatedManifest, options);

  return { redactedDir, redactedManifest, updatedManifest };
}
