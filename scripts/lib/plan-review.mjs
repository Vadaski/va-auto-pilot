import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { hashString, orchestrationPaths } from "./orchestration-state.mjs";
import { DEFAULT_TRACK_TIMEOUT_MS } from "./constants.mjs";
import { needsShellExecution } from "./colony-bridge.mjs";
import { splitShellCommand } from "./shell-split.mjs";

const execFileAsync = promisify(execFile);

export function computeCandidatePlanHash(candidatePlan) {
  return hashString(JSON.stringify(candidatePlan ?? {}));
}

export function planReviewPath(workDir, runId = "") {
  return orchestrationPaths(workDir, runId).planReview;
}

export function readPlanReview(workDir, runId = "") {
  const filePath = planReviewPath(workDir, runId);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writePlanReview(workDir, value, runId = "") {
  const filePath = planReviewPath(workDir, runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function clearPlanReview(workDir, runId = "") {
  const filePath = planReviewPath(workDir, runId);
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function splitReviewLines(text) {
  return String(text ?? "").split(/\r\n|[\n\r\u2028\u2029]/u);
}

/** Parse reviewer stdout into structured findings (line-based CRITICAL/WARNING/SUGGESTION). */
export function parseReviewFindings(text) {
  const findings = { critical: [], warning: [], suggestion: [] };
  const lines = splitReviewLines(text);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const match = trimmed.match(/^(?:[-*]\s*)?(?:\d+[.)]\s*)?(?:\*\*)?(CRITICAL|WARNING|SUGGESTION)(?:[-_\s]*\d+)?(?:\*\*)?\s*[：:]\s*(.+)$/i);
    if (!match) {
      continue;
    }
    const severity = match[1].toUpperCase();
    const body = match[2].replace(/^\*+|\*+$/g, "").trim();
    if (severity === "CRITICAL") {
      findings.critical.push(body);
    } else if (severity === "WARNING") {
      findings.warning.push(body);
    } else if (severity === "SUGGESTION") {
      findings.suggestion.push(body);
    }
  }
  return findings;
}

export function parsePlanReviewStatus(text) {
  const lines = splitReviewLines(text)
    .map((line) => line.trim())
    .filter(Boolean);
  const exactPattern = /^PLAN REVIEW STATUS:\s*(PASS|FAIL)$/i;
  const statuses = lines
    .map((line) => line.match(exactPattern)?.[1]?.toUpperCase() ?? null)
    .filter(Boolean);
  const finalStatus = lines.at(-1)?.match(exactPattern)?.[1]?.toUpperCase() ?? null;
  if (!finalStatus || new Set(statuses).size !== 1) {
    return null;
  }
  return finalStatus;
}

function collectPlanReviewStatusMarkers(text) {
  return splitReviewLines(text)
    .map((line) => line.trim().match(/^PLAN REVIEW STATUS:\s*(PASS|FAIL)$/iu)?.[1]?.toUpperCase() ?? null)
    .filter(Boolean);
}

export function validatePlanReviewForApprove({ review, candidatePlan, runId }) {
  if (!review) {
    return { ok: false, code: "PLAN_REVIEW_REQUIRED", message: "run orchestrate review-plan before approve-plan" };
  }
  const planHash = computeCandidatePlanHash(candidatePlan);
  if (review.planHash !== planHash) {
    return {
      ok: false,
      code: "PLAN_REVIEW_STALE",
      message: "plan-review.json does not match current candidate plan; re-run review-plan",
      context: { expected: planHash, got: review.planHash },
    };
  }
  if (runId && review.runId && review.runId !== runId) {
    return { ok: false, code: "PLAN_REVIEW_RUN_MISMATCH", message: "plan-review.json is for a different run" };
  }
  if (review.passed !== true
      || (!review.dryRun && review.status !== "PASS")
      || (Array.isArray(review.findings?.critical) && review.findings.critical.length > 0)) {
    return {
      ok: false,
      code: "PLAN_REVIEW_CRITICAL",
      message: "plan review is not an explicit structured PASS; adjust plan or rerun review-plan before approve-plan",
      context: { status: review.status ?? null, critical: review.findings?.critical ?? [] },
    };
  }
  return { ok: true, planHash };
}

export async function runPlanReviewCommand({ workDir, candidatePlan, runId, reviewCommand, dryRun }) {
  const planHash = computeCandidatePlanHash(candidatePlan);
  const planFile = orchestrationPaths(workDir, runId).candidatePlan;
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, `${JSON.stringify(candidatePlan, null, 2)}\n`, "utf8");

  if (dryRun) {
    return {
      planHash,
      runId,
      reviewedAt: new Date().toISOString(),
      reviewer: "dry-run",
      command: reviewCommand,
      findings: { critical: [], warning: [], suggestion: [] },
      passed: true,
      dryRun: true,
    };
  }

  const prompt = [
    "只评审 sprint 计划，不写代码、不改仓库。",
    `候选计划 JSON 在 ${planFile}`,
    "用中文回复，每条必须带前缀 CRITICAL: / WARNING: / SUGGESTION:（可编号）。",
    "聚焦：任务拆分、顺序、与 orchestrated checkpoint 的冲突、遗漏风险。",
    "最后一个非空行必须严格等于以下二者之一，不要重复提示词：",
    "PLAN REVIEW STATUS: PASS",
    "PLAN REVIEW STATUS: FAIL",
  ].join("\n");

  const command = reviewCommand || "codex exec --sandbox read-only";

  let stdout;
  let stderr;
  let exitCode = 0;
  try {
    if (!reviewCommand) {
      const { stdout: out, stderr: err } = await execFileAsync(
        "codex",
        ["exec", "--sandbox", "read-only", "-C", workDir, prompt],
        { cwd: workDir, encoding: "utf8", timeout: DEFAULT_TRACK_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }
      );
      stdout = out;
      stderr = err;
    } else {
      const parts = splitShellCommand(command);
      const target = needsShellExecution(command)
        ? { file: "/bin/bash", args: ["-lc", command] }
        : { file: parts[0], args: parts.slice(1) };
      const { stdout: out, stderr: err } = await execFileAsync(target.file, target.args, {
        cwd: workDir,
        encoding: "utf8",
        timeout: DEFAULT_TRACK_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
        env: {
          ...process.env,
          VA_CANDIDATE_PLAN_FILE: planFile,
          VA_CANDIDATE_PLAN_HASH: planHash,
          VA_PLAN_REVIEW_PROMPT: prompt,
        },
      });
      stdout = out;
      stderr = err;
    }
  } catch (err) {
    exitCode = typeof err.code === "number" ? err.code : 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message ?? "";
  }

  const combinedOutput = `${stdout}\n${stderr}`;
  const findings = parseReviewFindings(combinedOutput);
  // Codex writes the model response to stdout and transport diagnostics (for
  // example token usage) to stderr. Keep the strict final-line contract on the
  // response stream instead of letting a later diagnostic line erase a valid
  // verdict. Custom reviewers that emit only to stderr remain supported, while
  // conflicting explicit verdicts across streams still fail closed.
  const stdoutStatus = parsePlanReviewStatus(stdout);
  const stderrStatus = parsePlanReviewStatus(stderr);
  const stdoutMarkers = collectPlanReviewStatusMarkers(stdout);
  const stderrMarkers = collectPlanReviewStatusMarkers(stderr);
  const allStatuses = new Set([...stdoutMarkers, ...stderrMarkers]);
  let status = stdoutMarkers.length > 0 ? stdoutStatus : stderrStatus;
  if (allStatuses.size !== 1) {
    status = null;
  }
  const hasStructuredOutput = status !== null;
  const passed = exitCode === 0
    && status === "PASS"
    && findings.critical.length === 0;

  return {
    schemaVersion: 1,
    planHash,
    runId,
    reviewedAt: new Date().toISOString(),
    reviewer: "codex",
    command,
    findings,
    exitCode,
    status,
    hasStructuredOutput,
    passed,
    stdoutPreview: stdout.slice(0, 4000),
    stderrPreview: stderr.slice(0, 4000),
  };
}
