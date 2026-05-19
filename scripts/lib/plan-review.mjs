import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { hashString, orchestrationPaths } from "./orchestration-state.mjs";

const execFileAsync = promisify(execFile);

export function computeCandidatePlanHash(candidatePlan) {
  return hashString(JSON.stringify(candidatePlan ?? {}));
}

export function planReviewPath(workDir) {
  return path.join(orchestrationPaths(workDir).dir, "plan-review.json");
}

export function readPlanReview(workDir) {
  const filePath = planReviewPath(workDir);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export async function writePlanReview(workDir, value) {
  const filePath = planReviewPath(workDir);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** Parse reviewer stdout into structured findings (line-based CRITICAL/WARNING/SUGGESTION). */
export function parseReviewFindings(text) {
  const findings = { critical: [], warning: [], suggestion: [] };
  const lines = String(text ?? "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const colon = trimmed.search(/[：:]/);
    if (colon < 0) {
      continue;
    }
    const body = trimmed.slice(colon + 1).replace(/^\*+|\*+$/g, "").trim();
    if (/CRITICAL/i.test(trimmed)) {
      findings.critical.push(body);
    } else if (/WARNING/i.test(trimmed)) {
      findings.warning.push(body);
    } else if (/SUGGESTION/i.test(trimmed)) {
      findings.suggestion.push(body);
    }
  }
  return findings;
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
  if (review.passed === false || (Array.isArray(review.findings?.critical) && review.findings.critical.length > 0)) {
    return {
      ok: false,
      code: "PLAN_REVIEW_CRITICAL",
      message: "plan review reported CRITICAL findings; adjust plan or backlog before approve-plan",
      context: { critical: review.findings?.critical ?? [] },
    };
  }
  return { ok: true, planHash };
}

export async function runPlanReviewCommand({ workDir, candidatePlan, runId, reviewCommand, dryRun }) {
  const planHash = computeCandidatePlanHash(candidatePlan);
  const planFile = path.join(orchestrationPaths(workDir).dir, "candidate-plan.json");
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
  ].join("\n");

  const command = reviewCommand
    || `codex exec --sandbox read-only -C ${workDir} ${JSON.stringify(prompt)}`;

  let stdout = "";
  let stderr = "";
  let exitCode = 0;
  try {
    if (command.includes("codex exec")) {
      const { stdout: out, stderr: err } = await execFileAsync(
        "/bin/bash",
        ["-lc", `</dev/null ${command}`],
        { cwd: workDir, encoding: "utf8", timeout: 600_000, maxBuffer: 10 * 1024 * 1024 }
      );
      stdout = out;
      stderr = err;
    } else {
      const parts = command.split(/\s+/);
      const { stdout: out, stderr: err } = await execFileAsync(parts[0], parts.slice(1), {
        cwd: workDir,
        encoding: "utf8",
        timeout: 600_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = out;
      stderr = err;
    }
  } catch (err) {
    exitCode = typeof err.code === "number" ? err.code : 1;
    stdout = err.stdout ?? "";
    stderr = err.stderr ?? err.message ?? "";
  }

  const findings = parseReviewFindings(`${stdout}\n${stderr}`);
  const passed = findings.critical.length === 0 && exitCode === 0;

  return {
    schemaVersion: 1,
    planHash,
    runId,
    reviewedAt: new Date().toISOString(),
    reviewer: "codex",
    command,
    findings,
    exitCode,
    passed,
    stdoutPreview: stdout.slice(0, 4000),
  };
}
