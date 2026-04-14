#!/usr/bin/env node

/**
 * @typedef {Object} PitfallRecord
 * @property {string} [id]
 * @property {string} [taskId]
 * @property {string} [failureType]
 * @property {string} [attempted]
 * @property {string} [hypothesis]
 * @property {string} [missingContext]
 * @property {string | null} [resolvedAt]
 */

import {
  inferProjectGateCommands,
  selectAcceptanceGateCommand,
  selectProjectTestCommand
} from "./project-gates.mjs";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "did", "do", "for", "from",
  "in", "into", "is", "it", "of", "on", "or", "run", "that", "the", "this",
  "to", "was", "were", "will", "with"
]);

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function tokenize(value) {
  return String(value ?? "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function inferGateName(pitfall) {
  const tokens = [
    ...tokenize(pitfall.attempted),
    ...tokenize(pitfall.hypothesis),
    ...tokenize(pitfall.missingContext)
  ];
  const unique = [...new Set(tokens)];
  const candidate = unique.slice(0, 2).join("-");
  return candidate ? candidate : `pitfall-${slugify(pitfall.id ?? "gate")}`;
}

function looksLikeCommand(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return false;
  if (raw.length > 140) return false;
  if (/[\r\n]/.test(raw)) return false;
  if (/^(because|likely|maybe|missing|failed|hang|timeout|review)/i.test(raw)) return false;
  return /[./]|--|npm\b|node\b|pnpm\b|yarn\b|pytest\b|git\b|cargo\b|go\b|make\b|bash\b|sh\b|python\b|deno\b|bun\b/i.test(raw);
}

function inferProjectCommandFromSource(source, projectCommands) {
  if (/\bsmoke|acceptance|e2e|playwright|puppeteer\b/.test(source)) {
    return selectAcceptanceGateCommand(projectCommands);
  }
  if (/\btest|jest|vitest|pytest|spec\b/.test(source)) {
    return selectProjectTestCommand(projectCommands);
  }
  if (/\blint|eslint|format\b/.test(source)) {
    return projectCommands.lintCommand ?? projectCommands.buildCommand;
  }
  if (/\btype|typescript|tsc\b/.test(source)) {
    return projectCommands.typecheckCommand ?? projectCommands.buildCommand;
  }
  if (/\bbuild|compile|bundle\b/.test(source)) {
    return projectCommands.buildCommand;
  }
  if (/\breview|finding|critical\b/.test(source)) {
    return "codex review --uncommitted";
  }

  return null;
}

function shouldReplaceAttemptedCommand(attempted, preferredCommand) {
  if (!attempted || !preferredCommand) {
    return false;
  }

  if (attempted === preferredCommand) {
    return false;
  }

  return /^(?:npm|pnpm)\s+(?:run\s+)?test$/i.test(attempted)
    || /^yarn\s+test$/i.test(attempted)
    || /^bun\s+test$/i.test(attempted)
    || /missing script:\s*"test"/i.test(attempted);
}

function inferCommand(pitfall, projectCommands) {
  const attempted = String(pitfall.attempted ?? "").trim();
  const source = `${pitfall.attempted ?? ""} ${pitfall.hypothesis ?? ""}`.toLowerCase();
  const inferredCommand = inferProjectCommandFromSource(source, projectCommands);

  if (looksLikeCommand(attempted) && !shouldReplaceAttemptedCommand(attempted, inferredCommand)) {
    return attempted;
  }

  if (inferredCommand) {
    return inferredCommand;
  }

  return `echo "TODO: implement gate for ${pitfall.id ?? "unknown pitfall"}"`;
}

/**
 * @param {PitfallRecord} pitfall
 * @param {{ projectDir?: string, projectCommands?: ReturnType<typeof inferProjectGateCommands> }} [options]
 * @returns {{ name: string, command: string, required: boolean, description: string, triggeredBy: string }}
 */
export function suggestGateFromPitfall(pitfall, options = {}) {
  const failureType = String(pitfall?.failureType ?? "");
  const projectCommands = options.projectCommands ?? inferProjectGateCommands(options.projectDir);
  return {
    name: inferGateName(pitfall),
    command: inferCommand(pitfall, projectCommands),
    required: failureType === "gate",
    description: `Suggested from pitfall ${pitfall?.id ?? "unknown"}: ${String(pitfall?.hypothesis ?? "").trim() || "recurring failure needs a gate"}`,
    triggeredBy: String(pitfall?.id ?? "")
  };
}

/**
 * @param {PitfallRecord[]} pitfalls
 * @param {{ projectDir?: string, projectCommands?: ReturnType<typeof inferProjectGateCommands> }} [options]
 * @returns {{ name: string, command: string, required: boolean, description: string, triggeredBy: string }[]}
 */
export function suggestGatesFromPitfalls(pitfalls, options = {}) {
  if (!Array.isArray(pitfalls)) {
    return [];
  }

  const projectCommands = options.projectCommands ?? inferProjectGateCommands(options.projectDir);

  return pitfalls
    .filter((pitfall) => pitfall && (!pitfall.resolvedAt || String(pitfall.resolvedAt).trim() === ""))
    .map((pitfall) => suggestGateFromPitfall(pitfall, { projectCommands }));
}
