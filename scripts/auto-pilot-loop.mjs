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
 *   --max-cycles <n>        Maximum loop iterations (default: 20)
 *   --max-parallel <n>      Parallel track count (default: 3)
 *   --agent-template <cmd>  Agent command template (default: "claude --task {taskId}")
 *   --dry-run               Print plan without executing
 *   --no-colony             Skip Colony, use raw spawn
 *   --track-timeout <ms>    Per-task timeout (default: 600000)
 *   --json                  JSON output
 */

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parseArgv, nowIso, readQualityGateConfig } from "./lib/sprint-utils.mjs";
import {
  resolveHumanBoardPath,
  readHumanBoardInstructions
} from "./lib/human-board.mjs";
import { ColonyBridge } from "./lib/colony-bridge.mjs";

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
async function sprintBoard(args) {
  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath, [SPRINT_BOARD, ...args], { encoding: "utf8", timeout: 30_000 }
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
async function loadUnresolvedPitfalls() {
  const { stdout, exitCode } = await sprintBoard(["pitfall", "--list", "--unresolved", "--json"]);
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
 * @returns {Promise<{ passed: boolean, gate: string, output: string }>}
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
        { encoding: "utf8", timeout: 300_000 }
      );
      log(opts, `  gate "${gate.name}" PASSED`);
    } catch (err) {
      const output = (err.stdout ?? "") + "\n" + (err.stderr ?? err.message);
      log(opts, `  gate "${gate.name}" FAILED`);
      return { passed: false, gate: gate.name, output: output.slice(0, 2000) };
    }
  }

  return { passed: true, gate: "", output: "" };
}

// ---------------------------------------------------------------------------
// Task dispatch
// ---------------------------------------------------------------------------

/**
 * Dispatch a task to a sub-agent.
 * @param {object} task
 * @param {ColonyBridge} bridge
 * @param {string} pitfallContext
 * @param {object} opts
 * @returns {Promise<object>}
 */
async function dispatchTask(task, bridge, pitfallContext, opts) {
  const template = opts.agentTemplate.replace("{taskId}", task.id);
  const logDir = path.resolve(".va-auto-pilot/parallel-runs");
  const logFile = path.join(logDir, `${task.id}-${Date.now()}.log`);

  const track = {
    taskId: task.id,
    command: template,
    title: task.title + (pitfallContext ? pitfallContext : ""),
    priority: task.priority,
    dependsOn: task.dependsOn,
    notes: task.notes,
  };

  if (opts.dryRun) {
    log(opts, `  [dry-run] would dispatch ${task.id} via: ${template}`);
    return { taskId: task.id, success: true, dryRun: true };
  }

  log(opts, `  dispatching ${task.id} via: ${template}`);
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
  ]);
}

async function transitionToReview(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Review",
  ]);
}

async function transitionToTesting(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Testing",
  ]);
}

async function transitionToDone(task, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Done",
    "--verification", `Auto-pilot loop: all gates passed at ${nowIso()}`,
  ]);
}

async function transitionToFailed(task, gate, output, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "update", "--id", task.id, "--state", "Failed",
    "--failure-type", "gate",
    "--failure-attempted", `auto-pilot gate: ${gate}`,
    "--failure-hypothesis", output.slice(0, 500),
  ]);
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
  const { stdout, stderr, exitCode } = await sprintBoard(["next", "--json"]);
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

  const task = next.task ?? next;
  const action = next.action ?? "start-task";

  log(opts, `\n--- Cycle: ${task.id} (${task.state ?? "Backlog"}) action=${action} ---`);

  // 2. Build pitfall context
  const pitfallContext = injectPitfallContext(task, pitfalls);
  if (pitfallContext) {
    log(opts, `  pitfall context injected (${pitfalls.filter((p) => p.taskId === task.id || !p.taskId).length} entries)`);
  }

  // 3. Branch on action
  switch (action) {
    case "start-task": {
      // Backlog → In Progress → dispatch
      await transitionToInProgress(task, opts);
      const result = await dispatchTask(task, bridge, pitfallContext, opts);
      if (result.dryRun || result.success) {
        await transitionToReview(task, opts);
        await journalEntry(task, "Dispatched and moved to Review", opts);
        return { done: false, task, action: "dispatched→review", details: `dispatch success` };
      }
      // Dispatch failed
      await transitionToFailed(task, "dispatch", `Agent failed: exitCode=${result.exitCode}`, opts);
      await journalEntry(task, `Dispatch failed: exitCode=${result.exitCode}`, opts);
      return { done: false, task, action: "dispatch-failed", details: `exitCode=${result.exitCode}` };
    }

    case "continue-implementation": {
      // In Progress → re-dispatch
      const result = await dispatchTask(task, bridge, pitfallContext, opts);
      if (result.dryRun || result.success) {
        await transitionToReview(task, opts);
        await journalEntry(task, "Continued implementation → Review", opts);
        return { done: false, task, action: "continued→review", details: "success" };
      }
      await transitionToFailed(task, "dispatch", `Re-dispatch failed`, opts);
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
      await transitionToFailed(task, gateResult.gate, gateResult.output, opts);
      await journalEntry(task, `Review gate "${gateResult.gate}" failed`, opts);
      return { done: false, task, action: "review-failed", details: `gate: ${gateResult.gate}` };
    }

    case "run-acceptance": {
      // Testing → run acceptance gate
      const gateResult = await runGateSequence(gateConfig, opts);
      if (gateResult.passed || opts.dryRun) {
        await transitionToDone(task, opts);
        await journalEntry(task, "All gates passed → Done", opts);
        return { done: false, task, action: "testing→done", details: "all gates passed" };
      }
      await transitionToFailed(task, gateResult.gate, gateResult.output, opts);
      await journalEntry(task, `Acceptance gate "${gateResult.gate}" failed`, opts);
      return { done: false, task, action: "acceptance-failed", details: `gate: ${gateResult.gate}` };
    }

    case "fix-and-retest": {
      // Failed → re-dispatch with pitfall context
      await transitionToInProgress(task, opts);
      const result = await dispatchTask(task, bridge, pitfallContext, opts);
      if (result.dryRun || result.success) {
        await transitionToReview(task, opts);
        await journalEntry(task, "Fix dispatched → Review", opts);
        return { done: false, task, action: "fix→review", details: "fix dispatched" };
      }
      await transitionToFailed(task, "dispatch", "Fix dispatch failed", opts);
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

async function journalEntry(task, summary, opts) {
  if (opts.dryRun) return;
  await sprintBoard([
    "journal", "--task", task.id, "--summary", summary,
  ]);
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

  // 1. Read human board
  const boardPath = resolveHumanBoardPath();
  const uncheckedInstructions = readHumanBoard(boardPath);
  if (uncheckedInstructions.length > 0) {
    log(opts, `\n⚠ Human board has ${uncheckedInstructions.length} unchecked instruction(s):`);
    for (const instr of uncheckedInstructions) {
      log(opts, `  - ${instr}`);
    }
    log(opts, "Process these before continuing the loop.\n");
  }

  // 2. Load pitfalls
  const pitfalls = await loadUnresolvedPitfalls();
  if (pitfalls.length > 0) {
    log(opts, `Loaded ${pitfalls.length} unresolved pitfall(s).`);
  }

  // 3. Init Colony bridge
  const bridge = new ColonyBridge({
    workDir: process.cwd(),
    useColony: !opts.noColony,
  });

  if (!opts.dryRun) {
    const colonyReady = await bridge.init();
    log(opts, colonyReady
      ? `Colony initialized (${bridge.registeredAdapters.length} adapter(s): ${bridge.registeredAdapters.join(", ")})`
      : "Colony unavailable — using spawn fallback."
    );
  }

  // 4. Run cycles
  const results = [];
  let cycle = 0;

  try {
    while (cycle < opts.maxCycles) {
      cycle++;
      log(opts, `\n========== Cycle ${cycle}/${opts.maxCycles} ==========`);

      const result = await runCycle(bridge, pitfalls, gateConfig, opts);
      results.push({ cycle, ...result });

      if (result.done) {
        log(opts, `\nLoop finished: ${result.details}`);
        break;
      }

      log(opts, `  result: ${result.action} — ${result.details}`);

      // Reload pitfalls each cycle (they may have been updated)
      const freshPitfalls = await loadUnresolvedPitfalls();
      pitfalls.length = 0;
      pitfalls.push(...freshPitfalls);
    }

    if (cycle >= opts.maxCycles) {
      log(opts, `\nMax cycles (${opts.maxCycles}) reached. Stopping.`);
    }
  } finally {
    if (!opts.dryRun) {
      await bridge.shutdown();
    }
  }

  // 5. Final report
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

const BOOL_FLAGS = new Set(["dry-run", "no-colony", "json", "help"]);

function printHelp() {
  console.log(`auto-pilot-loop — Autonomous Decision Loop

Usage:
  node scripts/auto-pilot-loop.mjs [options]

Options:
  --max-cycles <n>        Maximum loop iterations (default: 20)
  --max-parallel <n>      Parallel track count (default: 3)
  --agent-template <cmd>  Agent command template (default: "claude --task {taskId}")
  --dry-run               Print plan without executing
  --no-colony             Skip Colony, use raw spawn
  --track-timeout <ms>    Per-task timeout in ms (default: 600000)
  --json                  JSON output
  --help                  Show this help
`);
}

export { runLoop, readHumanBoard, loadUnresolvedPitfalls, injectPitfallContext, runGateSequence };

async function main() {
  const parsed = parseArgv(process.argv.slice(2), BOOL_FLAGS);

  if (parsed.flags.has("help")) {
    printHelp();
    process.exit(0);
  }

  const opts = {
    maxCycles: parseInt(parsed.options["max-cycles"] ?? "20", 10),
    maxParallel: parseInt(parsed.options["max-parallel"] ?? "3", 10),
    agentTemplate: parsed.options["agent-template"] ?? "claude --task {taskId}",
    dryRun: parsed.flags.has("dry-run"),
    noColony: parsed.flags.has("no-colony"),
    trackTimeout: parseInt(parsed.options["track-timeout"] ?? "600000", 10),
    json: parsed.flags.has("json"),
  };

  try {
    await runLoop(opts);
  } catch (err) {
    console.error(`auto-pilot-loop error: ${err.message}`);
    process.exit(1);
  }
}

main();
