#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  nowIso,
  resolveDefaults,
  parseArgv,
  requireOption
} from "./lib/sprint-utils.mjs";
import { ColonyBridge } from "./lib/colony-bridge.mjs";
import { splitShellCommand } from "./lib/shell-split.mjs";
import { DEFAULT_TRACK_TIMEOUT_MS } from "./lib/constants.mjs";

const VALID_STATES = new Set(["Backlog", "In Progress", "Review", "Testing", "Failed", "Done"]);
const DEFAULT_MAX_WORKERS = 4;
const DEFAULT_LOG_DIR = ".va-auto-pilot/parallel-runs";
// Default track timeout: 10 minutes.  Override with --track-timeout <ms>.

const DEFAULTS = resolveDefaults();

function printHelp() {
  console.log(`va-parallel-runner

Usage:
  node scripts/va-parallel-runner.mjs spawn --plan-file <path> [options]

Options:
  --plan-file <path>          Parallel plan JSON from sprint-board plan command
  --agent-cmd <template>      Command template for tracks, supports {taskId}
  --max-workers <n>           Max concurrent track workers (default: ${DEFAULT_MAX_WORKERS})
  --track-timeout <ms>        Per-track timeout in milliseconds (default: ${DEFAULT_TRACK_TIMEOUT_MS})
  --log-dir <path>            Track log directory (default: ${DEFAULT_LOG_DIR})
  --state-file <path>         Sprint state file path
  --board-file <path>         Sprint board markdown path
  --journal-file <path>       Run journal path
  --skip-state-update         Do not write task state updates
  --dry-run                   Print planned commands, do not execute
  --no-colony                 Disable Colony dispatch (use raw spawn instead)
  --json                      Print result as JSON
  --help                      Show help

Plan shape:
{
  "primaryTaskId": "AP-001",
  "parallelTracks": ["AP-002", {"taskId":"AP-003","command":"..."}],
  "dependencyGraph": {"AP-002":[],"AP-003":["AP-001"]},
  "syncPoints": ["quality-gates"]
}

Note on quality gates:
  The parallel runner records subprocess exit codes but does NOT itself run
  quality gates (build / review / acceptance).  Each agent command is expected
  to run the required gates as part of its own execution before exiting 0.
  A successful exit only moves the task to Review state; the manager agent
  must still complete the multi-perspective review and acceptance stages.
`);
}

function normalizeTrack(track) {
  if (typeof track === "string") {
    return { taskId: track, command: "" };
  }

  if (track && typeof track === "object" && typeof track.taskId === "string") {
    return {
      taskId: track.taskId,
      command: typeof track.command === "string" ? track.command : ""
    };
  }

  throw new Error("Invalid parallel track entry. Expected string taskId or object with taskId.");
}

function readPlan(planFile) {
  if (!fs.existsSync(planFile)) {
    throw new Error(`File not found: ${planFile}`);
  }
  const raw = JSON.parse(fs.readFileSync(planFile, "utf8"));
  const tracks = Array.isArray(raw.parallelTracks) ? raw.parallelTracks.map(normalizeTrack) : [];
  return {
    primaryTaskId: String(raw.primaryTaskId ?? ""),
    primaryAction: String(raw.primaryAction ?? ""),
    parallelTracks: tracks,
    dependencyGraph:
      raw.dependencyGraph && typeof raw.dependencyGraph === "object" ? raw.dependencyGraph : {},
    syncPoints: Array.isArray(raw.syncPoints) ? raw.syncPoints.map((item) => String(item)) : []
  };
}

function buildTrackCommand(track, agentTemplate) {
  if (track.command) return track.command;
  if (!agentTemplate) {
    throw new Error(
      `Track ${track.taskId} is missing command and no --agent-cmd template was provided.`
    );
  }
  return agentTemplate.includes("{taskId}")
    ? agentTemplate.replaceAll("{taskId}", track.taskId)
    : agentTemplate;
}

function appendLog(logFile, message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, message, "utf8");
}

/**
 * Runs a single track command in a subprocess with an optional timeout.
 *
 * If the timeout expires the process is killed (SIGTERM, then SIGKILL after
 * 5 s) and the track is recorded as failed with reason "timeout".
 *
 * @param {object} track      - { taskId, command }
 * @param {string} command    - resolved shell command
 * @param {string} logFile    - path to the track log file
 * @param {number} timeoutMs  - max allowed run time in ms (0 = unlimited)
 */
// eslint-disable-next-line no-unused-vars -- retained for non-Colony fallback path
function runTrack(track, command, logFile, timeoutMs) {
  const startedAt = Date.now();
  appendLog(
    logFile,
    `[${nowIso()}] task=${track.taskId}\ncommand: ${command}\ntimeout: ${timeoutMs > 0 ? `${timeoutMs}ms` : "none"}\n---\n`
  );

  const argv = splitShellCommand(command);
  const [file, ...args] = argv;

  return new Promise((resolve) => {
    const child = spawn(file, args, {
      shell: false,
      env: { ...process.env, VA_TASK_ID: track.taskId }
    });

    let timedOut = false;
    let killTimer = null;

    if (timeoutMs > 0) {
      killTimer = setTimeout(() => {
        timedOut = true;
        appendLog(logFile, `\n[${nowIso()}] timeout after ${timeoutMs}ms — sending SIGTERM\n`);
        child.kill("SIGTERM");

        // Force-kill after 5 s if still running.
        setTimeout(() => {
          try { child.kill("SIGKILL"); } catch { /* already exited */ }
        }, 5_000);
      }, timeoutMs);
    }

    child.stdout.on("data", (chunk) => {
      appendLog(logFile, chunk.toString());
    });

    child.stderr.on("data", (chunk) => {
      appendLog(logFile, chunk.toString());
    });

    child.on("close", (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      const durationMs = Date.now() - startedAt;
      appendLog(
        logFile,
        `\n---\n[${nowIso()}] exit code=${code ?? -1} signal=${signal ?? "-"} durationMs=${durationMs}${timedOut ? " (TIMEOUT)" : ""}\n`
      );
      resolve({
        taskId: track.taskId,
        command,
        success: code === 0 && !timedOut,
        exitCode: code ?? -1,
        signal: signal ?? "",
        durationMs,
        timedOut,
        logFile
      });
    });
  });
}

async function runWithWorkerPool(items, maxWorkers, worker) {
  const results = Array(items.length);
  let cursor = 0;

  async function workerLoop() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  }

  const workerCount = Math.max(1, Math.min(maxWorkers, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => workerLoop()));
  return results;
}

function normalizeStateTask(task) {
  return {
    ...task,
    id: String(task.id ?? ""),
    state: String(task.state ?? "Backlog"),
    failCount: Number(task.failCount ?? 0),
    reason: String(task.reason ?? ""),
    startedAt: String(task.startedAt ?? ""),
    lastFailedAt: String(task.lastFailedAt ?? "")
  };
}

function readState(stateFile) {
  if (!fs.existsSync(stateFile)) {
    throw new Error(`State file not found: ${stateFile}`);
  }
  const raw = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  if (!Array.isArray(raw.tasks)) {
    throw new Error("Invalid sprint state file: tasks must be an array");
  }
  raw.tasks = raw.tasks.map(normalizeStateTask);
  return raw;
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderBoard(stateFile, boardFile) {
  const sprintBoardScript = path.resolve(process.cwd(), "scripts/sprint-board.mjs");
  if (!fs.existsSync(sprintBoardScript)) return;

  const child = spawn("node", [sprintBoardScript, "render", "--state-file", stateFile, "--board-file", boardFile], {
    stdio: "ignore"
  });

  return new Promise((resolve) => {
    child.on("close", () => resolve());
    child.on("error", () => resolve());
  });
}

function appendJournalEntry(journalFile, payload) {
  const lines = [];
  lines.push(`## ${nowIso()} - parallel-runner`);
  lines.push(
    `- Summary: synchronized ${payload.results.length} parallel track(s) before quality gates.`
  );
  lines.push(`- Primary Task: ${payload.primaryTaskId || "-"}`);
  lines.push(
    `- Tracks: ${payload.results.map((item) => `${item.taskId}:${item.success ? "PASS" : item.timedOut ? "TIMEOUT" : "FAIL"}`).join(", ")}`
  );
  if (payload.syncPoints.length > 0) {
    lines.push(`- Sync Points: ${payload.syncPoints.join(", ")}`);
  }
  lines.push("- Files:");
  for (const result of payload.results) {
    lines.push(`  - \`${result.logFile}\``);
  }
  lines.push(
    "- Note: exit-0 moves task to Review; manager agent must still run multi-perspective review and acceptance gates."
  );
  lines.push("---");

  fs.mkdirSync(path.dirname(journalFile), { recursive: true });
  const prefix = fs.existsSync(journalFile)
    ? "\n"
    : "# Run Journal\n\n## Codebase Signals\n- Add reusable patterns and gotchas here.\n\n## Entries\n";
  fs.appendFileSync(journalFile, `${prefix}${lines.join("\n")}\n`, "utf8");
}

function applyStateTransitions(state, tracks, resultsByTaskId) {
  const tasksById = new Map(state.tasks.map((task) => [task.id, task]));
  const timestamp = nowIso();
  const runnableStates = new Set(["Backlog", "In Progress"]);
  const mutableTaskIds = new Set();

  for (const track of tracks) {
    const task = tasksById.get(track.taskId);
    if (!task) continue;
    if (!VALID_STATES.has(task.state) || !runnableStates.has(task.state)) continue;
    mutableTaskIds.add(track.taskId);
    if (task.state === "Backlog") {
      task.state = "In Progress";
      if (!task.startedAt) task.startedAt = timestamp;
    }
  }

  for (const track of tracks) {
    if (!mutableTaskIds.has(track.taskId)) continue;

    const task = tasksById.get(track.taskId);
    const result = resultsByTaskId.get(track.taskId);
    if (!task || !result) continue;

    if (result.success) {
      // Subprocess exited 0.  The agent is responsible for having run
      // build / review / acceptance gates before exiting.  We move to
      // Review so the manager agent can complete multi-perspective review.
      task.state = "Review";
      task.reason = "";
      // Propagate Colony evidence (verification, artifacts) to sprint state
      if (result.evidence?.verification) {
        task.verification = result.evidence.verification;
      }
      continue;
    }

    task.state = "Failed";
    task.failCount += 1;
    task.lastFailedAt = timestamp;
    task.reason = result.timedOut
      ? `parallel track timed out after ${result.durationMs}ms`
      : `parallel track exited with code ${result.exitCode}`;
    // Propagate Colony failure detail to sprint state
    if (result.evidence?.failureDetail) {
      task.failureDetail = result.evidence.failureDetail;
    }
  }

  state.updatedAt = timestamp;
}

function formatSummary(plan, results) {
  return {
    generatedAt: nowIso(),
    primaryTaskId: plan.primaryTaskId,
    primaryAction: plan.primaryAction,
    syncPoints: plan.syncPoints,
    results,
    failedTracks: results.filter((item) => !item.success).map((item) => item.taskId)
  };
}

async function spawnTracks(parsed) {
  const planFile = path.resolve(requireOption(parsed.options, "plan-file"));
  const plan = readPlan(planFile);

  if (plan.parallelTracks.length === 0) {
    const emptySummary = formatSummary(plan, []);
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(emptySummary, null, 2));
    } else {
      console.log("No parallel tracks in plan.");
    }
    return 0;
  }

  const agentTemplate = parsed.options["agent-cmd"] ?? "";

  const rawMaxWorkers = parsed.options["max-workers"] ?? String(DEFAULT_MAX_WORKERS);
  const maxWorkers = Number.parseInt(String(rawMaxWorkers), 10);
  if (!Number.isFinite(maxWorkers) || maxWorkers <= 0) {
    throw new Error("Invalid --max-workers value. Expected a positive integer.");
  }

  const rawTimeout = parsed.options["track-timeout"] ?? String(DEFAULT_TRACK_TIMEOUT_MS);
  const trackTimeoutMs = Number.parseInt(String(rawTimeout), 10);
  if (!Number.isFinite(trackTimeoutMs) || trackTimeoutMs < 0) {
    throw new Error("Invalid --track-timeout value. Expected a non-negative integer (ms).");
  }

  const logDir = path.resolve(parsed.options["log-dir"] ?? DEFAULT_LOG_DIR);
  const tracks = plan.parallelTracks.map((track) => ({
    ...track,
    command: buildTrackCommand(track, agentTemplate)
  }));

  // Initialise ColonyBridge (Colony is default; --no-colony disables it)
  const useColony = !parsed.flags.has("no-colony");
  const bridge = new ColonyBridge({
    workDir: process.cwd(),
    useColony,
  });
  const colonyReady = await bridge.init();
  if (useColony && !colonyReady) {
    console.error("Info: Colony not available (no agents detected). Falling back to spawn.");
  }

  let results;
  if (parsed.flags.has("dry-run")) {
    results = tracks.map((track) => ({
      taskId: track.taskId,
      command: track.command,
      success: true,
      exitCode: 0,
      signal: "",
      durationMs: 0,
      timedOut: false,
      logFile: path.join(logDir, `${track.taskId}.log`),
      dryRun: true
    }));
  } else {
    results = await runWithWorkerPool(tracks, maxWorkers, async (track) => {
      const logFile = path.join(logDir, `${track.taskId}.log`);
      return bridge.dispatch(track, agentTemplate, logFile, trackTimeoutMs);
    });
    await bridge.shutdown();
  }

  const shouldUpdateState = !parsed.flags.has("skip-state-update");
  const stateFile = path.resolve(parsed.options["state-file"] ?? DEFAULTS.stateFile);
  const boardFile = path.resolve(parsed.options["board-file"] ?? DEFAULTS.boardFile);
  const journalFile = path.resolve(parsed.options["journal-file"] ?? DEFAULTS.journalFile);

  if (shouldUpdateState && !parsed.flags.has("dry-run")) {
    const state = readState(stateFile);
    const resultMap = new Map(results.map((result) => [result.taskId, result]));
    applyStateTransitions(state, tracks, resultMap);
    writeJsonFile(stateFile, state);
    await renderBoard(stateFile, boardFile);
  }

  if (!parsed.flags.has("dry-run")) {
    appendJournalEntry(journalFile, {
      primaryTaskId: plan.primaryTaskId,
      syncPoints: plan.syncPoints,
      results
    });
  }

  const summary = formatSummary(plan, results);
  if (parsed.flags.has("json")) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`Primary: ${summary.primaryTaskId || "-"}`);
    console.log(
      `Tracks : ${summary.results.length === 0 ? "-" : summary.results.map((item) => item.taskId).join(", ")}`
    );
    for (const result of summary.results) {
      const marker = result.timedOut ? "TIMEOUT" : result.success ? "PASS" : "FAIL";
      console.log(
        `- ${result.taskId}: ${marker} (exit=${result.exitCode}, ${Math.round(result.durationMs / 1000)}s)`
      );
    }
    console.log(
      `Sync   : ${summary.syncPoints.length === 0 ? "-" : summary.syncPoints.join(", ")}`
    );
  }

  return summary.failedTracks.length > 0 ? 1 : 0;
}

async function main() {
  const parsed = parseArgv(process.argv.slice(2), new Set(["json", "help", "dry-run", "skip-state-update", "no-colony"]));
  if (!parsed.command || parsed.flags.has("help") || parsed.command === "help") {
    printHelp();
    return 0;
  }

  if (parsed.command !== "spawn") {
    throw new Error(`Unknown command: ${parsed.command}`);
  }

  return spawnTracks(parsed);
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error) => {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
