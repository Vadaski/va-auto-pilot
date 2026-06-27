import fs from "node:fs";

export const BUDGET_SCHEMA_VERSION = 1;

/**
 * @typedef {Record<string, any>} BudgetConfig
 * @typedef {{ provider: string, model: string, softTokens: number | null, hardTokens: number | null }} TokenBudget
 */

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function optionalLimit(value) {
  const number = numberOrNull(value);
  return number && number > 0 ? number : null;
}

export function normalizeBudgetConfig(config = {}) {
  /** @type {BudgetConfig} */
  const budget = config && typeof config === "object" ? config : {};
  return {
    schemaVersion: budget.schemaVersion ?? BUDGET_SCHEMA_VERSION,
    run: {
      maxCyclesSoft: optionalLimit(budget.run?.maxCyclesSoft ?? budget.maxCyclesSoft),
      maxCyclesHard: optionalLimit(budget.run?.maxCyclesHard ?? budget.maxCyclesHard),
      maxElapsedMsSoft: optionalLimit(budget.run?.maxElapsedMsSoft ?? budget.maxElapsedMsSoft),
      maxElapsedMsHard: optionalLimit(budget.run?.maxElapsedMsHard ?? budget.maxElapsedMsHard),
    },
    task: {
      maxCommandsSoft: optionalLimit(budget.task?.maxCommandsSoft ?? budget.maxCommandsSoft),
      maxCommandsHard: optionalLimit(budget.task?.maxCommandsHard ?? budget.maxCommandsHard),
    },
    tokens: {
      provider: String(budget.tokens?.provider ?? budget.provider ?? ""),
      model: String(budget.tokens?.model ?? budget.model ?? ""),
      softTokens: optionalLimit(budget.tokens?.softTokens ?? budget.softTokens),
      hardTokens: optionalLimit(budget.tokens?.hardTokens ?? budget.hardTokens),
    },
  };
}

export function evaluateBudget({ policy, cycle = 0, startedAtMs = Date.now(), nowMs = Date.now(), commandCount = 0, tokenCount = null }) {
  const normalized = normalizeBudgetConfig(policy);
  const elapsedMs = Math.max(0, nowMs - startedAtMs);
  const warnings = [];
  const stops = [];

  if (normalized.run.maxCyclesSoft && cycle >= normalized.run.maxCyclesSoft) {
    warnings.push(`soft cycle budget reached: ${cycle}/${normalized.run.maxCyclesSoft}`);
  }
  if (normalized.run.maxCyclesHard && cycle >= normalized.run.maxCyclesHard) {
    stops.push(`hard cycle budget reached: ${cycle}/${normalized.run.maxCyclesHard}`);
  }
  if (normalized.run.maxElapsedMsSoft && elapsedMs >= normalized.run.maxElapsedMsSoft) {
    warnings.push(`soft elapsed budget reached: ${elapsedMs}/${normalized.run.maxElapsedMsSoft}ms`);
  }
  if (normalized.run.maxElapsedMsHard && elapsedMs >= normalized.run.maxElapsedMsHard) {
    stops.push(`hard elapsed budget reached: ${elapsedMs}/${normalized.run.maxElapsedMsHard}ms`);
  }
  if (normalized.task.maxCommandsSoft && commandCount >= normalized.task.maxCommandsSoft) {
    warnings.push(`soft command budget reached: ${commandCount}/${normalized.task.maxCommandsSoft}`);
  }
  if (normalized.task.maxCommandsHard && commandCount >= normalized.task.maxCommandsHard) {
    stops.push(`hard command budget reached: ${commandCount}/${normalized.task.maxCommandsHard}`);
  }
  if (typeof tokenCount === "number") {
    if (normalized.tokens.softTokens && tokenCount >= normalized.tokens.softTokens) {
      warnings.push(`soft token budget reached: ${tokenCount}/${normalized.tokens.softTokens}`);
    }
    if (normalized.tokens.hardTokens && tokenCount >= normalized.tokens.hardTokens) {
      stops.push(`hard token budget reached: ${tokenCount}/${normalized.tokens.hardTokens}`);
    }
  }

  const status = stops.length > 0 ? "stop" : warnings.length > 0 ? "warn" : "ok";
  return {
    status,
    stop: stops.length > 0,
    warn: warnings.length > 0,
    reason: stops[0] ?? warnings[0] ?? "",
    warnings,
    stops,
    summary: formatBudgetSummary({
      status,
      cycle,
      elapsedMs,
      commandCount,
      warnings,
      stops,
      tokens: normalized.tokens,
      tokenCount,
    }),
  };
}

export function formatBudgetSummary({ status, cycle, elapsedMs, commandCount, warnings = [], stops = [], tokens = {}, tokenCount = null }) {
  /** @type {Partial<TokenBudget>} */
  const tokenMetadata = tokens ?? {};
  const parts = [
    `budget=${status}`,
    `cycles=${cycle}`,
    `elapsedMs=${elapsedMs}`,
    `commands=${commandCount}`,
  ];
  if (tokenCount !== null && tokenCount !== undefined) {
    parts.push(`tokens=${tokenCount}`);
  }
  if (tokenMetadata.provider || tokenMetadata.model) {
    parts.push(`tokenMetadata=${[tokenMetadata.provider, tokenMetadata.model].filter(Boolean).join("/")}`);
  }
  if (warnings.length > 0) {
    parts.push(`warnings=${warnings.join("; ")}`);
  }
  if (stops.length > 0) {
    parts.push(`stops=${stops.join("; ")}`);
  }
  return parts.join(" | ");
}

function addNumber(target, key, value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) {
    target[key] = (target[key] ?? 0) + number;
  }
}

function collectUsageFromObject(value, usage) {
  if (!value || typeof value !== "object") {
    return;
  }

  if (value.usage && typeof value.usage === "object") {
    collectUsageFromObject(value.usage, usage);
  }

  addNumber(usage, "inputTokens", value.input_tokens ?? value.inputTokens ?? value.prompt_tokens ?? value.promptTokens);
  addNumber(usage, "outputTokens", value.output_tokens ?? value.outputTokens ?? value.completion_tokens ?? value.completionTokens);
  addNumber(usage, "cacheCreationInputTokens", value.cache_creation_input_tokens ?? value.cacheCreationInputTokens);
  addNumber(usage, "cacheReadInputTokens", value.cache_read_input_tokens ?? value.cacheReadInputTokens);
  addNumber(usage, "totalTokens", value.total_tokens ?? value.totalTokens);
  addNumber(usage, "costUsd", value.total_cost_usd ?? value.totalCostUsd ?? value.cost_usd ?? value.costUsd);
}

function collectUsageFromJsonLines(text, usage) {
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      continue;
    }
    try {
      collectUsageFromObject(JSON.parse(trimmed), usage);
    } catch {
      // Worker logs are best-effort telemetry; ignore non-JSON lines.
    }
  }
}

/**
 * Extract token/cost telemetry from common CLI-agent log formats.
 *
 * @param {string} text
 * @returns {{ inputTokens: number, outputTokens: number, cacheCreationInputTokens: number, cacheReadInputTokens: number, totalTokens: number, costUsd: number }}
 */
export function extractUsageFromText(text) {
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
    totalTokens: 0,
    costUsd: 0,
  };

  const source = String(text ?? "");
  collectUsageFromJsonLines(source, usage);
  const nonJsonSource = source
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("{") && trimmed.endsWith("}"));
    })
    .join("\n");

  /** @type {{ key: keyof typeof usage, regex: RegExp }[]} */
  const regexes = [
    { key: "inputTokens", regex: /\binput[_\s-]*tokens?\b["':=\s]+([0-9][0-9,]*)/gi },
    { key: "outputTokens", regex: /\boutput[_\s-]*tokens?\b["':=\s]+([0-9][0-9,]*)/gi },
    { key: "totalTokens", regex: /\b(?:total[_\s-]*tokens?|tokens used)\b["':=\s]+([0-9][0-9,]*)/gi },
    { key: "costUsd", regex: /\b(?:total[_\s-]*cost[_\s-]*usd|cost[_\s-]*usd|cost)\b["':=$\s]+([0-9]+(?:\.[0-9]+)?)/gi },
  ];

  for (const { key, regex } of regexes) {
    for (const match of nonJsonSource.matchAll(regex)) {
      addNumber(usage, key, String(match[1]).replaceAll(",", ""));
    }
  }

  if (!usage.totalTokens) {
    usage.totalTokens = usage.inputTokens + usage.outputTokens + usage.cacheCreationInputTokens + usage.cacheReadInputTokens;
  }

  return usage;
}

/**
 * @param {string[]} files
 * @param {{ readFileSync?: typeof import("node:fs").readFileSync }} [options]
 */
export function extractUsageFromFiles(files, options = {}) {
  const readFileSync = options.readFileSync ?? fs.readFileSync;
  const total = extractUsageFromText("");
  for (const file of files ?? []) {
    if (!file) continue;
    try {
      const usage = extractUsageFromText(String(readFileSync ? readFileSync(file, "utf8") : ""));
      for (const key of Object.keys(total)) {
        total[key] += usage[key] ?? 0;
      }
    } catch {
      // Missing or rotated worker logs should not break the budget gate.
    }
  }
  return total;
}
