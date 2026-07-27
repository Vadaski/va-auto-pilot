import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
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

/**
 * When a candidate plan carries `architecturePlanBinding`, approve/review must
 * prove the bound file bytes still match the frozen sha256. This closes the
 * "preflight reviewed A, approve-plan advances B" checkpoint gap for overlay
 * architecture plans that are not yet on git HEAD.
 *
 * @param {object} candidatePlan
 * @param {string} workDir
 * @returns {{ ok: true, binding: object, actualSha256: string } | { ok: false, code: string, message: string, context?: object }}
 */
export function validateArchitecturePlanBinding(candidatePlan, workDir) {
  const binding = candidatePlan?.architecturePlanBinding;
  if (!binding) {
    return { ok: true, binding: null, actualSha256: null };
  }
  if (binding.schemaVersion !== 1) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_INVALID",
      message: "architecturePlanBinding.schemaVersion must be 1",
      context: { schemaVersion: binding.schemaVersion ?? null },
    };
  }
  const relPath = typeof binding.path === "string" ? binding.path.trim() : "";
  const expectedSha = typeof binding.sha256 === "string" ? binding.sha256.trim().toLowerCase() : "";
  if (!relPath || !expectedSha || !/^[0-9a-f]{64}$/.test(expectedSha)) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_INVALID",
      message: "architecturePlanBinding requires path and 64-hex sha256",
      context: { path: relPath || null, sha256: binding.sha256 ?? null },
    };
  }

  const root = path.resolve(workDir);
  const target = path.resolve(root, relPath);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_ESCAPE",
      message: "architecturePlanBinding.path escapes workDir",
      context: { path: relPath },
    };
  }
  if (!fs.existsSync(target)) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_MISSING",
      message: `architecture plan file missing: ${relPath}`,
      context: { path: relPath },
    };
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_INVALID",
      message: "architecturePlanBinding.path must be a regular file",
      context: { path: relPath },
    };
  }
  const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (actualSha256 !== expectedSha) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_MISMATCH",
      message: "architecture plan bytes do not match architecturePlanBinding.sha256",
      context: { path: relPath, expected: expectedSha, actual: actualSha256 },
    };
  }
  if (typeof binding.bytes === "number" && binding.bytes !== stat.size) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_MISMATCH",
      message: "architecture plan size does not match architecturePlanBinding.bytes",
      context: { path: relPath, expectedBytes: binding.bytes, actualBytes: stat.size },
    };
  }
  return { ok: true, binding, actualSha256 };
}

/**
 * Copy the bound architecture plan bytes into an isolated track worktree so
 * workers cannot silently fall back to HEAD's older plan text.
 *
 * @param {{ workDir: string, worktreePath: string, candidatePlan: object }} input
 * @returns {{ ok: true, path: string, sha256: string } | { ok: false, code: string, message: string, context?: object }}
 */
export function materializeArchitecturePlanBindingToWorktree({ workDir, worktreePath, candidatePlan }) {
  const check = validateArchitecturePlanBinding(candidatePlan, workDir);
  if (!check.ok) {
    return check;
  }
  if (!check.binding) {
    return { ok: true, path: null, sha256: null };
  }
  if (!worktreePath) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_MATERIALIZE_MISSING_WORKTREE",
      message: "worktreePath is required to materialize architecturePlanBinding",
    };
  }
  const relPath = check.binding.path;
  const source = path.resolve(workDir, relPath);
  const target = path.resolve(worktreePath, relPath);
  const relative = path.relative(path.resolve(worktreePath), target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_BINDING_ESCAPE",
      message: "architecturePlanBinding.path escapes worktreePath",
      context: { path: relPath, worktreePath },
    };
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.chmodSync(target, 0o644);
  } catch {
    // target may not exist yet
  }
  fs.copyFileSync(source, target);
  try {
    fs.chmodSync(target, 0o444);
  } catch {
    // best-effort read-only marker for workers
  }
  const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex");
  if (actualSha256 !== check.actualSha256) {
    return {
      ok: false,
      code: "ARCHITECTURE_PLAN_MATERIALIZE_MISMATCH",
      message: "materialized architecture plan bytes do not match binding sha256",
      context: { path: relPath, expected: check.actualSha256, actual: actualSha256 },
    };
  }
  return { ok: true, path: relPath, sha256: actualSha256 };
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

export function validatePlanReviewForApprove({ review, candidatePlan, runId, workDir = "" }) {
  if (!review) {
    return { ok: false, code: "PLAN_REVIEW_REQUIRED", message: "run orchestrate review-plan before approve-plan" };
  }
  if (review.dryRun === true) {
    return {
      ok: false,
      code: "PLAN_REVIEW_DRY_RUN",
      message: "dry-run plan review cannot authorize approve-plan; re-run review-plan without --dry-run",
    };
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
  if (workDir && candidatePlan?.architecturePlanBinding) {
    const binding = validateArchitecturePlanBinding(candidatePlan, workDir);
    if (!binding.ok) {
      return binding;
    }
    if (review.architecturePlanSha256
      && review.architecturePlanSha256 !== binding.actualSha256) {
      return {
        ok: false,
        code: "ARCHITECTURE_PLAN_BINDING_STALE",
        message: "plan-review.json architecturePlanSha256 does not match current bound plan bytes",
        context: {
          expected: binding.actualSha256,
          got: review.architecturePlanSha256,
        },
      };
    }
  }
  return { ok: true, planHash };
}

export async function runPlanReviewCommand({ workDir, candidatePlan, runId, reviewCommand, dryRun }) {
  const planHash = computeCandidatePlanHash(candidatePlan);
  const planFile = orchestrationPaths(workDir, runId).candidatePlan;
  fs.mkdirSync(path.dirname(planFile), { recursive: true });
  fs.writeFileSync(planFile, `${JSON.stringify(candidatePlan, null, 2)}\n`, "utf8");

  if (dryRun) {
    const bindingCheck = validateArchitecturePlanBinding(candidatePlan, workDir);
    return {
      planHash,
      runId,
      reviewedAt: new Date().toISOString(),
      reviewer: "dry-run",
      command: reviewCommand,
      findings: { critical: [], warning: [], suggestion: [] },
      passed: bindingCheck.ok,
      dryRun: true,
      architecturePlanSha256: bindingCheck.ok ? bindingCheck.actualSha256 : null,
      architecturePlanBinding: bindingCheck.ok
        ? { ok: true, path: bindingCheck.binding?.path ?? null, sha256: bindingCheck.actualSha256 }
        : { ok: false, code: bindingCheck.code ?? null, message: bindingCheck.message ?? null },
    };
  }

  const binding = candidatePlan?.architecturePlanBinding;
  const bindingLines = binding
    ? [
        "本候选计划包含 architecturePlanBinding；必须核对：",
        `- path: ${binding.path}`,
        `- sha256: ${binding.sha256}`,
        `- bytes: ${binding.bytes ?? "(unspecified)"}`,
        `- preflightLedger: ${binding.preflightLedger ?? "(none)"}`,
        "若 binding 缺失、与磁盘文件不符、或 approve-plan 无法证明审的是同一计划字节 → CRITICAL。",
        "binding 已由编排器做机械字节校验；isolated worktree dispatch 必须物化同一字节到 worker 可见 path（materializeArchitecturePlanBindingToWorktree）。",
        "不要仅因“未进 git HEAD”判 CRITICAL；应确认 binding + approve 复核 + worktree 物化闭环成立。",
      ]
    : [];
  const prompt = [
    "只评审 sprint 计划，不写代码、不改仓库。",
    `候选计划 JSON 在 ${planFile}`,
    ...bindingLines,
    "本命令正在生成 plan-review.json；评审过程中该文件被清空是预期行为，禁止仅因“当前尚无 plan-review.json”判 CRITICAL。",
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
  const bindingCheck = validateArchitecturePlanBinding(candidatePlan, workDir);

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
    passed: passed && bindingCheck.ok,
    architecturePlanSha256: bindingCheck.ok ? bindingCheck.actualSha256 : null,
    architecturePlanBinding: bindingCheck.ok
      ? { ok: true, path: bindingCheck.binding?.path ?? null, sha256: bindingCheck.actualSha256 }
      : { ok: false, code: bindingCheck.code ?? null, message: bindingCheck.message ?? null },
    stdoutPreview: stdout.slice(0, 4000),
    stderrPreview: stderr.slice(0, 4000),
  };
}
