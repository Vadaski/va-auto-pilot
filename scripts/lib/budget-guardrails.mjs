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
