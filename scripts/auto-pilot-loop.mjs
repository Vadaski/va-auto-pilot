#!/usr/bin/env node
/**
 * auto-pilot-loop.mjs — Autonomous Decision Loop for VA Auto-Pilot.
 *
 * Implements the full sprint execution cycle:
 *   readHumanBoard → loadPitfalls → nextTask → branchOnState →
 *   dispatchOrGate → updateState → journal → report
 *
 * Usage:
 *   node scripts/auto-pilot-loop.mjs [options]
 *
 * Options:
 *   --max-cycles <n>        Maximum task cycles (default: 50)
 *   --max-parallel <n>      Parallel track count (default: 3)
 *   --agent-template <cmd>  Agent command template (default: "claude --task {taskId}")
 *   --single-cycle          Run exactly one task cycle, then exit
 *   --dry-run               Print plan without executing
 *   --no-commit             Skip git add/git commit after gates pass
 *   --no-colony             Skip Colony, use raw spawn
 *   --track-timeout <ms>    Per-task timeout (default: 600000)
 *   --json                  JSON output
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parseArgv, nowIso, readQualityGateConfig, resolveDefaults } from "./lib/sprint-utils.mjs";
import {
  readHumanBoardInstructions,
  resolveHumanBoardPath
} from "./lib/human-board.mjs";
import { ColonyBridge } from "./lib/colony-bridge.mjs";
import { classifyFailure, getRecoveryStrategy } from "./lib/error-recovery.mjs";
import { createFixTasksFromFindings, parseReviewFindings } from "./lib/review-parser.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Sprint-board CLI helper
// ---------------------------------------------------------------------------

const SPRINT_BOARD = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "sprint-board.mjs"
);

/**
 * Run a sprint-board subcommand and return { stdout, stderr, exitCode }.
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string, exitCode: number }>}
 */
function appendSprintBoardOptions(args, opts = {}) {
  const finalArgs = [...args];
  const pushOption = (key, value) => {
    if (!value || finalArgs.includes(`--${key}`)) {
      return;
    }
    finalArgs.push(`--${key}`, value);
  };

  pushOption("state-file", opts.stateFile);
  pushOption("board-file", opts.boardFile);
  pushOption("journal-file", opts.journalFile);
  pushOption("pitfalls-file", opts.pitfallsFile);
  return finalArgs;
}

async function sprintBoard(args, opts = {}) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [SPRINT_BOARD, ...appendSprintBoardOptions(args, opts)],
      { encoding: "utf8", timeout: 30_000, cwd: opts.workDir ?? process.cwd() }
    );
    return { stdout, stderr, exitCode: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? "",
      stderr: err.stderr ?? err.message,
      exitCode: typeof err.code === "number" ? err.code : 1,
    };
  }
}

// ---------------------------------------------------------------------------
// Human board parser
// ---------------------------------------------------------------------------

/**
 * Parse human-board.md and return unchecked instruction lines.
 * @param {string} boardPath
 * @returns {string[]}
 */
function readHumanBoard(boardPath) {
  return readHumanBoardInstructions(boardPath).map((item) => item.text);
}

/**
 * @param {{ lineNumber: number, text: string }[]} instructions
 * @returns {string}
 */
function formatHumanBoardInstructionBlock(instructions) {
  if (!Array.isArray(instructions) || instructions.length === 0) {
    return "";
  }

  const lines = [
    "⚠ Human Board Instructions requiring your explicit acknowledgment:"
  ];
  instructions.forEach((instruction, index) => {
    lines.push(`  ${index + 1}. ${instruction.text}`);
  });
  lines.push("For each item above, state: ADDRESSED (reason) | SUPERSEDED (reason) | STILL_PENDING (will handle this cycle)");
  lines.push("Return the same numbered list in a `Human Board Acknowledgments` section so it can be journaled.");
  return lines.join("\n");
}

function readHumanBoardAcknowledgmentText(source) {
  if (!source) {
    return null;
  }

  if (typeof source === "string") {
    if (!fs.existsSync(source)) {
      return null;
    }
    return fs.readFileSync(source, "utf8");
  }

  if (typeof source === "object") {
    const candidates = [];
    const pushCandidate = (value) => {
      if (typeof value === "string" && value.trim()) {
        candidates.push(value);
      }
    };

    pushCandidate(source.agentResponse);
    pushCandidate(source.response);
    pushCandidate(source.output);
    pushCandidate(source.stdout);
    pushCandidate(source.text);
    pushCandidate(source.content);
    pushCandidate(source.message);
    pushCandidate(source.evidence);

    if (source.evidence && typeof source.evidence === "object") {
      pushCandidate(source.evidence.agentResponse);
      pushCandidate(source.evidence.response);
      pushCandidate(source.evidence.output);
      pushCandidate(source.evidence.stdout);
      pushCandidate(source.evidence.text);
      pushCandidate(source.evidence.content);
      pushCandidate(source.evidence.message);
    }

    return candidates.length > 0 ? candidates.join("\n\n") : null;
  }

  return null;
}

/**
 * @param {string | object | null | undefined} source
 * @param {{ lineNumber: number, text: string }[]} instructions
 * @returns {{ index: number, status: string, reason: string }[] | null}
 */
function extractHumanBoardAcknowledgments(source, instructions) {
  const raw = readHumanBoardAcknowledgmentText(source);
  if (!raw) {
    return null;
  }

  const acknowledgments = new Map();
  const linePattern = /^\s*(?:[-*]\s*)?(\d+)\.\s+(ADDRESSED|SUPERSEDED|STILL_PENDING)\s*(?:\((.*)\))?\s*$/;

  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(linePattern);
    if (!match) continue;

    const index = Number.parseInt(match[1], 10);
    if (!Number.isFinite(index)) continue;

    acknowledgments.set(index, {
      index,
      status: match[2],
      reason: String(match[3] ?? "").trim()
    });
  }

  return instructions.map((instruction, index) => {
    const acknowledgment = acknowledgments.get(index + 1);
    if (acknowledgment) {
      return acknowledgment;
    }

    return {
      index: index + 1,
      status: "STILL_PENDING",
      reason: `no explicit acknowledgment captured for line ${instruction.lineNumber}: ${instruction.text}`
    };
  });
}

/**
 * @param {string} journalFile
 * @param {object} task
 * @param {{ index: number, status: string, reason: string }[]} acknowledgments
 * @param {string} logFile
 * @returns {void}
 */
function appendHumanBoardAuditEntry(journalFile, task, acknowledgments, logFile) {
  if (!Array.isArray(acknowledgments) || acknowledgments.length === 0) {
    return;
  }

  const lines = [];
  lines.push(`## ${nowIso()} - ${task.id} human-board`);
  lines.push("- Summary: Human board instruction acknowledgments captured for this cycle.");
  lines.push("- Signals:");
  for (const acknowledgment of acknowledgments) {
    lines.push(`  - ${acknowledgment.index}. ${acknowledgment.status}${acknowledgment.reason ? ` (${acknowledgment.reason})` : ""}`);
  }
  if (logFile) {
    lines.push(`- Files: \`${logFile}\``);
  }
  lines.push("---");

  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const prefix = fs.existsSync(journalFile)
    ? "\n"
    : "# Run Journal\n\n## Codebase Signals\n- Add reusable patterns and gotchas here.\n\n## Entries\n";
  fs.appendFileSync(journalFile, `${prefix}${lines.join("\n")}\n`, "utf8");
}

/**
 * Safely parse a JSON string and report whether parsing succeeded.
 * @param {string} raw
 * @returns {{ parsed: true, value: unknown } | { parsed: false, value: null }}
 */
function tryParseJson(raw) {
  try {
    return { parsed: true, value: JSON.parse(raw) };
  } catch {
    return { parsed: false, value: null };
  }
}

/**
 * Extracts a structured error payload from `next --json` output.
 * @param {string} stdout
 * @returns {{ code?: string, message?: string, context?: Record<string, unknown> } | null}
 */
function extractNextError(stdout) {
  const parsed = tryParseJson(stdout.trim());
  if (!parsed.parsed || !parsed.value || typeof parsed.value !== "object") {
    return null;
  }

  const error = "error" in parsed.value ? parsed.value.error : parsed.value;
  if (!error || typeof error !== "object") {
    return null;
  }

  return /** @type {{ code?: string, message?: string, context?: Record<string, unknown> } } */ (error);
}

/**
 * Formats a clear human-board blocked message for loop termination.
 * @param {{ code?: string, message?: string, context?: Record<string, unknown> } } error
 * @returns {string}
 */
function formatHumanBoardBlockedDetails(error) {
  const instructionCount = Array.isArray(error.context?.instructions)
    ? error.context.instructions.length
    : 0;
  const suffix = instructionCount > 0 ? ` (${instructionCount} unchecked instruction(s))` : "";
  return `${error.code ?? "HUMAN_BOARD_BLOCKED"}: ${error.message ?? "human board is blocking progress"}${suffix}. Process docs/todo/human-board.md first.`;
}

// ---------------------------------------------------------------------------
// Pitfall loader
// ---------------------------------------------------------------------------

/**
 * Load unresolved pitfalls via sprint-board CLI.
 * @returns {Promise<object[]>}
 */
async function loadUnresolvedPitfalls(opts = {}) {
  const { stdout, exitCode } = await sprintBoard(["pitfall", "--list", "--unresolved", "--json"], opts);
  if (exitCode !== 0 || !stdout.trim()) return [];
  try {
    const data = JSON.parse(stdout.trim());
    return Array.isArray(data) ? data : (data.entries ?? []);
  } catch {
    return [];
  }
}

/**
 * Filter pitfalls relevant to a task and format as constraint text.
 * @param {object} task
 * @param {object[]} pitfalls
 * @returns {string}
 */
function injectPitfallContext(task, pitfalls) {
  const relevant = pitfalls.filter(
    (p) => p.taskId === task.id || !p.taskId
  );
  if (relevant.length === 0) return "";
  const lines = relevant.map(
    (p, i) => `  ${i + 1}. [${p.id ?? "?"}] ${p.failureType}: ${p.attempted} — hypothesis: ${p.hypothesis}${p.missingContext ? ` (missing: ${p.missingContext})` : ""}`
  );
  return `\n--- HARD CONSTRAINTS (pitfall guide) ---\n${lines.join("\n")}\n---`;
}

// ---------------------------------------------------------------------------
// Quality gate runner
// ---------------------------------------------------------------------------

/**
 * Run the quality gate sequence: build → review → acceptance.
 * Runs sequentially; returns on first failure.
 * @param {object} gateConfig
 * @param {object} opts
 * @returns {Promise<{ passed: boolean, gate: string, output: string, exitCode: number, stdout: string, stderr: string }>}
 */
async function runGateSequence(gateConfig, opts) {
  const gates = [
    { name: "build", cmd: gateConfig.buildCommand },
    { name: "review", cmd: gateConfig.reviewCommand },
    { name: "acceptance", cmd: gateConfig.acceptanceTestCommand },
  ];

  for (const gate of gates) {
    if (!gate.cmd) continue;
    if (opts.dryRun) {
      log(opts, `  [dry-run] would run gate "${gate.name}": ${gate.cmd}`);
      continue;
    }
    log(opts, `  running gate "${gate.name}": ${gate.cmd}`);
    try {
      await execFileAsync(
        "bash", ["-lc", gate.cmd],
        { encoding: "utf8", timeout: 300_000, cwd: opts.workDir ?? process.cwd() }
      );
      log(opts, `  gate "${gate.name}" PASSED`);
    } catch (err) {
      const stdout = String(err.stdout ?? "");
      const stderr = String(err.stderr ?? err.message);
      const output = stdout + "\n" + stderr;
      log(opts, `  gate "${gate.name}" FAILED`);
      return {
        passed: false,
        gate: gate.name,
        output: output.slice(0, 2000),
        exitCode: typeof err.code === "number" ? err.code : 1,
        stdout,
        stderr
      };
    }
  }

  return { passed: true, gate: "", output: "", exitCode: 0, stdout: "", stderr: "" };
}

// ---------------------------------------------------------------------------
// Task dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to a sub-agent.
 * @param {object} task
 * @param {ColonyBridge} bridge
 * @param {string} pitfallContext
 * @param {string} humanBoardBlock
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function dispatchTask(task, bridge, pitfallContext, humanBoardBlock, opts) {
  const template = opts.agentTemplate.replace("{taskId}", task.id);
  const logDir = path.resolve(".va-auto-pilot/parallel-runs");
  const logFile = path.join(logDir, `${task.id}-${Date.now()}.log`);
  const notes = [task.notes, humanBoardBlock].filter(Boolean).join("\n\n");

  const track = {
    taskId: task.id,
    command: template,
    title: task.title + (pitfallContext ? pitfallContext : ""),
    priority: task.priority,
    dependsOn: task.dependsOn,
    notes,
  };

  if (opts.dryRun) {
    log(opts, `  [dry-run] would dispatch ${task.id} via: ${template}`);
    if (humanBoardBlock) {
      log(opts, "  [dry-run] injected human-board instructions:");
      log(opts, humanBoardBlock);
    }
    return { taskId: task.id, success: true, dryRun: true };
  }

  log(opts, `  dispatching ${task.id} via: ${template}`);
  if (humanBoardBlock) {
    log(opts, "  injecting human-board instructions into sub-agent prompt:");
    log(opts, humanBoardBlock);
  }
  const result = await bridge.dispatch(track, template, logFile, opts.trackTimeout);
  log(opts, `  dispatch result: success=${result.success} duration=${result.durationMs}ms`);
  return result;
}

// ---------------------------------------------------------------------------
// State transitions
// ---------------------------------------------------------------------------

async function transitionToInProgress(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "In Progress",
  ], opts);
}

async function transitionToReview(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Review",
  ], opts);
}

async function transitionToTesting(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Testing",
  ], opts);
}

async function transitionToDone(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Done",
    "--verification", `Auto-pilot loop: all gates passed at ${nowIso()}`,
  ], opts);
}

async function transitionToFailed(task, gate, output, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Failed",
    "--failure-type", "gate",
    "--failure-attempted", `auto-pilot gate: ${gate}`,
    "--failure-hypothesis", output.slice(0, 500),
  ], opts);
}

function findTaskById(state, taskId) {
  return Array.isArray(state.tasks)
    ? state.tasks.find((item) => item?.id === taskId) ?? null
    : null;
}

function extractCreatedTaskId(stdout) {
  const match = String(stdout ?? "").match(/Task added:\s+([A-Z]+-\d+)/);
  return match ? match[1] : null;
}

async function journalFailureRecoveryDecision(task, failureDetails, opts) {
  const state = readSprintState(opts.stateFile);
  const persistedTask = findTaskById(state, task.id);
  const failCount = Number(persistedTask?.failCount ?? task.failCount ?? 0);
  const classified = classifyFailure(
    Number(failureDetails.exitCode ?? 1),
    String(failureDetails.stderr ?? ""),
    String(failureDetails.stdout ?? ""),
    failureDetails.gateName
  );
  const strategy = getRecoveryStrategy(classified, failCount);
  const parts = [
    `Failure classified: type=${classified.type}`,
    `severity=${classified.severity}`,
    `pattern=${classified.pattern}`,
    `failCount=${failCount}`,
    `strategy=${strategy.action}`,
    `reason=${strategy.reason}`
  ];

  if (strategy.nextModel) {
    parts.push(`nextModel=${strategy.nextModel}`);
  }
  if (strategy.fixPrompt) {
    parts.push(`fixPrompt=${strategy.fixPrompt}`);
  }

  await journalEntry(task, parts.join(" | "), opts, {
    signals: [`failure:${classified.type}`, `strategy:${strategy.action}`]
  });

  return { classified, strategy, failCount };
}

async function transitionToFailedWithRecovery(task, gateName, failureDetails, opts) {
  await transitionToFailed(task, gateName, failureDetails.output, opts);
  return journalFailureRecoveryDecision(task, { ...failureDetails, gateName }, opts);
}

async function createReviewFixTasks(task, reviewOutput, opts) {
  const parsed = parseReviewFindings(reviewOutput);
  if (!parsed.hasBlocking) {
    return { parsed, createdTaskIds: [] };
  }

  await journalEntry(
    task,
    `Review failed with ${parsed.summary.critical + parsed.summary.p1 + parsed.summary.p2} blocking findings. Creating fix tasks.`,
    opts,
    { signals: ["review-blocking-findings"] }
  );

  const taskSpecs = createFixTasksFromFindings(parsed.findings, task.id)
    .filter((item) => item.priority === "P0" || item.priority === "P1" || item.priority === "P2");

  const createdTaskIds = [];
  for (const spec of taskSpecs) {
    const result = await sprintBoard([
      "add",
      "--title", spec.title,
      "--priority", spec.priority,
      "--source", spec.source
    ], opts);
    const createdTaskId = extractCreatedTaskId(result.stdout);
    if (createdTaskId) {
      createdTaskIds.push(createdTaskId);
    }
  }

  if (createdTaskIds.length > 0) {
    await sprintBoard([
      "update",
      "--id", task.id,
      "--depends-on", createdTaskIds.join(",")
    ], opts);
    await journalEntry(task, `Created review fix tasks: ${createdTaskIds.join(", ")}`, opts, {
      signals: createdTaskIds.map((id) => `fix-task:${id}`)
    });
  }

  return { parsed, createdTaskIds };
}

// ---------------------------------------------------------------------------
// Cycle state + git helpers
// ---------------------------------------------------------------------------

function readSprintState(stateFile) {
  const resolved = path.resolve(stateFile);
  if (!fs.existsSync(resolved)) {
    return { tasks: [] };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

function countPendingTasks(state) {
  return Array.isArray(state.tasks)
    ? state.tasks.filter((task) => task?.state !== "Done").length
    : 0;
}

function detectStopCondition(state) {
  const repeatedFailure = Array.isArray(state.tasks)
    ? state.tasks.find((task) => task?.state !== "Done" && Number(task?.failCount ?? 0) >= 3)
    : null;

  if (!repeatedFailure) {
    return { stop: false, code: "", reason: "" };
  }

  return {
    stop: true,
    code: "FAIL_LIMIT_REACHED",
    reason: `Stop condition: ${repeatedFailure.id} has failed ${repeatedFailure.failCount} times.`,
    task: repeatedFailure
  };
}

function readCycleContext(opts) {
  const humanBoardPath = resolveHumanBoardPath(opts.stateFile);
  const journalPath = path.resolve(opts.journalFile);
  const humanBoardInstructions = readHumanBoardInstructions(humanBoardPath);
  const journal = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, "utf8") : "";
  return {
    humanBoardPath,
    journalPath,
    humanBoardInstructions,
    journalEntryCount: (journal.match(/^## /gm) ?? []).length
  };
}

function splitLines(raw) {
  return String(raw ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function git(args, opts) {
  return execFileAsync("git", args, {
    encoding: "utf8",
    cwd: opts.workDir ?? process.cwd(),
    timeout: 30_000,
    env: opts.env ?? process.env
  });
}

async function listChangedFiles(opts) {
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--name-only", "--relative", "HEAD", "--"], opts),
    git(["ls-files", "--others", "--exclude-standard"], opts)
  ]);

  return new Set([
    ...splitLines(tracked.stdout),
    ...splitLines(untracked.stdout)
  ]);
}

function snapshotFileState(filePath, opts) {
  const absolutePath = path.join(opts.workDir ?? process.cwd(), filePath);
  if (!fs.existsSync(absolutePath)) {
    return { exists: false, content: null };
  }

  return {
    exists: true,
    content: fs.readFileSync(absolutePath)
  };
}

function restoreFileState(filePath, snapshot, opts) {
  const absolutePath = path.join(opts.workDir ?? process.cwd(), filePath);
  if (!snapshot?.exists) {
    fs.rmSync(absolutePath, { force: true, recursive: false });
    return;
  }

  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  fs.writeFileSync(absolutePath, snapshot.content);
}

async function stagePaths(files, opts) {
  if (!Array.isArray(files) || files.length === 0) {
    return [];
  }

  await git(["add", "--all", "--", ...files], opts);
  const staged = await git(["diff", "--cached", "--name-only", "--relative", "--", ...files], opts);
  return splitLines(staged.stdout);
}

async function commitPaths(header, files, opts) {
  const stagedFiles = await stagePaths(files, opts);
  if (stagedFiles.length === 0) {
    return { committed: false, skipped: true, reason: "no staged changes", files: [], hash: "", header };
  }

  await git([
    "commit",
    "-m", header,
    "-m", "Co-Authored-By: Claude Opus 4.6 <noreply@anthropic.com>",
    "--only",
    "--",
    ...stagedFiles
  ], opts);
  const head = await git(["rev-parse", "HEAD"], opts);

  return {
    committed: true,
    skipped: false,
    reason: "",
    header,
    files: stagedFiles,
    hash: head.stdout.trim()
  };
}

async function ensureTaskBaseline(task, opts) {
  if (opts.taskBaselines.has(task.id)) {
    return opts.taskBaselines.get(task.id);
  }

  const files = await listChangedFiles(opts);
  const snapshots = new Map();
  for (const file of files) {
    snapshots.set(file, snapshotFileState(file, opts));
  }

  const baseline = { files, snapshots };
  opts.taskBaselines.set(task.id, baseline);
  return baseline;
}

function deriveCommitType(task) {
  const source = `${task.source ?? ""} ${task.title ?? ""}`.toLowerCase();

  if (/\b(readme|docs?|protocol|guide|manual|journal)\b/.test(source)) return "docs";
  if (/\b(test|tests|spec|specs|flow|flows|assert|coverage)\b/.test(source)) return "test";
  if (/\b(fix|bug|bugs|regression|repair|patch|hotfix)\b/.test(source)) return "fix";
  if (/\b(refactor|cleanup|restructure|rename|simplify)\b/.test(source)) return "refactor";
  if (/\b(chore|deps|dependency|dependencies|build|ci|config|tooling|infra)\b/.test(source)) return "chore";
  return "feat";
}

function sanitizeCommitScope(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/^[./]+/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function deriveCommitScope(task) {
  const sourceScope = sanitizeCommitScope(task.source);
  if (sourceScope) {
    return sourceScope;
  }

  const taskPrefix = sanitizeCommitScope(String(task.id ?? "").split("-")[0]);
  return taskPrefix || "core";
}

function buildCommitHeader(task) {
  const description = String(task.title ?? task.id ?? "task")
    .replace(/\s+/g, " ")
    .trim();
  return `${deriveCommitType(task)}(${deriveCommitScope(task)}): ${description}`;
}

async function autoCommitTask(task, opts) {
  if (opts.dryRun) {
    return { committed: false, skipped: true, reason: "dry-run", files: [], hash: "" };
  }

  if (opts.noCommit) {
    return { committed: false, skipped: true, reason: "disabled by --no-commit", files: [], hash: "" };
  }

  const currentFiles = await listChangedFiles(opts);
  if (currentFiles.size === 0) {
    return { committed: false, skipped: true, reason: "working tree clean", files: [], hash: "" };
  }

  const baseline = opts.taskBaselines.get(task.id);
  const baselineFiles = baseline ? [...baseline.files].sort() : [];
  let baselineCommit = { committed: false, skipped: true, reason: "no baseline changes", files: [], hash: "" };

  if (baselineFiles.length > 0) {
    log(
      opts,
      `  WARNING: found ${baselineFiles.length} pre-existing dirty file(s); syncing them in a separate commit before ${task.id}`
    );

    const finalSnapshots = new Map();
    for (const file of baselineFiles) {
      finalSnapshots.set(file, snapshotFileState(file, opts));
      restoreFileState(file, baseline.snapshots.get(file), opts);
    }

    try {
      baselineCommit = await commitPaths("chore: sync pending changes", baselineFiles, opts);
    } finally {
      for (const file of baselineFiles) {
        restoreFileState(file, finalSnapshots.get(file), opts);
      }
    }

    if (baselineCommit.committed) {
      log(opts, `  baseline sync commit created ${baselineCommit.hash}`);
    } else if (baselineCommit.reason !== "no staged changes") {
      log(opts, `  baseline sync skipped: ${baselineCommit.reason}`);
    }
  }

  const header = buildCommitHeader(task);
  const taskFiles = [...(await listChangedFiles(opts))].sort();
  let taskCommit;
  try {
    taskCommit = await commitPaths(header, taskFiles, opts);
  } catch (error) {
    if (baselineCommit.committed) {
      try {
        await git(["reset", "--soft", "HEAD~1"], opts);
      } catch (rollbackError) {
        error.message = `${error.message} (baseline rollback failed: ${formatGitError(rollbackError)})`;
      }
    }
    await stagePaths(taskFiles, opts);
    throw error;
  }

  return {
    ...taskCommit,
    baselineCommit
  };
}

function formatGitError(error) {
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  const message = String(error?.message ?? "").trim();
  return stderr || stdout || message || "unknown git error";
}

async function rollbackDoneTaskOnCommitFailure(task, error, opts) {
  const details = `Auto-commit failed after Done transition: ${formatGitError(error)}`;
  await transitionToFailed(task, "commit", details, opts);
  const state = readSprintState(opts.stateFile);
  const failedTask = Array.isArray(state.tasks)
    ? state.tasks.find((item) => item?.id === task.id)
    : null;
  if (failedTask) {
    failedTask.completedAt = "";
    failedTask.verification = "";
    fs.writeFileSync(opts.stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  }
  await journalEntry(task, "Auto-commit failed; task reverted to Failed", opts, {
    signals: ["auto-commit-rollback"]
  });
  return details;
}

async function finalizeDoneTaskCommit(task, opts) {
  try {
    const commitResult = await autoCommitTask(task, opts);
    return {
      ok: true,
      commitResult,
      details: commitResult.committed
        ? `all gates passed; committed ${commitResult.hash}`
        : `all gates passed; commit skipped (${commitResult.reason})`
    };
  } catch (error) {
    return {
      ok: false,
      error,
      details: await rollbackDoneTaskOnCommitFailure(task, error, opts)
    };
  }
}

// ---------------------------------------------------------------------------
// Single cycle
// ---------------------------------------------------------------------------

/**
 * Run one decision loop cycle.
 * @returns {Promise<{ done: boolean, task: object | null, action: string, details: string }>}
 */
async function runCycle(bridge, pitfalls, gateConfig, opts) {
  // 1. Get next task
  const nextArgs = ["next", "--json"];
  if (opts.strict) {
    nextArgs.push("--strict");
  }
  const { stdout, stderr, exitCode } = await sprintBoard(nextArgs, opts);
  const nextError = extractNextError(stdout);
  const trimmed = stdout.trim();

  if (exitCode !== 0) {
    if (nextError?.code === "HUMAN_BOARD_BLOCKED") {
      return {
        done: true,
        task: null,
        action: "human-board-blocked",
        details: formatHumanBoardBlockedDetails(nextError)
      };
    }

    const errorDetails = nextError?.message ?? stderr.trim() ?? `exit code ${exitCode}`;
    throw new Error(`sprint-board next --json failed: ${errorDetails}`);
  }

  if (!trimmed) {
    return { done: true, task: null, action: "sprint-complete", details: "No actionable tasks remaining." };
  }

  if (nextError?.code === "HUMAN_BOARD_BLOCKED") {
    return {
      done: true,
      task: null,
      action: "human-board-blocked",
      details: formatHumanBoardBlockedDetails(nextError)
    };
  }

  const nextParse = tryParseJson(trimmed);
  if (!nextParse.parsed) {
    return { done: true, task: null, action: "parse-error", details: `Could not parse next output: ${stdout.slice(0, 200)}` };
  }

  const next = nextParse.value;

  // sprint-board next returns null when no actionable tasks remain
  if (next === null || next === undefined) {
    return { done: true, task: null, action: "sprint-complete", details: "All tasks are Done or no actionable tasks." };
  }

  if (typeof next === "object" && next !== null && "error" in next) {
    const error = /** @type {{ code?: string, message?: string, context?: Record<string, unknown> } } */ (next.error);
    if (error?.code === "HUMAN_BOARD_BLOCKED") {
      return {
        done: true,
        task: null,
        action: "human-board-blocked",
        details: formatHumanBoardBlockedDetails(error)
      };
    }
    throw new Error(`sprint-board next --json returned error: ${error?.message ?? "unknown error"}`);
  }

  const humanBoardInstructions = Array.isArray(next.human_board_instructions)
    ? next.human_board_instructions
        .filter((item) => item && typeof item === "object")
        .map((item) => ({
          lineNumber: Number(item.lineNumber ?? 0),
          text: String(item.text ?? "")
        }))
    : [];
  const humanBoardBlock = formatHumanBoardInstructionBlock(humanBoardInstructions);
  const task = next.task ?? next;
  const action = next.action ?? "start-task";

  log(opts, `\n--- Cycle: ${task.id} (${task.state ?? "Backlog"}) action=${action} ---`);
  if (humanBoardBlock) {
    log(opts, `  human-board instruction(s) injected into delegate prompt (${humanBoardInstructions.length} item(s))`);
  }

  // 2. Build pitfall context
  const pitfallContext = injectPitfallContext(task, pitfalls);
  if (pitfallContext) {
    log(opts, `  pitfall context injected (${pitfalls.filter((p) => p.taskId === task.id || !p.taskId).length} entries)`);
  }

  // 3. Branch on action
  switch (action) {
    case "start-task": {
      // Backlog → In Progress → dispatch
      await ensureTaskBaseline(task, opts);
      await transitionToInProgress(task, opts);
      const result = await dispatchTask(task, bridge, pitfallContext, humanBoardBlock, opts);
      if (result.dryRun || result.success) {
        if (!result.dryRun && humanBoardInstructions.length > 0) {
          const acknowledgmentSource = bridge.colony ? result : result.logFile;
          const acknowledgments = extractHumanBoardAcknowledgments(acknowledgmentSource, humanBoardInstructions);
          if (acknowledgments) {
            appendHumanBoardAuditEntry(opts.journalFile, task, acknowledgments, result.logFile);
          }
        }
        await transitionToReview(task, opts);
        await journalEntry(task, "Dispatched and moved to Review", opts);
        return { done: false, task, action: "dispatched→review", details: `dispatch success` };
      }
      // Dispatch failed
      await transitionToFailedWithRecovery(task, "dispatch", {
        exitCode: Number(result.exitCode ?? 1),
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? `Agent failed: exitCode=${result.exitCode}`),
        output: `Agent failed: exitCode=${result.exitCode}`
      }, opts);
      await journalEntry(task, `Dispatch failed: exitCode=${result.exitCode}`, opts);
      return { done: false, task, action: "dispatch-failed", details: `exitCode=${result.exitCode}` };
    }

    case "continue-implementation": {
      // In Progress → re-dispatch
      await ensureTaskBaseline(task, opts);
      const result = await dispatchTask(task, bridge, pitfallContext, humanBoardBlock, opts);
      if (result.dryRun || result.success) {
        if (!result.dryRun && humanBoardInstructions.length > 0) {
          const acknowledgmentSource = bridge.colony ? result : result.logFile;
          const acknowledgments = extractHumanBoardAcknowledgments(acknowledgmentSource, humanBoardInstructions);
          if (acknowledgments) {
            appendHumanBoardAuditEntry(opts.journalFile, task, acknowledgments, result.logFile);
          }
        }
        await transitionToReview(task, opts);
        await journalEntry(task, "Continued implementation → Review", opts);
        return { done: false, task, action: "continued→review", details: "success" };
      }
      await transitionToFailedWithRecovery(task, "dispatch", {
        exitCode: Number(result.exitCode ?? 1),
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? "Re-dispatch failed"),
        output: "Re-dispatch failed"
      }, opts);
      return { done: false, task, action: "continue-failed", details: "dispatch failed" };
    }

    case "run-review": {
      // Review → run review gate
      const gateResult = await runGateSequence(
        { buildCommand: gateConfig.buildCommand, reviewCommand: gateConfig.reviewCommand },
        opts
      );
      if (gateResult.passed || opts.dryRun) {
        await transitionToTesting(task, opts);
        await journalEntry(task, "Review gates passed → Testing", opts);
        return { done: false, task, action: "review→testing", details: "gates passed" };
      }
      await transitionToFailedWithRecovery(task, gateResult.gate, gateResult, opts);
      if (gateResult.gate === "review") {
        await createReviewFixTasks(task, gateResult.output, opts);
      }
      await journalEntry(task, `Review gate "${gateResult.gate}" failed`, opts);
      return { done: false, task, action: "review-failed", details: `gate: ${gateResult.gate}` };
    }

    case "run-acceptance": {
      // Testing → run acceptance gate
      const gateResult = await runGateSequence(gateConfig, opts);
      if (gateResult.passed || opts.dryRun) {
        await transitionToDone(task, opts);
        await journalEntry(task, "All gates passed → Done", opts);
        return {
          done: false,
          task,
          action: "testing→done",
          details: "all gates passed"
        };
      }
      await transitionToFailedWithRecovery(task, gateResult.gate, gateResult, opts);
      await journalEntry(task, `Acceptance gate "${gateResult.gate}" failed`, opts);
      return { done: false, task, action: "acceptance-failed", details: `gate: ${gateResult.gate}` };
    }

    case "fix-and-retest": {
      // Failed → re-dispatch with pitfall context
      await ensureTaskBaseline(task, opts);
      await transitionToInProgress(task, opts);
      const result = await dispatchTask(task, bridge, pitfallContext, humanBoardBlock, opts);
      if (result.dryRun || result.success) {
        if (!result.dryRun && humanBoardInstructions.length > 0) {
          const acknowledgmentSource = bridge.colony ? result : result.logFile;
          const acknowledgments = extractHumanBoardAcknowledgments(acknowledgmentSource, humanBoardInstructions);
          if (acknowledgments) {
            appendHumanBoardAuditEntry(opts.journalFile, task, acknowledgments, result.logFile);
          }
        }
        await transitionToReview(task, opts);
        await journalEntry(task, "Fix dispatched → Review", opts);
        return { done: false, task, action: "fix→review", details: "fix dispatched" };
      }
      await transitionToFailedWithRecovery(task, "dispatch", {
        exitCode: Number(result.exitCode ?? 1),
        stdout: String(result.stdout ?? ""),
        stderr: String(result.stderr ?? "Fix dispatch failed"),
        output: "Fix dispatch failed"
      }, opts);
      return { done: false, task, action: "fix-failed", details: "dispatch failed" };
    }

    default:
      log(opts, `  unknown action: ${action}, skipping`);
      return { done: false, task, action: "unknown", details: action };
  }
}

// ---------------------------------------------------------------------------
// Journal helper
// ---------------------------------------------------------------------------

async function journalEntry(task, summary, opts, extra = {}) {
  if (opts.dryRun) return;
  const args = [
    "journal",
    "--task", extra.taskId ?? task.id,
    "--summary", summary,
  ];

  if (Array.isArray(extra.files) && extra.files.length > 0) {
    args.push("--files", extra.files.join(","));
  }

  if (Array.isArray(extra.signals) && extra.signals.length > 0) {
    args.push("--signals", extra.signals.join(","));
  }

  await sprintBoard(args, opts);
}

async function appendCycleBoundaryEntry(cycle, result, pendingTasks, stopCondition, opts) {
  const parts = [
    `cycle-boundary: Cycle ${cycle} of ${opts.maxCycles} closed`,
    `action=${result.action}`,
    `pending=${pendingTasks}`
  ];

  if (stopCondition?.stop) {
    parts.push(stopCondition.reason);
  } else if (result.details) {
    parts.push(result.details);
  }

  if (result.commitHash) {
    parts.push(`commit=${result.commitHash}`);
  }

  await journalEntry(
    result.task ?? { id: `cycle-${cycle}` },
    parts.join(" | "),
    opts,
    {
      taskId: "cycle-boundary",
      files: result.commitFiles ?? [],
      signals: result.commitHash ? [`commit=${result.commitHash}`] : []
    }
  );
}

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

function log(opts, message) {
  if (opts.json) return;
  process.stdout.write(message + "\n");
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function runLoop(opts) {
  const gateConfig = readQualityGateConfig();

  // 2. Init Colony bridge
  const bridge = new ColonyBridge({
    workDir: opts.workDir ?? process.cwd(),
    useColony: !opts.noColony,
  });

  if (!opts.dryRun) {
    const colonyReady = await bridge.init();
    log(opts, colonyReady
      ? `Colony initialized (${bridge.registeredAdapters.length} adapter(s): ${bridge.registeredAdapters.join(", ")})`
      : "Colony unavailable — using spawn fallback."
    );
  }

  // 3. Run cycles
  const results = [];
  let cycle = 0;

  try {
    while (cycle < opts.maxCycles) {
      cycle++;
      const context = readCycleContext(opts);
      log(opts, `\n========== Cycle ${cycle} of ${opts.maxCycles} (max) ==========`);
      log(
        opts,
        `  cycle context: human-board=${context.humanBoardInstructions.length} unchecked, journal entries=${context.journalEntryCount}`
      );

      let pitfalls = await loadUnresolvedPitfalls(opts);
      if (pitfalls.length > 0) {
        log(opts, `Loaded ${pitfalls.length} unresolved pitfall(s).`);
      }

      const cycleSteps = [];
      let result = null;

      while (true) {
        result = await runCycle(bridge, pitfalls, gateConfig, opts);
        cycleSteps.push(result);

        if (result.done) {
          const state = readSprintState(opts.stateFile);
          const stopCondition = detectStopCondition(state);
          const pendingTasks = countPendingTasks(state);
          const cycleResult = {
            cycle,
            task: result.task,
            action: result.action,
            details: result.details,
            done: true,
            completedTask: false,
            pendingTasks,
            stopCondition,
            steps: cycleSteps
          };
          await appendCycleBoundaryEntry(cycle, cycleResult, pendingTasks, stopCondition, opts);
          results.push(cycleResult);
          log(opts, `\nLoop finished: ${result.details}`);
          break;
        }

        log(opts, `  result: ${result.action} — ${result.details}`);

        const state = readSprintState(opts.stateFile);
        const stopCondition = detectStopCondition(state);
        const pendingTasks = countPendingTasks(state);

        if (stopCondition.stop) {
          const cycleResult = {
            cycle,
            task: result.task,
            action: "stop-condition",
            details: stopCondition.reason,
            done: true,
            completedTask: false,
            pendingTasks,
            stopCondition,
            steps: cycleSteps
          };
          await appendCycleBoundaryEntry(cycle, cycleResult, pendingTasks, stopCondition, opts);
          results.push(cycleResult);
          log(opts, `\nLoop finished: ${stopCondition.reason}`);
          break;
        }

        if (opts.dryRun || result.action === "testing→done") {
          const cycleResult = {
            cycle,
            task: result.task,
            action: result.action,
            details: result.details,
            done: false,
            completedTask: result.action === "testing→done",
            pendingTasks,
            stopCondition,
            commitHash: result.commitHash ?? "",
            commitFiles: result.commitFiles ?? [],
            steps: cycleSteps
          };
          await appendCycleBoundaryEntry(cycle, cycleResult, pendingTasks, stopCondition, opts);

          if (!opts.dryRun && result.action === "testing→done" && result.task) {
            const finalizeResult = await finalizeDoneTaskCommit(result.task, opts);
            const updatedState = readSprintState(opts.stateFile);
            cycleResult.pendingTasks = countPendingTasks(updatedState);
            cycleResult.stopCondition = detectStopCondition(updatedState);

            if (finalizeResult.ok) {
              const { commitResult } = finalizeResult;
              cycleResult.commitHash = commitResult.hash;
              cycleResult.commitFiles = commitResult.files;
              cycleResult.details = finalizeResult.details;

              if (commitResult.committed) {
                log(opts, `  auto-commit created ${commitResult.hash}`);
              } else {
                log(opts, `  auto-commit skipped: ${commitResult.reason}`);
              }
            } else {
              cycleResult.action = "commit-failed";
              cycleResult.completedTask = false;
              cycleResult.details = finalizeResult.details;
              log(opts, `  auto-commit failed: ${formatGitError(finalizeResult.error)}`);
            }
          }

          results.push(cycleResult);
          break;
        }

        pitfalls = await loadUnresolvedPitfalls(opts);
      }

      const last = results[results.length - 1];

      if (last.done) {
        break;
      }

      if (opts.dryRun) {
        log(opts, "\nDry-run executed one preview cycle. Stopping.");
        break;
      }

      if (opts.singleCycle) {
        log(opts, "\nSingle-cycle mode enabled. Stopping after one cycle.");
        break;
      }

      if (last.pendingTasks <= 0) {
        log(opts, "\nLoop finished: No pending tasks remain.");
        break;
      }

      if (last.stopCondition?.stop) {
        log(opts, `\nLoop finished: ${last.stopCondition.reason}`);
        break;
      }

      log(opts, `\nCycle ${cycle} complete. Pending tasks remain (${last.pendingTasks}). Restarting.`);
    }

    if (cycle >= opts.maxCycles) {
      log(opts, `\nMax cycles (${opts.maxCycles}) reached. Stopping.`);
    }
  } finally {
    if (!opts.dryRun) {
      await bridge.shutdown();
    }
  }

  // 4. Final report
  if (opts.json) {
    process.stdout.write(JSON.stringify({ cycles: cycle, results }, null, 2) + "\n");
  } else {
    log(opts, `\n--- Summary: ${cycle} cycle(s) ---`);
    for (const r of results) {
      const taskLabel = r.task ? r.task.id : "(none)";
      log(opts, `  ${r.cycle}. ${taskLabel}: ${r.action} — ${r.details}`);
    }
  }

  // Return summary for bin/va-auto-pilot.mjs
  return { cycles: cycle, results };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

const BOOL_FLAGS = new Set(["dry-run", "single-cycle", "no-commit", "no-colony", "json", "help", "strict"]);

function printHelp() {
  console.log(`auto-pilot-loop — Autonomous Decision Loop

Usage:
  node scripts/auto-pilot-loop.mjs [options]

Options:
  --max-cycles <n>        Maximum task cycles (default: 50)
  --max-parallel <n>      Parallel track count (default: 3)
  --agent-template <cmd>  Agent command template (default: "claude --task {taskId}")
  --single-cycle          Run exactly one task cycle, then exit
  --dry-run               Print plan without executing
  --no-commit             Skip git add/git commit after gates pass
  --no-colony             Skip Colony, use raw spawn
  --strict                Keep human-board Instructions as a hard block
  --track-timeout <ms>    Per-task timeout in ms (default: 600000)
  --json                  JSON output
  --help                  Show this help
`);
}

export { runLoop, runCycle, readHumanBoard, loadUnresolvedPitfalls, injectPitfallContext, runGateSequence };
export { extractHumanBoardAcknowledgments, appendHumanBoardAuditEntry };
export {
  deriveCommitType,
  deriveCommitScope,
  buildCommitHeader,
  detectStopCondition,
  autoCommitTask,
  finalizeDoneTaskCommit,
  extractCreatedTaskId,
  createReviewFixTasks
};

async function main() {
  const parsed = parseArgv(process.argv.slice(2), BOOL_FLAGS);

  if (parsed.flags.has("help")) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    maxCycles: parseInt(parsed.options["max-cycles"] ?? "50", 10),
    maxParallel: parseInt(parsed.options["max-parallel"] ?? "3", 10),
    agentTemplate: parsed.options["agent-template"] ?? "claude --task {taskId}",
    dryRun: parsed.flags.has("dry-run"),
    singleCycle: parsed.flags.has("single-cycle"),
    noCommit: parsed.flags.has("no-commit"),
    noColony: parsed.flags.has("no-colony"),
    trackTimeout: parseInt(parsed.options["track-timeout"] ?? "600000", 10),
    json: parsed.flags.has("json"),
    strict: parsed.flags.has("strict"),
    stateFile: path.resolve(parsed.options["state-file"] ?? resolveDefaults().stateFile),
    boardFile: path.resolve(parsed.options["board-file"] ?? resolveDefaults().boardFile),
    journalFile: path.resolve(parsed.options["journal-file"] ?? resolveDefaults().journalFile),
    pitfallsFile: path.resolve(parsed.options["pitfalls-file"] ?? ".va-auto-pilot/pitfalls.json"),
    workDir: process.cwd(),
    taskBaselines: new Map(),
  };

  if (opts.singleCycle) {
    opts.maxCycles = 1;
  }

  try {
    await runLoop(opts);
  } catch (err) {
    console.error(`auto-pilot-loop error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
