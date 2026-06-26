import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const EVAL_HISTORY_VERSION = 1;
export const DEFAULT_EVAL_HISTORY_FILE = ".va-auto-pilot/evidence/eval-history.jsonl";

export function resolveEvalHistoryFile(workDir = process.cwd(), historyFile = DEFAULT_EVAL_HISTORY_FILE) {
  return path.resolve(workDir, historyFile);
}

export function parseEvalScore(output) {
  const text = String(output ?? "");
  try {
    const parsed = JSON.parse(text.trim());
    const score = Number(parsed.score ?? parsed.metrics?.score);
    return Number.isFinite(score) ? score : null;
  } catch {
    const match = text.match(/\bscore\s*[:=]\s*([0-9]+(?:\.[0-9]+)?)/i);
    if (!match) return null;
    const score = Number(match[1]);
    return Number.isFinite(score) ? score : null;
  }
}

export function currentCommitHash(workDir = process.cwd()) {
  const result = spawnSync("git", ["rev-parse", "--verify", "HEAD"], {
    cwd: workDir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

export function buildEvalHistoryRecord({
  taskId = "",
  runId = "",
  gateName,
  evalCommand,
  passed,
  state,
  reason = "",
  score = null,
  exitCode = 0,
  commitHash = "",
  timestamp = new Date().toISOString(),
}) {
  return {
    schemaVersion: EVAL_HISTORY_VERSION,
    timestamp,
    taskId,
    runId,
    gateName,
    evalCommand,
    passed: Boolean(passed),
    state,
    reason,
    score,
    exitCode,
    commitHash,
  };
}

export function appendEvalHistoryRecord(filePath, record) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function readEvalHistory(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function summarizeEvalHistory(records, { gate = "", limit = 10 } = {}) {
  const filtered = records
    .filter((record) => !gate || record.gateName === gate)
    .slice(-Math.max(1, Number(limit) || 10));
  const passed = filtered.filter((record) => record.passed).length;
  const failed = filtered.length - passed;
  return {
    total: filtered.length,
    passed,
    failed,
    passRate: filtered.length ? passed / filtered.length : 0,
    latest: filtered[filtered.length - 1] ?? null,
    records: filtered,
  };
}
