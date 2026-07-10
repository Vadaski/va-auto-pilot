#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  nowIso,
  resolveDefaults,
  parseArgv,
  requireOption
} from "./lib/sprint-utils.mjs";
import { suggestGateFromPitfall, suggestGatesFromPitfalls } from "./lib/adaptive-gates.mjs";
import { isWeakGateCommand } from "./lib/gate-trust.mjs";
import {
  resolveHumanBoardPath,
  readHumanBoardInstructions
} from "./lib/human-board.mjs";
import { VAPilotError } from "./lib/errors.mjs";
import {
  withPilotFileLock,
  writeJsonFileAtomicSync,
  writeTextFileAtomicSync
} from "./lib/pilot-state.mjs";
import {
  DEFAULT_EVAL_HISTORY_FILE,
  readEvalHistory,
  resolveEvalHistoryFile,
  summarizeEvalHistory,
} from "./lib/eval-history.mjs";
import { DEFAULT_SPRINT_BOARD_TIMEOUT_MS, DEFAULT_TASK_CLAIM_TTL_MS } from "./lib/constants.mjs";
import {
  VALID_STATES,
  PRIORITY_WEIGHT,
  DEFAULT_MAX_PARALLEL,
  normalizeDependsOn,
  normalizeTask,
  escapeCell,
  sortTasks,
  isDependencySatisfied,
  isClaimExpired,
  findNextTask,
  buildParallelPlan
} from "./lib/sprint-board/core.mjs";

const execFileAsync = promisify(execFile);

/**
 * @typedef {import("./lib/sprint-utils.mjs").Task} Task
 * @typedef {import("./lib/sprint-utils.mjs").SprintState} SprintState
 * @typedef {import("./lib/sprint-utils.mjs").FailureDetail} FailureDetail
 * @typedef {import("./lib/sprint-utils.mjs").ParsedArgv} ParsedArgv
 */

/**
 * @typedef {"Backlog" | "In Progress" | "Review" | "Testing" | "Failed" | "Done"} TaskState
 */

/**
 * @typedef {Object} NextTaskResult
 * @property {string} state
 * @property {string} action
 * @property {Task} task
 * @property {{ lineNumber: number, text: string }[]} [human_board_instructions]
 */

/**
 * @typedef {Object} ParallelPlan
 * @property {string} generatedAt
 * @property {string} primaryTaskId
 * @property {string} primaryAction
 * @property {string[]} parallelTracks
 * @property {Record<string, string[]>} dependencyGraph
 * @property {string[]} syncPoints
 */

/**
 * @typedef {Object} PitfallData
 * @property {number} version
 * @property {PitfallRecord[]} entries
 */

/**
 * @typedef {Object} PitfallRecord
 * @property {string} id
 * @property {string} taskId
 * @property {string} failureType
 * @property {string} attempted
 * @property {string} hypothesis
 * @property {string} missingContext
 * @property {string} resolution
 * @property {string | null} resolvedAt
 * @property {string} createdAt
 */

const DEFAULTS = resolveDefaults();
const DEFAULT_PITFALLS_FILE = ".va-auto-pilot/pitfalls.json";
const DEFAULT_CONFIG_FILE = ".va-auto-pilot/config.yaml";
const DEFAULT_CONSTRAINTS_DIR = ".va-auto-pilot/constraints";
const VALID_FAILURE_TYPES = ["gate", "acceptance", "review"];
const JOURNAL_VIEW_MAX_ACTIVE_SIGNALS = 80;
const CONSTRAINT_STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "in", "into",
  "is", "it", "of", "on", "or", "that", "the", "this", "to", "via", "with"
]);

function printHelp() {
  console.log(`sprint-board

Usage:
  node scripts/sprint-board.mjs summary [--state-file <path>]
  node scripts/sprint-board.mjs claim --run-id <id> [--count <n>] [--json] [--state-file <path>]
  node scripts/sprint-board.mjs release --run-id <id> [--task <id>] [--json] [--state-file <path>]
  node scripts/sprint-board.mjs next [--json] [--strict] [--state-file <path>]
  node scripts/sprint-board.mjs plan [--json] [--max-parallel <n>] [--state-file <path>]
  node scripts/sprint-board.mjs suggest-gate [--pitfalls-file <path>]
  node scripts/sprint-board.mjs render [--state-file <path>] [--board-file <path>]
  node scripts/sprint-board.mjs add --title <text> --priority <P0|P1|P2|P3> [options]
  node scripts/sprint-board.mjs update --id <TASK-ID> [--state <state>] [options]
  node scripts/sprint-board.mjs journal --task <TASK-ID> --summary <text> [options]
  node scripts/sprint-board.mjs journal --view [--journal-file <path>]
  node scripts/sprint-board.mjs pitfall --task <TASK-ID> --failure-type <gate|acceptance|review> --attempted <text> --hypothesis <text> [--missing-context <text>]
  node scripts/sprint-board.mjs pitfall --resolve <PF-ID> --resolution <text>
  node scripts/sprint-board.mjs pitfall --list [--unresolved] [--json]
  node scripts/sprint-board.mjs eval-compare [--gate <name>] [--limit <n>] [--json]
  node scripts/sprint-board.mjs review [--pitfalls-file <path>]

Options (add):
  --title <text>            (required) Task title
  --priority <P0|P1|P2|P3> (required) Task priority
  --source <text>           Origin of the task (e.g. "codex review", "dogfood")
  --note <text>             Initial task notes
  --owner <text>            Initial owner
  --depends-on <ID1,ID2,...> Comma-separated task IDs this task depends on

Options (update):
  --title <text>
  --priority <P0|P1|P2|P3>
  --if-state <state>       Only update when the current task state matches
  --owner <text>
  --source <text>
  --verification <text>
  --reason <text>
  --flow <flow-name>
  --must-rate <value>
  --should-rate <value>
  --implementer <text>
  --security <text>
  --qa <text>
  --domain <text>
  --architect <text>
  --note <text>
  --depends-on <ID1,ID2,...>
  --reset-fail-count        Reset failCount to 0 (use after fixing a failed task)
  --failure-type <gate|acceptance|review>  Structured failure category (when --state Failed)
  --attempted <text>        What was attempted before the failure
  --hypothesis <text>       Why the failure likely occurred
  --missing-context <text>  Context that was absent and contributed to the failure

Options (journal):
  --view                      Print a layered read view of the journal
  --files <comma-separated paths>
  --signals <comma-separated signals>

Options (pitfall):
  --task <TASK-ID>          Task this pitfall is associated with
  --failure-type <type>     gate | acceptance | review
  --attempted <text>        What was attempted
  --hypothesis <text>       Why it failed
  --missing-context <text>  Missing context (optional)
  --resolve <PF-ID>         Resolve an existing pitfall entry
  --resolution <text>       Resolution text (used with --resolve)
  --list                    List pitfall entries
  --unresolved              Filter --list to unresolved entries only

Options (next):
  --strict                  Keep pending human intent as a hard block

Options (claim/release):
  --run-id <id>             Run identity that owns the task claim
  --count <n>               Number of claim slots to reserve (claim only)
  --task <id>               Release a single claimed task instead of all (release only)

Global options:
  --max-parallel <n>
  --state-file <path>
  --board-file <path>
  --journal-file <path>
  --pitfalls-file <path>
  --history-file <path>
`);
}

/**
 * @param {import("./lib/errors.mjs").ErrorCode} code
 * @param {string} message
 * @param {Record<string, unknown>} [context]
 * @returns {VAPilotError}
 */
function humanBoardBlockedError(code, message, context) {
  return new VAPilotError(code, message, context);
}

/**
 * @param {boolean} jsonMode
 * @param {VAPilotError | Error} error
 * @returns {void}
 */
function printCommandError(jsonMode, error) {
  if (jsonMode) {
    const payload = error instanceof VAPilotError
      ? error.toJSON()
      : { code: "ERROR", message: error instanceof Error ? error.message : String(error), context: undefined };
    console.log(JSON.stringify({ error: payload }, null, 2));
    return;
  }

  if (error instanceof VAPilotError && error.code === "HUMAN_BOARD_BLOCKED") {
    console.error(`Error: [${error.code}] ${error.message}`);
    const context = error.context ?? {};
    if (context.boardFile) {
      console.error(`Human intent projection: ${context.boardFile}`);
    }
    if (Array.isArray(context.instructions) && context.instructions.length > 0) {
      console.error("Unprocessed projected intent:");
      for (const instruction of context.instructions) {
        const lineNumber = instruction?.lineNumber ?? "?";
        const text = instruction?.text ?? "";
        console.error(`  - line ${lineNumber}: ${text}`);
      }
    }
    console.error("Inspect cockpit, process projected intent, mark handled items [x], then run next again.");
    return;
  }

  const prefix = error instanceof VAPilotError ? `[${error.code}] ` : "";
  console.error(`Error: ${prefix}${error instanceof Error ? error.message : String(error)}`);
}

/**
 * @param {{ lineNumber: number, text: string }[]} instructions
 * @returns {string}
 */
function formatHumanBoardWarning(instructions) {
  const lines = [
    `Warning: projected human intent contains ${instructions.length} unprocessed item(s).`,
    "Continuing because --strict was not provided.",
    "Unprocessed projected intent:"
  ];
  for (const instruction of instructions) {
    lines.push(`  - line ${instruction.lineNumber}: ${instruction.text}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} boardFile
 * @param {{ lineNumber: number, text: string }[]} instructions
 * @returns {VAPilotError}
 */
function buildHumanBoardBlockError(boardFile, instructions) {
  const message = `projected human intent contains ${instructions.length} unprocessed item(s).`;
  return humanBoardBlockedError("HUMAN_BOARD_BLOCKED", message, {
    boardFile,
    instructions
  });
}

/**
 * @param {string | undefined} raw
 * @returns {string}
 */
function shortDate(raw) {
  if (!raw) return "-";
  return String(raw).slice(0, 10);
}

/**
 * @param {string} filePath
 * @returns {SprintState}
 */
function readState(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new VAPilotError("FILE_NOT_FOUND", `State file not found: ${filePath}`, { filePath });
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);

  if (!Array.isArray(data.tasks)) {
    throw new VAPilotError("PARSE_ERROR", "Invalid state file: tasks must be an array", { filePath });
  }

  data.tasks = data.tasks.map(normalizeTask);
  return data;
}

/**
 * @param {string} filePath
 * @param {SprintState} data
 * @returns {void}
 */
function writeState(filePath, data) {
  writeJsonFileAtomicSync(filePath, data);
}

/**
 * @param {Task[]} tasks
 * @param {string[]} columns
 * @param {(task: Task) => unknown[]} mapRow
 * @returns {string}
 */
function rowsForSection(tasks, columns, mapRow) {
  if (tasks.length === 0) {
    return `| ${columns.map(() => "-").join(" | ")} |`;
  }

  return tasks.map((task) => {
    const values = mapRow(task).map(escapeCell);
    return `| ${values.join(" | ")} |`;
  }).join("\n");
}

/**
 * @param {SprintState} state
 * @returns {string}
 */
function renderBoardMarkdown(state) {
  const date = shortDate(state.updatedAt || nowIso());
  const prefix = escapeCell(state.projectPrefix || "TASK");
  const tasks = sortTasks(state.tasks);

  const inProgress = tasks.filter((task) => task.state === "In Progress");
  const failed = tasks.filter((task) => task.state === "Failed");
  const review = tasks.filter((task) => task.state === "Review");
  const testing = tasks.filter((task) => task.state === "Testing");
  const done = tasks.filter((task) => task.state === "Done");
  const backlog = tasks.filter((task) => task.state === "Backlog");

  return `# Sprint Board

> Last updated: ${date} by VA Auto-Pilot
> Generated from \`.va-auto-pilot/sprint-state.json\` via \`node scripts/sprint-board.mjs render\`.
>
> Rules:
> - Machine source of truth: \`.va-auto-pilot/sprint-state.json\`
> - Human-readable projection: \`docs/todo/sprint.md\`
> - One primary task at a time in \`In Progress\`; independent tracks may run in parallel
> - Task ID format: \`${prefix}-{3-digit number}\`
> - Priority: P0(blocking) / P1(important) / P2(routine) / P3(optimization)
>
> State flow:
> \`\`\`
> Backlog -> In Progress -> Review -> Testing -> Done
>                  ^                     |
>                  +------ Failed <------+
> \`\`\`

---

## In Progress
| ID | Task | Owner | Started | Notes |
|----|------|-------|---------|-------|
${rowsForSection(inProgress, ["ID", "Task", "Owner", "Started", "Notes"], (task) => [task.id, task.title, task.owner, shortDate(task.startedAt), task.notes])}

## Failed
| ID | Task | Fail Count | Reason | Last Failed |
|----|------|------------|--------|-------------|
${rowsForSection(failed, ["ID", "Task", "Fail Count", "Reason", "Last Failed"], (task) => [task.id, task.title, task.failCount, task.reason, shortDate(task.lastFailedAt)])}

## Review
| ID | Task | Implementer | Security | QA | Domain | Architect |
|----|------|-------------|----------|----|--------|-----------|
${rowsForSection(review, ["ID", "Task", "Implementer", "Security", "QA", "Domain", "Architect"], (task) => [task.id, task.title, task.review.implementer, task.review.security, task.review.qa, task.review.domain, task.review.architect])}

## Testing
| ID | Task | Test Flow | MUST Pass Rate | SHOULD Pass Rate |
|----|------|-----------|----------------|------------------|
${rowsForSection(testing, ["ID", "Task", "Test Flow", "MUST Pass Rate", "SHOULD Pass Rate"], (task) => [task.id, task.title, task.testing.flow, task.testing.mustPassRate, task.testing.shouldPassRate])}

## Done
| ID | Task | Completed | Verification |
|----|------|-----------|--------------|
${rowsForSection(done, ["ID", "Task", "Completed", "Verification"], (task) => [task.id, task.title, shortDate(task.completedAt), task.verification])}

## Backlog
| Priority | ID | Task | Depends On | Owner | Source |
|----------|----|------|------------|-------|--------|
${rowsForSection(backlog, ["Priority", "ID", "Task", "Depends On", "Owner", "Source"], (task) => [task.priority, task.id, task.title, task.dependsOn.join(", "), task.owner, task.source])}
`;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function resolveProjectDirFromPilotArtifact(filePath) {
  const resolvedPath = path.resolve(filePath);
  const parentDir = path.dirname(resolvedPath);
  return path.basename(parentDir) === ".va-auto-pilot"
    ? path.dirname(parentDir)
    : parentDir;
}

/**
 * @param {string} boardFile
 * @param {SprintState} state
 * @returns {void}
 */
function writeBoard(boardFile, state) {
  const markdown = renderBoardMarkdown(state);
  writeTextFileAtomicSync(boardFile, markdown);
}

/**
 * Computes the next sequential task ID by scanning existing tasks.
 * Finds the highest numeric suffix of IDs matching the projectPrefix pattern,
 * increments by 1, and zero-pads to 3 digits.
 * Example: existing [AP-001, AP-002, AP-003] -> AP-004
 *
 * @param {SprintState} state
 * @returns {string}
 */
function nextTaskId(state) {
  const prefix = String(state.projectPrefix || "TASK");
  // Escape regex special characters in the prefix to prevent injection.
  const escapedPrefix = prefix.replace(/[$()*+.?[\\\]^{|}]/g, "\\$&");
  const pattern = new RegExp(`^${escapedPrefix}-(\\d+)$`);
  let max = 0;
  for (const task of state.tasks) {
    const match = String(task.id ?? "").match(pattern);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  const next = max + 1;
  return `${prefix}-${String(next).padStart(3, "0")}`;
}

/**
 * @param {SprintState} state
 * @param {Record<string, string>} options
 * @returns {Task}
 */
function addTask(state, options) {
  const title = requireOption(options, "title");

  const priority = options.priority;
  if (!priority) {
    throw new VAPilotError("CONFIG_ERROR", "Missing required option --priority", { option: "priority" });
  }
  if (!(priority in PRIORITY_WEIGHT)) {
    throw new VAPilotError("CONFIG_ERROR", `Invalid priority '${priority}'. Expected P0/P1/P2/P3.`, { priority, validPriorities: ["P0", "P1", "P2", "P3"] });
  }

  const id = nextTaskId(state);
  const createdAt = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const raw = {
    id,
    title,
    priority,
    state: "Backlog",
    owner: options.owner ?? "",
    source: options.source ?? "",
    createdAt,
    startedAt: "",
    completedAt: "",
    lastFailedAt: "",
    failCount: 0,
    reason: "",
    verification: "",
    notes: options.note ?? "",
    review: {},
    testing: {},
    dependsOn: options["depends-on"] ? normalizeDependsOn(options["depends-on"]) : []
  };

  const task = normalizeTask(raw);
  state.tasks.push(task);
  state.updatedAt = nowIso();
  return task;
}

/**
 * @param {SprintState} state
 * @param {Record<string, string>} options
 * @param {Set<string>} [flags]
 * @returns {Task}
 */
function updateTask(state, options, flags) {
  const id = requireOption(options, "id");
  const task = state.tasks.find((item) => item.id === id);

  if (!task) {
    throw new VAPilotError("INVALID_TASK", `Task not found: ${id}`, { taskId: id });
  }

  const expectedState = options["if-state"];
  if (expectedState !== undefined) {
    if (!VALID_STATES.includes(expectedState)) {
      throw new VAPilotError(
        "INVALID_STATE",
        `Invalid --if-state '${expectedState}'. Expected one of: ${VALID_STATES.join(", ")}`,
        { state: expectedState, validStates: [...VALID_STATES] }
      );
    }

    if (task.state !== expectedState) {
      throw new VAPilotError(
        "STATE_CONFLICT",
        `Task ${id} is ${task.state}; expected ${expectedState}. Refusing stale update.`,
        {
          taskId: id,
          actualState: task.state,
          expectedState
        }
      );
    }
  }

  if (options.state) {
    if (!VALID_STATES.includes(options.state)) {
      throw new VAPilotError("INVALID_STATE", `Invalid state '${options.state}'. Expected one of: ${VALID_STATES.join(", ")}`, { state: options.state, validStates: [...VALID_STATES] });
    }

    task.state = options.state;

    if (task.state !== "Done") {
      task.completedAt = "";
      if (!options.verification) {
        task.verification = "";
      }
    }

    if (task.state === "In Progress" && !task.startedAt) {
      task.startedAt = nowIso();
    }

    if (task.state === "Failed") {
      task.failCount += 1;
      task.lastFailedAt = nowIso();

      // Capture structured failure metadata when provided.
      const failureType = options["failure-type"];
      const attempted = options.attempted;
      const hypothesis = options.hypothesis;
      const missingContext = options["missing-context"];

      if (failureType || attempted || hypothesis || missingContext) {
        if (failureType && !VALID_FAILURE_TYPES.includes(failureType)) {
          throw new Error(`Invalid --failure-type '${failureType}'. Expected one of: ${VALID_FAILURE_TYPES.join(", ")}`);
        }
        task.failureDetail = {
          failureType: failureType ?? "",
          attempted: attempted ?? "",
          hypothesis: hypothesis ?? "",
          missingContext: missingContext ?? ""
        };
      }
    }

    if (task.state === "Done") {
      task.failCount = 0;
      task.completedAt = nowIso();
    }
  }

  // --reset-fail-count: used after a human fixes a failed task and wants
  // to re-enter the loop without the 3-failure stop condition triggering.
  if (flags && flags.has("reset-fail-count")) {
    task.failCount = 0;
    task.lastFailedAt = "";
    task.reason = options.reason ?? task.reason;
  }

  if (options.title) task.title = options.title;
  if (options.owner) task.owner = options.owner;
  if (options.source) task.source = options.source;
  if (options.verification) task.verification = options.verification;
  if (options.reason) task.reason = options.reason;

  if (options.priority) {
    if (!(options.priority in PRIORITY_WEIGHT)) {
      throw new Error(`Invalid priority '${options.priority}'. Expected P0/P1/P2/P3.`);
    }
    task.priority = options.priority;
  }

  if (options.flow) task.testing.flow = options.flow;
  if (options["must-rate"]) task.testing.mustPassRate = options["must-rate"];
  if (options["should-rate"]) task.testing.shouldPassRate = options["should-rate"];
  if (options.implementer) task.review.implementer = options.implementer;
  if (options.security) task.review.security = options.security;
  if (options.qa) task.review.qa = options.qa;
  if (options.domain) task.review.domain = options.domain;
  if (options.architect) task.review.architect = options.architect;

  if (options.note) {
    task.notes = task.notes ? `${task.notes}; ${options.note}` : options.note;
  }

  if (options["depends-on"] !== undefined) {
    task.dependsOn = normalizeDependsOn(options["depends-on"]);
  }

  state.updatedAt = nowIso();
  return task;
}

/**
 * @param {string} filePath
 * @param {Record<string, string>} options
 * @returns {void}
 */
function appendJournal(filePath, options) {
  const taskId = requireOption(options, "task");
  const summary = requireOption(options, "summary");
  const files = String(options.files ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const signals = String(options.signals ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  const lines = [];
  lines.push(`## ${nowIso()} - ${taskId}`);
  lines.push(`- Summary: ${summary}`);

  if (files.length > 0) {
    lines.push(`- Files: ${files.map((item) => `\`${item}\``).join(", ")}`);
  }

  if (signals.length > 0) {
    lines.push("- Signals:");
    for (const signal of signals) {
      lines.push(`  - ${signal}`);
    }
  }

  lines.push("---");

  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const prefix = fs.existsSync(filePath) ? "\n" : "# Run Journal\n\n## Codebase Signals\n- Add reusable patterns and gotchas here.\n\n## Entries\n";
  fs.appendFileSync(filePath, `${prefix}${lines.join("\n")}\n`, "utf8");
}

/**
 * @param {string} content
 * @returns {{ codebaseSignals: string[], entries: { heading: string, timestamp: string, taskId: string, summary: string, signals: string[], rawLines: string[] }[] }}
 */
function parseJournal(content) {
  const lines = String(content ?? "").split(/\r?\n/);
  const codebaseSignals = [];
  const entries = [];
  let inCodebaseSignals = false;
  let inEntries = false;
  /** @type {{ heading: string, timestamp: string, taskId: string, summary: string, signals: string[], rawLines: string[] } | null} */
  let currentEntry = null;
  let collectingEntrySignals = false;

  const flushEntry = () => {
    if (!currentEntry) return;
    while (currentEntry.rawLines.length > 0 && currentEntry.rawLines.at(-1) === "") {
      currentEntry.rawLines.pop();
    }
    entries.push(currentEntry);
    currentEntry = null;
    collectingEntrySignals = false;
  };

  for (const line of lines) {
    if (line === "## Codebase Signals") {
      flushEntry();
      inCodebaseSignals = true;
      inEntries = false;
      continue;
    }

    if (line === "## Entries") {
      flushEntry();
      inCodebaseSignals = false;
      inEntries = true;
      continue;
    }

    const entryHeading = inEntries ? line.match(/^##\s+(.+?)\s+-\s+(.+)$/) : null;
    if (entryHeading) {
      flushEntry();
      currentEntry = {
        heading: line,
        timestamp: entryHeading[1].trim(),
        taskId: entryHeading[2].trim(),
        summary: "",
        signals: [],
        rawLines: [line]
      };
      continue;
    }

    if (inCodebaseSignals) {
      const signal = line.match(/^-\s+(.*)$/);
      if (signal) {
        codebaseSignals.push(signal[1].trim());
      }
      continue;
    }

    if (!currentEntry) continue;
    currentEntry.rawLines.push(line);

    const summaryMatch = line.match(/^- Summary:\s+(.*)$/);
    if (summaryMatch) {
      currentEntry.summary = summaryMatch[1].trim();
      collectingEntrySignals = false;
      continue;
    }

    if (line === "- Signals:") {
      collectingEntrySignals = true;
      continue;
    }

    const nestedSignal = collectingEntrySignals ? line.match(/^\s+-\s+(.*)$/) : null;
    if (nestedSignal) {
      currentEntry.signals.push(nestedSignal[1].trim());
      continue;
    }

    collectingEntrySignals = false;

    if (line === "---") {
      flushEntry();
    }
  }

  flushEntry();
  return { codebaseSignals, entries };
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function renderJournalView(filePath) {
  if (!fs.existsSync(filePath)) {
    return `# Run Journal View\n\n## Active Signals\n- none\n\n## Recent\n- none\n\n## Earlier\n- none\n`;
  }

  const { codebaseSignals, entries } = parseJournal(fs.readFileSync(filePath, "utf8"));
  const activeSignalsNewestFirst = [];
  const seenSignals = new Set();
  const historicalSignals = [...codebaseSignals, ...entries.flatMap((entry) => entry.signals)];
  for (const signal of [...historicalSignals].reverse()) {
    const normalized = String(signal ?? "").trim();
    if (!normalized || seenSignals.has(normalized)) continue;
    seenSignals.add(normalized);
    activeSignalsNewestFirst.push(normalized);
  }
  const activeSignals = activeSignalsNewestFirst
    .slice(0, JOURNAL_VIEW_MAX_ACTIVE_SIGNALS)
    .reverse();
  const omittedSignalCount = Math.max(0, activeSignalsNewestFirst.length - activeSignals.length);

  const recentEntries = entries.slice(-5).reverse();
  const earlierEntries = entries.slice(0, Math.max(0, entries.length - 5));

  const lines = ["# Run Journal View", "", "## Active Signals"];
  if (activeSignals.length === 0) {
    lines.push("- none");
  } else {
    if (omittedSignalCount > 0) {
      lines.push(`- [compressed] ${omittedSignalCount} older signal(s) omitted; source journal remains append-only.`);
    }
    for (const signal of activeSignals) {
      lines.push(`- ${signal}`);
    }
  }

  lines.push("", "## Recent");
  if (recentEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of recentEntries) {
      lines.push(...entry.rawLines);
      lines.push("");
    }
    while (lines.at(-1) === "") {
      lines.pop();
    }
  }

  lines.push("", "## Earlier");
  if (earlierEntries.length === 0) {
    lines.push("- none");
  } else {
    for (const entry of earlierEntries) {
      lines.push(`- ${entry.timestamp} | ${entry.taskId} | ${entry.summary || "(no summary)"}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

function formatEvalCompare(summary, { gate = "", historyFile = "" } = {}) {
  const lines = [
    "Eval History",
    `History : ${historyFile ? path.relative(process.cwd(), historyFile) : DEFAULT_EVAL_HISTORY_FILE}`,
    `Gate    : ${gate || "all"}`,
    `Total   : ${summary.total}`,
    `Passed  : ${summary.passed}`,
    `Failed  : ${summary.failed}`,
    `PassRate: ${(summary.passRate * 100).toFixed(1)}%`,
  ];
  if (summary.latest) {
    lines.push(`Latest  : ${summary.latest.gateName} ${summary.latest.state} task=${summary.latest.taskId || ""} score=${summary.latest.score ?? ""}`);
  } else {
    lines.push("Latest  : none");
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * @param {SprintState} state
 * @param {string} pitfallsFile
 * @returns {void}
 */
function printSummary(state, pitfallsFile) {
  const counts = Object.fromEntries(VALID_STATES.map((name) => [name, 0]));
  for (const task of state.tasks) {
    if (counts[task.state] === undefined) continue;
    counts[task.state] += 1;
  }

  console.log("Sprint Summary");
  for (const name of VALID_STATES) {
    console.log(`${name.padEnd(11, " ")}: ${counts[name]}`);
  }

  // Show unresolved pitfall count so the log is visible at every cycle start.
  try {
    const pitfalls = readPitfalls(pitfallsFile);
    const unresolved = pitfalls.entries.filter((e) => e.resolvedAt === null || e.resolvedAt === "").length;
    console.log(`Pitfalls   : ${unresolved} unresolved (${pitfalls.entries.length} total)`);
  } catch {
    // Pitfalls file unreadable — non-fatal for summary.
  }

  const next = findNextTask(state.tasks);
  if (!next) {
    const backlogCount = state.tasks.filter((task) => task.state === "Backlog").length;
    if (backlogCount > 0) {
      console.log("Next Task  : none (all backlog tasks are blocked by dependencies)");
    } else {
      console.log("Next Task  : none (backlog empty)");
    }
    return;
  }

  console.log(`Next Task  : ${next.task.id} (${next.action})`);

  const plan = buildParallelPlan(state.tasks, DEFAULT_MAX_PARALLEL);
  if (plan && plan.parallelTracks.length > 0) {
    console.log(`Parallel   : ${plan.parallelTracks.join(", ")}`);
  } else {
    console.log("Parallel   : none");
  }
}

// ---------------------------------------------------------------------------
// Pitfall guide
// ---------------------------------------------------------------------------

/**
 * @param {string} filePath
 * @returns {PitfallData}
 */
function readPitfalls(filePath) {
  if (!fs.existsSync(filePath)) {
    return { version: 1, entries: [] };
  }
  const raw = fs.readFileSync(filePath, "utf8");
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    throw new VAPilotError("PARSE_ERROR", `Cannot parse pitfalls file: ${filePath} — ${e.message}`, { filePath, cause: e.message });
  }
  if (!Array.isArray(data.entries)) {
    throw new Error(`Invalid pitfalls file: 'entries' must be an array`);
  }
  return data;
}

/**
 * @param {string} filePath
 * @param {PitfallData} data
 * @returns {void}
 */
function writePitfalls(filePath, data) {
  writeJsonFileAtomicSync(filePath, data);
}

/**
 * @param {string} filePath
 * @returns {Record<string, unknown>}
 */
function readConfigDocument(filePath) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  try {
    const parsed = parseYaml(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} configFile
 * @returns {number}
 */
function resolveClaimTtlMs(configFile) {
  const config = /** @type {{ sprint?: { claimTtlMs?: number | string } }} */ (readConfigDocument(configFile));
  const configured = Number(config.sprint?.claimTtlMs);
  return Number.isFinite(configured) && configured > 0
    ? configured
    : DEFAULT_TASK_CLAIM_TTL_MS;
}

/**
 * @param {SprintState} state
 * @param {number} count
 * @param {number} nowMs
 * @returns {Task[]}
 */
function selectClaimableTasks(state, count, nowMs) {
  const doneIds = new Set(
    state.tasks
      .filter((task) => task.state === "Done")
      .map((task) => task.id)
  );
  const backlog = sortTasks(state.tasks.filter(
    (task) => task.state === "Backlog"
      && isDependencySatisfied(task, doneIds)
      && (!task.claimedBy || isClaimExpired(task, nowMs))
  ));

  if (backlog.length === 0 || count <= 0) {
    return [];
  }

  const selected = [backlog[0]];
  for (const task of backlog.slice(1)) {
    if (selected.length >= count) {
      break;
    }
    if (task.dependsOn.includes(selected[0].id)) {
      continue;
    }
    selected.push(task);
  }

  return selected;
}

/**
 * Claim tasks for a run.
 *
 * Two modes:
 *  - count mode (default): select up to `count` claimable Backlog tasks via
 *    selectClaimableTasks (priority order, deps satisfied, unclaimed/expired).
 *  - task mode (taskIds non-empty): claim the *specified* tasks regardless of
 *    state. This lets orchestrate plan stamp ownership on the plan's task set,
 *    which may include in-progress (non-Backlog) work. In task mode a task is
 *    re-claimable if it is unclaimed, expired, OR already claimed by the same
 *    runId (replan idempotency — a run replanning must reuse its own claims,
 *    not get blocked by them).
 *
 * @param {SprintState} state
 * @param {string} runId
 * @param {number} count
 * @param {number} ttlMs
 * @param {number} [nowMs]
 * @param {string[]} [taskIds]  explicit task ids to claim (task mode)
 * @returns {{ runId: string, claimedTasks: Array<{ taskId: string, reclaimed: boolean }> }}
 */
function claimTasksInState(state, runId, count, ttlMs, nowMs = Date.now(), taskIds = []) {
  const claimedTasks = [];
  const claimedAt = new Date(nowMs).toISOString();
  const claimExpiresAt = new Date(nowMs + ttlMs).toISOString();

  let targets;
  if (Array.isArray(taskIds) && taskIds.length > 0) {
    // Task mode: resolve explicit ids. Re-claimable when unclaimed, expired, or
    // already owned by this run. Tasks actively claimed by a *different* live run
    // are skipped (not stolen — stealing only happens via expiry in count mode).
    const want = new Set(taskIds.map((id) => String(id)));
    targets = state.tasks.filter((task) => {
      if (!want.has(task.id)) return false;
      if (!task.claimedBy || isClaimExpired(task, nowMs)) return true;
      return task.claimedBy === runId; // reuse own claim
    });
  } else {
    targets = selectClaimableTasks(state, count, nowMs);
  }

  for (const task of targets) {
    const reclaimed = Boolean(task.claimedBy) && task.claimedBy !== runId && isClaimExpired(task, nowMs);
    if (reclaimed) {
      task.previousClaimedBy = task.claimedBy;
      task.reclaimedAt = claimedAt;
    }
    task.claimedBy = runId;
    task.claimedAt = claimedAt;
    task.claimExpiresAt = claimExpiresAt;
    claimedTasks.push({ taskId: task.id, reclaimed });
  }

  if (claimedTasks.length > 0) {
    state.updatedAt = nowIso();
  }

  return { runId, claimedTasks };
}

/**
 * @param {SprintState} state
 * @param {string} runId
 * @param {string} [taskId]
 * @returns {{ runId: string, releasedTasks: string[] }}
 */
function releaseClaimsInState(state, runId, taskId = "") {
  const releasedTasks = [];
  for (const task of state.tasks) {
    if (task.claimedBy !== runId) {
      continue;
    }
    if (taskId && task.id !== taskId) {
      continue;
    }
    task.claimedBy = "";
    task.claimedAt = "";
    task.claimExpiresAt = "";
    task.previousClaimedBy = "";
    task.reclaimedAt = "";
    releasedTasks.push(task.id);
  }

  if (releasedTasks.length > 0) {
    state.updatedAt = nowIso();
  }

  return { runId, releasedTasks };
}

/**
 * @param {string} filePath
 * @param {Record<string, unknown>} config
 * @returns {void}
 */
function writeConfigDocument(filePath, config) {
  // lineWidth: 0 — keep long gate commands on one line (yaml default folds).
  writeTextFileAtomicSync(filePath, stringifyYaml(config, { lineWidth: 0 }));
}

/**
 * @param {string} configFile
 * @param {{ name: string, command: string, required: boolean, description: string, triggeredBy: string }} suggestion
 * @returns {{ added: boolean, gate: { name: string, command: string, required: boolean, description: string, triggeredBy: string }, skipped?: string }}
 */
function appendSuggestedGate(configFile, suggestion) {
  const config = readConfigDocument(configFile);
  const qualityGate = config.qualityGate && typeof config.qualityGate === "object"
    ? /** @type {{ adaptiveGates?: Array<{ name?: string, command?: string, required?: boolean, description?: string, triggeredBy?: string }> }} */ (config.qualityGate)
    : {};
  const adaptiveGates = Array.isArray(qualityGate.adaptiveGates)
    ? /** @type {Array<{ name: string, command: string, required: boolean, description: string, triggeredBy: string }>} */ ([...qualityGate.adaptiveGates])
    : [];
  const command = String(suggestion?.command ?? "").trim();
  // Never persist weak placeholders into adaptiveGates — they become permanent
  // evidence-risk noise and may re-pollute a cleaned project config.
  if (isWeakGateCommand(command)) {
    return {
      added: false,
      gate: {
        name: suggestion.name,
        command,
        required: false,
        description: suggestion.description,
        triggeredBy: suggestion.triggeredBy,
      },
      skipped: "weak-placeholder",
    };
  }
  const duplicate = adaptiveGates.find((gate) =>
    String(gate?.triggeredBy ?? "") === suggestion.triggeredBy ||
    (
      String(gate?.name ?? "").trim() === suggestion.name &&
      String(gate?.command ?? "").trim() === suggestion.command
    )
  );

  if (duplicate) {
    return { added: false, gate: duplicate };
  }

  adaptiveGates.push({
    name: suggestion.name,
    command: suggestion.command,
    required: suggestion.required,
    description: suggestion.description,
    triggeredBy: suggestion.triggeredBy
  });
  config.qualityGate = {
    ...qualityGate,
    adaptiveGates
  };
  writeConfigDocument(configFile, config);
  return { added: true, gate: adaptiveGates.at(-1) ?? suggestion };
}

function splitLines(value) {
  return String(value ?? "")
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
}

function slugify(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function lowercaseFirst(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";
  return input[0].toLowerCase() + input.slice(1);
}

function capitalizeSentence(value) {
  const input = String(value ?? "").trim();
  if (!input) return "";
  return input[0].toUpperCase() + input.slice(1);
}

function tokenizeConstraintKeywords(...values) {
  return [...new Set(values
    .flatMap((value) => String(value ?? "").toLowerCase().split(/[^a-z0-9]+/g))
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !CONSTRAINT_STOPWORDS.has(token))
  )];
}

function inferConstraintDomain(taskTitle, hypothesis, resolution) {
  const haystack = `${taskTitle} ${hypothesis} ${resolution}`.toLowerCase();
  if (haystack.includes("sprint-board")) return "sprint-board";
  if (haystack.includes("docstore") || haystack.includes("doc-store")) return "doc-store";
  if (haystack.includes("review")) return "review";
  if (haystack.includes("dispatch") || haystack.includes("agent")) return "dispatch";
  if (haystack.includes("lock") || haystack.includes("state race")) return "state";
  if (haystack.includes("write path") || haystack.includes("write-path") || haystack.includes("persist")) return "write-path";
  const tokens = tokenizeConstraintKeywords(taskTitle, hypothesis, resolution);
  return tokens[0] ?? "general";
}

function inferConstraintType(taskTitle, hypothesis, resolution) {
  const haystack = `${taskTitle} ${hypothesis} ${resolution}`.toLowerCase();
  if (/\b(idempotent|idempotency|retry|retries|repeat|repeated|duplicate|double)\b/.test(haystack)) return "invariant";
  if (/\b(stale lock|stale locks|recover|recovery|before|require|required|prerequisite|must exist)\b/.test(haystack)) return "prerequisite";
  if (/\b(trade-off|strictness|developer experience|ergonomic|ergonomics|balance|vs\.)\b/.test(haystack)) return "trade-off";
  if (/\b(anti-pattern|hardcod|fallback|assumption|assumptions|silent degradation|silent fallback|npm test)\b/.test(haystack)) return "anti-pattern";
  return "boundary";
}

function normalizeConstraintStatement(sourceText, type) {
  let statement = String(sourceText ?? "").trim().replace(/\s+/g, " ").replace(/[.。]+$/g, "");
  if (!statement) return "";
  statement = statement
    .replace(/\bshould become\b/ig, "must be")
    .replace(/\bshould\b/ig, "must")
    .replace(/^made\s+(.+?)\s+permanent$/i, "$1 must remain permanent")
    .replace(/^added\s+(.+)$/i, "$1 must be added")
    .replace(/^ensured?\s+/i, "")
    .replace(/^fixed\s+/i, "");
  if (!/\b(must|avoid|never|require|recover|validate|lean|prefer|keep)\b/i.test(statement)) {
    switch (type) {
      case "invariant":
        statement = `Keep ${lowercaseFirst(statement)}`;
        break;
      case "prerequisite":
        statement = `Require ${lowercaseFirst(statement)} before proceeding`;
        break;
      case "trade-off":
        statement = `Treat ${lowercaseFirst(statement)} as an explicit trade-off`;
        break;
      case "anti-pattern":
        statement = `Avoid ${lowercaseFirst(statement)}`;
        break;
      default:
        statement = `Ensure ${lowercaseFirst(statement)}`;
        break;
    }
  }
  return capitalizeSentence(statement);
}

function chooseConstraintSource(entry, resolution) {
  const resolutionText = String(resolution ?? "").trim();
  const hypothesisText = String(entry?.hypothesis ?? "").trim();
  const candidate = resolutionText || hypothesisText;
  return candidate || `carry forward the lesson from ${String(entry?.id ?? "this pitfall").trim()}`;
}

function buildSynthesizedConstraintDocument(entry, task, resolution) {
  const type = inferConstraintType(task.title, entry.hypothesis, resolution);
  const domain = inferConstraintDomain(task.title, entry.hypothesis, resolution);
  const statement = normalizeConstraintStatement(chooseConstraintSource(entry, resolution), type);
  const tags = [
    slugify(task.id),
    slugify(entry.id),
    slugify(domain),
    ...tokenizeConstraintKeywords(task.title, entry.hypothesis, resolution).slice(0, 6)
  ].filter(Boolean);
  return {
    id: [slugify(task.id), slugify(entry.id), slugify(domain)].filter(Boolean).join("-"),
    type: "auto-pilot-constraint-set",
    payload: {
      domain,
      tags: [...new Set(tags)],
      synthesis: `Derived from ${task.id} (${task.title}): ${String(entry.hypothesis ?? "").trim()} Resolved via: ${String(resolution).trim()}`,
      constraints: [
        {
          type,
          statement,
          confidence: 0.72,
          sourceFactorIds: [String(entry.id)]
        }
      ],
      blindSpots: ["auto-generated-from-pitfall"]
    }
  };
}

function validateSynthesizedConstraintDocument(document) {
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint must be an object");
  }
  if (String(document.id ?? "").trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing id");
  }
  if (String(document.type ?? "").trim() !== "auto-pilot-constraint-set") {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint has unsupported type", { type: document.type });
  }
  const payload = document.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing payload");
  }
  if (String(payload.domain ?? "").trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing payload.domain");
  }
  if (!Array.isArray(payload.tags) || payload.tags.length === 0) {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing payload.tags");
  }
  if (String(payload.synthesis ?? "").trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing payload.synthesis");
  }
  if (!Array.isArray(payload.constraints) || payload.constraints.length === 0) {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing payload.constraints");
  }
  const constraint = payload.constraints[0];
  if (!["boundary", "invariant", "prerequisite", "trade-off", "anti-pattern"].includes(String(constraint?.type ?? ""))) {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint has invalid type", { type: constraint?.type });
  }
  if (String(constraint?.statement ?? "").trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing statement");
  }
  if (!Array.isArray(payload.blindSpots)) {
    throw new VAPilotError("CONFIG_ERROR", "Synthesized constraint is missing payload.blindSpots");
  }
}

function resolveConstraintsDir(pitfallsFile, runtime = {}) {
  if (runtime.constraintsDir) {
    return path.resolve(runtime.constraintsDir);
  }
  return path.join(resolveProjectDirFromPilotArtifact(pitfallsFile), DEFAULT_CONSTRAINTS_DIR);
}

function constraintFilePathForPitfall(constraintsDir, entry) {
  return path.join(constraintsDir, `${slugify(entry.id) || "pitfall-constraint"}.yaml`);
}

function writeTextFileIfChanged(filePath, content) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved) && fs.readFileSync(resolved, "utf8") === content) {
    return false;
  }
  writeTextFileAtomicSync(resolved, content);
  return true;
}

function journalHasSignal(filePath, signal) {
  if (!fs.existsSync(filePath)) return false;
  return fs.readFileSync(filePath, "utf8").includes(signal);
}

function appendJournalOnce(filePath, options, signal) {
  if (journalHasSignal(filePath, signal)) {
    return false;
  }
  appendJournal(filePath, options);
  return true;
}

function normalizeConstraintYamlContent(document) {
  return `${stringifyYaml(document).trimEnd()}\n`;
}

function buildConstraintCommitHeader(task) {
  const description = String(task?.title ?? task?.id ?? "constraint memory")
    .replace(/\s+/g, " ")
    .trim();
  return `constraint: ${description}`;
}

async function git(args, options = {}) {
  return execFileAsync("git", args, {
    encoding: "utf8",
    cwd: options.cwd ?? process.cwd(),
    timeout: options.timeout ?? DEFAULT_SPRINT_BOARD_TIMEOUT_MS,
    env: options.env ?? process.env
  });
}

function formatGitError(error) {
  const stderr = String(error?.stderr ?? "").trim();
  const stdout = String(error?.stdout ?? "").trim();
  const message = String(error?.message ?? "").trim();
  return stderr || stdout || message || "unknown git error";
}

async function resolveRepoFilesForCommit(files, workDir) {
  const canonicalWorkDir = canonicalizePathForComparison(workDir);
  const uniqueFiles = [...new Set(files
    .map((filePath) => path.relative(canonicalWorkDir, canonicalizePathForComparison(filePath)))
    .filter((relativePath) => relativePath && !relativePath.startsWith(".."))
  )];
  return uniqueFiles.sort((left, right) => left.localeCompare(right));
}

async function detectDirtyFilesForCommit(files, workDir) {
  if (files.length === 0) {
    return [];
  }
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--name-only", "--relative", "HEAD", "--", ...files], { cwd: workDir }),
    git(["ls-files", "--others", "--exclude-standard", "--", ...files], { cwd: workDir })
  ]);
  return [...new Set([
    ...splitLines(tracked.stdout),
    ...splitLines(untracked.stdout)
  ])].sort((left, right) => left.localeCompare(right));
}

async function captureConstraintCommitBaseline(files, workDir) {
  try {
    const inside = await git(["rev-parse", "--is-inside-work-tree"], { cwd: workDir });
    if (inside.stdout.trim() !== "true") {
      return { insideGit: false, repoFiles: [], dirtyFiles: [] };
    }
  } catch {
    return { insideGit: false, repoFiles: [], dirtyFiles: [] };
  }

  const repoFiles = await resolveRepoFilesForCommit(files, workDir);
  if (repoFiles.length === 0) {
    return { insideGit: true, repoFiles, dirtyFiles: [] };
  }

  return {
    insideGit: true,
    repoFiles,
    dirtyFiles: await detectDirtyFilesForCommit(repoFiles, workDir)
  };
}

function validatePitfallForResolution(entry, pfId) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw new VAPilotError("CONFIG_ERROR", `Pitfall ${pfId} has invalid shape`, { pitfallId: pfId });
  }
  if (String(entry.id ?? "").trim() !== String(pfId).trim()) {
    throw new VAPilotError("CONFIG_ERROR", `Pitfall ${pfId} has inconsistent id`, {
      pitfallId: pfId,
      actualId: entry.id
    });
  }
  if (String(entry.taskId ?? "").trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", `Pitfall ${pfId} is missing taskId`, { pitfallId: pfId });
  }
  if (!VALID_FAILURE_TYPES.includes(String(entry.failureType ?? "").trim())) {
    throw new VAPilotError("CONFIG_ERROR", `Pitfall ${pfId} has invalid failureType`, {
      pitfallId: pfId,
      failureType: entry.failureType
    });
  }
  if (String(entry.hypothesis ?? "").trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", `Pitfall ${pfId} is missing hypothesis`, { pitfallId: pfId });
  }
}

function canonicalizePathForComparison(filePath) {
  const resolved = path.resolve(filePath);
  if (fs.existsSync(resolved)) {
    return fs.realpathSync.native(resolved);
  }
  const parentDir = path.dirname(resolved);
  const realParentDir = fs.existsSync(parentDir)
    ? fs.realpathSync.native(parentDir)
    : parentDir;
  return path.join(realParentDir, path.basename(resolved));
}

async function commitConstraintArtifacts(files, task, options = {}) {
  const workDir = options.workDir ?? process.cwd();
  const header = buildConstraintCommitHeader(task);
  const baseline = options.baseline ?? await captureConstraintCommitBaseline(files, workDir);
  if (!baseline.insideGit) {
    return { attempted: false, skipped: true, reason: "not a git repository", hash: "", header, files: [] };
  }
  const repoFiles = baseline.repoFiles ?? await resolveRepoFilesForCommit(files, workDir);
  if (repoFiles.length === 0) {
    return { attempted: false, skipped: true, reason: "no repository-local files", hash: "", header, files: [] };
  }
  if (Array.isArray(baseline.dirtyFiles) && baseline.dirtyFiles.length > 0) {
    return {
      attempted: false,
      skipped: true,
      reason: `pre-existing dirty files: ${baseline.dirtyFiles.join(", ")}`,
      hash: "",
      header,
      files: [...baseline.dirtyFiles]
    };
  }

  try {
    await git(["add", "--all", "--", ...repoFiles], { cwd: workDir });
    const staged = await git(["diff", "--cached", "--name-only", "--relative", "--", ...repoFiles], { cwd: workDir });
    const stagedFiles = splitLines(staged.stdout);
    if (stagedFiles.length === 0) {
      return { attempted: true, skipped: true, reason: "no staged changes", hash: "", header, files: [] };
    }

    await git(["commit", "-m", header, "--only", "--", ...stagedFiles], { cwd: workDir });
    const head = await git(["rev-parse", "HEAD"], { cwd: workDir });
    return {
      attempted: true,
      skipped: false,
      reason: "",
      hash: head.stdout.trim(),
      header,
      files: stagedFiles
    };
  } catch (error) {
    try {
      await git(["reset", "--mixed", "HEAD", "--", ...repoFiles], { cwd: workDir });
    } catch {
      // Best effort only; preserve the original commit failure reason.
    }
    return {
      attempted: true,
      skipped: true,
      reason: `git commit failed: ${formatGitError(error)}`,
      hash: "",
      header,
      files: []
    };
  };
}

function findTaskForPitfall(stateFile, taskId) {
  const state = readState(stateFile);
  const task = state.tasks.find((item) => item.id === taskId);
  if (!task) {
    throw new VAPilotError("INVALID_TASK", `Task not found for pitfall: ${taskId}`, { taskId, stateFile });
  }
  if (!String(task.title ?? "").trim()) {
    throw new VAPilotError("INVALID_TASK", `Task ${taskId} is missing title`, { taskId, stateFile });
  }
  return task;
}

/**
 * @param {PitfallRecord[]} entries
 * @returns {string}
 */
function nextPitfallId(entries) {
  let max = 0;
  for (const entry of entries) {
    const match = String(entry.id ?? "").match(/^PF-(\d+)$/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (num > max) max = num;
    }
  }
  return `PF-${String(max + 1).padStart(3, "0")}`;
}

/**
 * @param {string} pitfallsFile
 * @param {Record<string, string>} options
 * @returns {PitfallRecord}
 */
function addPitfall(pitfallsFile, options) {
  const taskId = requireOption(options, "task");
  const failureType = requireOption(options, "failure-type");
  const attempted = requireOption(options, "attempted");
  const hypothesis = requireOption(options, "hypothesis");

  if (!VALID_FAILURE_TYPES.includes(failureType)) {
    throw new Error(`Invalid --failure-type '${failureType}'. Expected one of: ${VALID_FAILURE_TYPES.join(", ")}`);
  }

  const data = readPitfalls(pitfallsFile);
  const id = nextPitfallId(data.entries);
  const entry = {
    id,
    taskId,
    failureType,
    attempted,
    hypothesis,
    missingContext: options["missing-context"] ?? "",
    resolution: "",
    resolvedAt: null,
    createdAt: nowIso()
  };
  data.entries.push(entry);
  writePitfalls(pitfallsFile, data);
  return entry;
}

/**
 * @param {string} pitfallsFile
 * @param {Record<string, string>} options
 * @param {{ journalFile?: string, configFile?: string, stateFile?: string, constraintsDir?: string, workDir?: string }} [runtime]
 * @returns {Promise<{ id: string, entry: PitfallRecord, skipped: boolean, reason?: string, constraintFile: string, suggestionResult: { added: boolean, gate: { name: string, command: string, required: boolean, description: string, triggeredBy: string } }, journalAdded: boolean, constraintWritten: boolean, commitResult: { attempted: boolean, skipped: boolean, reason: string, hash: string, header: string, files: string[] } }>}
 */
async function resolvePitfall(pitfallsFile, options, runtime = {}) {
  const pfId = requireOption(options, "resolve");
  const resolution = requireOption(options, "resolution");
  if (!/^PF-\d+$/i.test(pfId)) {
    throw new VAPilotError("CONFIG_ERROR", `Invalid pitfall id '${pfId}'. Expected PF-<number>.`, { pitfallId: pfId });
  }
  if (String(resolution).trim() === "") {
    throw new VAPilotError("CONFIG_ERROR", "Resolution must not be empty", { pitfallId: pfId });
  }

  const data = readPitfalls(pitfallsFile);
  const entry = data.entries.find((e) => e.id === pfId);
  if (!entry) {
    throw new Error(`Pitfall not found: ${pfId}`);
  }
  validatePitfallForResolution(entry, pfId);
  const alreadyResolved = entry.resolvedAt && String(entry.resolvedAt).trim() !== "";
  if (alreadyResolved && String(entry.resolution ?? "").trim() !== "" && String(entry.resolution).trim() !== String(resolution).trim()) {
    throw new VAPilotError("CONFIG_ERROR", `Pitfall ${pfId} is already resolved with a different resolution`, {
      pitfallId: pfId,
      existingResolution: entry.resolution
    });
  }

  const configFile = runtime.configFile
    ? path.resolve(runtime.configFile)
    : path.resolve(path.dirname(pitfallsFile), "..", DEFAULT_CONFIG_FILE);
  const stateFile = runtime.stateFile
    ? path.resolve(runtime.stateFile)
    : path.resolve(path.dirname(pitfallsFile), "sprint-state.json");
  const task = findTaskForPitfall(stateFile, entry.taskId);
  const nextResolvedAt = alreadyResolved ? entry.resolvedAt : nowIso();
  const resolvedEntry = {
    ...entry,
    resolution,
    resolvedAt: nextResolvedAt
  };
  const constraintDocument = buildSynthesizedConstraintDocument(resolvedEntry, task, resolvedEntry.resolution);
  validateSynthesizedConstraintDocument(constraintDocument);
  const constraintsDir = resolveConstraintsDir(pitfallsFile, runtime);
  fs.mkdirSync(constraintsDir, { recursive: true });
  const constraintFile = constraintFilePathForPitfall(constraintsDir, entry);
  const projectDir = resolveProjectDirFromPilotArtifact(pitfallsFile);
  const commitBaseline = await captureConstraintCommitBaseline(
    [
      pitfallsFile,
      configFile,
      constraintFile,
      ...(runtime.journalFile ? [runtime.journalFile] : [])
    ],
    runtime.workDir ?? projectDir
  );

  if (!alreadyResolved || String(entry.resolution ?? "").trim() === "") {
    entry.resolution = resolution;
    entry.resolvedAt = nextResolvedAt;
    writePitfalls(pitfallsFile, data);
  }
  const constraintWritten = writeTextFileIfChanged(
    constraintFile,
    normalizeConstraintYamlContent(constraintDocument)
  );

  const suggestion = suggestGateFromPitfall(entry, { projectDir });
  const suggestionResult = appendSuggestedGate(configFile, suggestion);
  let journalAdded = false;
  if (runtime.journalFile) {
    const summary = suggestionResult.added
      ? `Resolved pitfall ${entry.id}. Suggested gate appended: ${suggestion.name} -> ${suggestion.command}`
      : `Resolved pitfall ${entry.id}. Suggested gate already present: ${suggestion.name} -> ${suggestion.command}`;
    journalAdded = appendJournalOnce(runtime.journalFile, {
      task: entry.taskId,
      summary,
      signals: [
        `pitfall-resolved:${entry.id}`,
        `adaptive-gate:${suggestion.name}`,
        `adaptive-gate-trigger:${suggestion.triggeredBy}`
      ].join(",")
    }, `pitfall-resolved:${entry.id}`);
  }

  const commitResult = await commitConstraintArtifacts(
    [
      pitfallsFile,
      configFile,
      constraintFile,
      ...(runtime.journalFile ? [runtime.journalFile] : [])
    ],
    task,
    {
      workDir: runtime.workDir ?? projectDir,
      baseline: commitBaseline
    }
  );

  return {
    id: entry.id,
    entry,
    skipped: Boolean(alreadyResolved && !constraintWritten && !journalAdded && !suggestionResult.added && commitResult.skipped),
    ...(alreadyResolved ? { reason: "already-resolved" } : {}),
    constraintFile,
    suggestionResult,
    journalAdded,
    constraintWritten,
    commitResult
  };
}

/**
 * @param {string} pitfallsFile
 * @param {Record<string, string>} options
 * @param {Set<string>} [flags]
 * @returns {PitfallRecord[]}
 */
function listPitfalls(pitfallsFile, options, flags) {
  const data = readPitfalls(pitfallsFile);
  let entries = data.entries;
  if (flags && flags.has("unresolved")) {
    entries = entries.filter((e) => e.resolvedAt === null || e.resolvedAt === "");
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Review command
// ---------------------------------------------------------------------------

/**
 * Derive a review perspective from changed file patterns.
 * Simplified version of selectSprintReviewPerspective from auto-pilot-loop.mjs.
 * @param {string[]} changedFiles
 * @returns {string}
 */
function deriveReviewPerspective(changedFiles) {
  const haystack = changedFiles.join("\n");

  if (changedFiles.some((f) => /(^|\/)(scripts|bin)\//.test(f)) || changedFiles.some((f) => /(^|\/)package\.json$/.test(f))) {
    return "a developer who automates this CLI in CI pipelines";
  }
  if (/(auth|security|token|credential|secret|apikey|api[_-]?key|bearer)/i.test(haystack)) {
    return "a security engineer doing post-incident review";
  }
  if (changedFiles.some((f) => /(protocol|spec|docs)/.test(f))) {
    return "an adopter who built tooling on this protocol";
  }
  if (changedFiles.some((f) => /(^|\/)(tests?|__tests__|\.test\.|\.spec\.)/i.test(f))) {
    return "a QA engineer verifying regression coverage";
  }
  return "an experienced engineer reviewing for correctness and maintainability";
}

/**
 * Format pitfall entries for inclusion in a review prompt.
 * @param {PitfallRecord[]} pitfalls
 * @returns {string}
 */
function formatPitfallsForPrompt(pitfalls) {
  if (!Array.isArray(pitfalls) || pitfalls.length === 0) {
    return "- none";
  }
  return pitfalls.map((p) => {
    const id = p.id ?? "PF-???";
    return `- ${id} [${p.failureType}]: attempted: ${p.attempted} | hypothesis: ${p.hypothesis}${p.missingContext ? ` | missing context: ${p.missingContext}` : ""}`;
  }).join("\n");
}

/**
 * Build the review prompt with perspective, pitfalls, and diff.
 * @param {object} params
 * @param {string} params.perspective
 * @param {PitfallRecord[]} params.pitfalls
 * @param {string[]} params.changedFiles
 * @param {string} params.diff
 * @returns {string}
 */
function buildReviewPrompt({ perspective, pitfalls, changedFiles, diff }) {
  return [
    "You are a code reviewer.",
    `Review from this perspective: ${perspective}`,
    "",
    "Known failure patterns to watch for:",
    formatPitfallsForPrompt(pitfalls),
    "",
    "Changed files:",
    changedFiles.length > 0 ? changedFiles.map((f) => `- ${f}`).join("\n") : "- none",
    "",
    "Diff:",
    diff || "(no diff)",
    "",
    "Return structured findings using this format:",
    "First line: REVIEW STATUS: PASS or REVIEW STATUS: FAIL",
    "Then one finding per line:",
    "[CRITICAL|P1|P2|STYLE] concise finding -- relative/path/to/file:line",
    "If there are no findings, emit no extra lines after REVIEW STATUS: PASS."
  ].join("\n");
}

/**
 * @param {unknown} error
 * @returns {string}
 */
function formatReviewCommandError(error) {
  const commandError = error && typeof error === "object"
    ? /** @type {{ stderr?: unknown, stdout?: unknown }} */ (error)
    : {};
  const stderr = String(commandError.stderr ?? "").trim();
  if (stderr) return stderr;

  const stdout = String(commandError.stdout ?? "").trim();
  if (stdout) return stdout;

  if (error instanceof Error) {
    return error.message;
  }

  return String(error ?? "Unknown error");
}

/**
 * @param {string} output
 * @returns {"PASS" | "FAIL" | "AMBIGUOUS"}
 */
function parseReviewStatus(output) {
  if (/^REVIEW STATUS:\s*FAIL\b/m.test(output)) {
    return "FAIL";
  }

  if (/^REVIEW STATUS:\s*PASS\b/m.test(output)) {
    return "PASS";
  }

  return "AMBIGUOUS";
}

/**
 * Run the review subcommand: gather context, build prompt, execute codex review.
 * @param {string} pitfallsFile
 * @param {object} [options]
 * @param {function} [options.execRunner] - Override for codex exec (testing)
 * @param {function} [options.gitRunner] - Override for git commands (testing)
 * @param {{ write(chunk: string): unknown }} [options.stdout] - Override stdout stream
 * @param {{ write(chunk: string): unknown }} [options.stderr] - Override stderr stream
 * @param {(code: number) => unknown} [options.exit] - Override process exit (testing)
 * @returns {Promise<void>}
 */
async function runReviewCommand(pitfallsFile, options) {
  const execRunner = options?.execRunner;
  const gitRunner = options?.gitRunner;
  const stdout = options?.stdout ?? process.stdout;
  const stderr = options?.stderr ?? process.stderr;
  const exit = options?.exit ?? ((code) => process.exit(code));
  const workDir = process.cwd();

  // 1. Read unresolved pitfalls
  const data = readPitfalls(pitfallsFile);
  const unresolvedPitfalls = data.entries.filter((e) => !e.resolvedAt);

  // 2. Collect changed files
  /** @param {string[]} args */
  const gitExec = async (args) => {
    if (typeof gitRunner === "function") {
      return String(await gitRunner(args)).trim();
    }

    const result = await execFileAsync("git", args, {
      encoding: "utf8",
      cwd: workDir,
      timeout: DEFAULT_SPRINT_BOARD_TIMEOUT_MS
    });
    return String(result.stdout ?? "").trim();
  };

  let changedFiles = [];
  try {
    const tracked = await gitExec(["diff", "--name-only", "HEAD"]);
    const untracked = await gitExec(["ls-files", "--others", "--exclude-standard"]);
    changedFiles = [...new Set([
      ...tracked.split("\n").filter(Boolean),
      ...untracked.split("\n").filter(Boolean)
    ])];
  } catch (error) {
    stderr.write(
      `Warning: failed to collect changed files via git; continuing with partial review context. ${formatReviewCommandError(error)}\n`
    );
  }

  // 3. Derive perspective
  const perspective = deriveReviewPerspective(changedFiles);

  // 4. Collect diff
  let diff = "";
  try {
    diff = await gitExec(["diff", "HEAD"]);
  } catch (error) {
    stderr.write(
      `Warning: failed to collect git diff; continuing with partial review context. ${formatReviewCommandError(error)}\n`
    );
  }

  // 5. Build prompt
  const prompt = buildReviewPrompt({
    perspective,
    pitfalls: unresolvedPitfalls,
    changedFiles,
    diff
  });

  // 6. Execute codex review
  const output = await (async () => {
    try {
      const result = typeof execRunner === "function"
        ? await execRunner(prompt)
        : await execFileAsync("codex", [
          "exec",
          "--sandbox", "read-only",
          "-C", workDir,
          prompt
        ], {
          encoding: "utf8",
          cwd: workDir,
          timeout: 120_000
        });
      return String(result.stdout ?? result.output ?? "");
    } catch (error) {
      const commandStdout = String(error?.stdout ?? "");
      if (commandStdout) {
        return commandStdout;
      }

      stderr.write(`Error: review command failed before producing output. ${formatReviewCommandError(error)}\n`);
      exit(1);
      return null;
    }
  })();

  if (output === null) {
    return;
  }

  // 7. Print output
  stdout.write(output);
  if (output.length > 0 && !output.endsWith("\n")) {
    stdout.write("\n");
  }

  const status = parseReviewStatus(output);
  if (status === "FAIL") {
    exit(1);
    return;
  }

  if (status === "PASS") {
    exit(0);
    return;
  }

  stderr.write("Error: ambiguous review output; expected REVIEW STATUS: PASS or REVIEW STATUS: FAIL.\n");
  exit(1);
}

async function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv, new Set(["json", "help", "reset-fail-count", "unresolved", "list", "strict", "view", "validate", "reuse-source-title"]));

  if (!parsed.command || parsed.flags.has("help") || parsed.command === "help") {
    printHelp();
    return;
  }

  const stateFile = path.resolve(parsed.options["state-file"] ?? DEFAULTS.stateFile);
  const boardFile = path.resolve(parsed.options["board-file"] ?? DEFAULTS.boardFile);
  const journalFile = path.resolve(parsed.options["journal-file"] ?? DEFAULTS.journalFile);
  const pitfallsFile = path.resolve(parsed.options["pitfalls-file"] ?? DEFAULT_PITFALLS_FILE);
  const historyFile = resolveEvalHistoryFile(process.cwd(), parsed.options["history-file"] ?? DEFAULT_EVAL_HISTORY_FILE);
  const humanBoardFile = resolveHumanBoardPath(stateFile);

  if (parsed.command === "journal") {
    if (parsed.flags.has("view")) {
      process.stdout.write(renderJournalView(journalFile));
      return;
    }
    appendJournal(journalFile, parsed.options);
    console.log(`Journal updated: ${path.relative(process.cwd(), journalFile)}`);
    return;
  }

  if (parsed.command === "summary") {
    if (parsed.flags.has("validate")) {
      if (!fs.existsSync(stateFile)) {
        console.error(`check:sprint failed: sprint state file not found (${path.relative(process.cwd(), stateFile)}).`);
        process.exit(1);
      }
      const state = readState(stateFile);
      printSummary(state, pitfallsFile);
      return;
    }
    const state = readState(stateFile);
    printSummary(state, pitfallsFile);
    return;
  }

  if (parsed.command === "claim") {
    const runId = requireOption(parsed.options, "run-id");
    const taskOpt = String(parsed.options.task ?? "");
    const taskIds = taskOpt
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean);
    const rawCount = parsed.options.count ?? "1";
    const count = Number.parseInt(String(rawCount), 10);
    if (taskIds.length === 0 && (!Number.isFinite(count) || count <= 0)) {
      throw new Error("Invalid --count value. Expected a positive integer (or pass --task <ids>).");
    }

    const ttlMs = resolveClaimTtlMs(path.resolve(DEFAULT_CONFIG_FILE));
    /** @type {{ runId: string, claimedTasks: Array<{ taskId: string, reclaimed: boolean }> } | null} */
    let result = null;
    await withPilotFileLock(stateFile, async () => {
      const state = readState(stateFile);
      result = claimTasksInState(state, runId, count, ttlMs, Date.now(), taskIds);
      writeState(stateFile, state);
      writeBoard(boardFile, state);
    });

    if (!result) {
      throw new Error("Task claim did not produce a result.");
    }

    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.claimedTasks.length === 0) {
      console.log(`No claimable tasks for ${runId}.`);
    } else {
      console.log(`Claimed for ${runId}: ${result.claimedTasks.map((task) => task.taskId).join(", ")}`);
    }
    return;
  }

  if (parsed.command === "release") {
    const runId = requireOption(parsed.options, "run-id");
    const taskId = parsed.options.task ?? "";
    /** @type {{ runId: string, releasedTasks: string[] } | null} */
    let result = null;
    await withPilotFileLock(stateFile, async () => {
      const state = readState(stateFile);
      result = releaseClaimsInState(state, runId, taskId);
      writeState(stateFile, state);
      writeBoard(boardFile, state);
    });

    if (!result) {
      throw new Error("Task release did not produce a result.");
    }

    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    if (result.releasedTasks.length === 0) {
      console.log(`No claims released for ${runId}.`);
    } else {
      console.log(`Released for ${runId}: ${result.releasedTasks.join(", ")}`);
    }
    return;
  }

  if (parsed.command === "next") {
    const uncheckedInstructions = readHumanBoardInstructions(humanBoardFile);
    const strictMode = parsed.flags.has("strict");
    if (uncheckedInstructions.length > 0 && strictMode) {
      const error = buildHumanBoardBlockError(humanBoardFile, uncheckedInstructions);
      printCommandError(parsed.flags.has("json"), error);
      process.exitCode = 1;
      return;
    }

    if (uncheckedInstructions.length > 0 && !parsed.flags.has("json")) {
      console.error(formatHumanBoardWarning(uncheckedInstructions));
    }

    const state = readState(stateFile);
    const next = findNextTask(state.tasks);

    if (parsed.flags.has("json")) {
      if (next && uncheckedInstructions.length > 0) {
        console.log(JSON.stringify({
          ...next,
          human_board_instructions: uncheckedInstructions
        }, null, 2));
      } else {
        console.log(JSON.stringify(next, null, 2));
      }
      return;
    }

    if (!next) {
      console.log("No actionable task found.");
      return;
    }

    console.log(`${next.task.id} ${next.action}`);
    console.log(`${next.task.title}`);
    return;
  }

  if (parsed.command === "plan") {
    const rawMaxParallel = parsed.options["max-parallel"];
    const maxParallel =
      rawMaxParallel === undefined
        ? DEFAULT_MAX_PARALLEL
        : Number.parseInt(String(rawMaxParallel), 10);

    if (!Number.isFinite(maxParallel) || maxParallel < 0) {
      throw new Error("Invalid --max-parallel value. Expected a non-negative integer.");
    }

    const claimRunId = String(parsed.options["claim-run-id"] ?? "");

    // Atomic plan-and-claim: select tasks AND stamp ownership inside the same file
    // lock, so two concurrent runs cannot both select the same Backlog task (the
    // check-then-act window between a lock-free plan and a separate claim call was
    // a real race — see dogfood finding #1). buildParallelPlan already skips tasks
    // actively claimed by another run, so within the lock the selection is stable.
    if (claimRunId) {
      const ttlMs = resolveClaimTtlMs(path.resolve(DEFAULT_CONFIG_FILE));
      // Optional claim budget (dogfood #4): limits how many Backlog tasks one run
      // claims in a single plan, so a shared workspace with multiple runs does not let
      // the first run to arrive claim every task and starve the others. 0 = unlimited.
      const maxClaim = Number.parseInt(String(parsed.options["max-claim"] ?? "0"), 10);
      /** @type {ParallelPlan | null} */
      let plan = null;
      await withPilotFileLock(stateFile, async () => {
        const state = readState(stateFile);
        plan = buildParallelPlan(state.tasks, maxParallel, Date.now(), claimRunId);
        if (plan) {
          let planTaskIds = [plan.primaryTaskId, ...(plan.parallelTracks ?? [])]
            .map((id) => String(id ?? ""))
            .filter(Boolean);
          if (Number.isFinite(maxClaim) && maxClaim > 0 && planTaskIds.length > maxClaim) {
            planTaskIds = planTaskIds.slice(0, maxClaim);
            // The returned plan must match what was actually claimed — otherwise dispatch
            // would queue tasks this run never claimed (and a sibling may have claimed).
            // primary is always planTaskIds[0] (the first N); trim parallelTracks to the
            // remainder within the budget.
            plan = {
              ...plan,
              parallelTracks: planTaskIds.slice(1),
              dependencyGraph: Object.fromEntries(
                Object.entries(plan.dependencyGraph ?? {}).filter(([id]) => planTaskIds.includes(id))
              ),
            };
          }
          const claimResult = claimTasksInState(state, claimRunId, planTaskIds.length, ttlMs, Date.now(), planTaskIds);
          const claimedIds = new Set(claimResult.claimedTasks.map((task) => task.taskId));
          const missingClaims = planTaskIds.filter((taskId) => !claimedIds.has(taskId));
          if (missingClaims.length > 0) {
            throw new Error(`Plan claim conflict for ${claimRunId}: ${missingClaims.join(", ")}`);
          }
          writeState(stateFile, state);
          writeBoard(boardFile, state);
        }
      });

      if (!plan) {
        if (parsed.flags.has("json")) {
          console.log("null");
        } else {
          console.log("No actionable task found.");
        }
        return;
      }
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(plan, null, 2));
        return;
      }
      console.log(`Primary    : ${plan.primaryTaskId} (${plan.primaryAction}) [claimed by ${claimRunId}]`);
      console.log(plan.parallelTracks.length === 0 ? "Parallel   : none" : `Parallel   : ${plan.parallelTracks.join(", ")}`);
      return;
    }

    const state = readState(stateFile);
    const plan = buildParallelPlan(state.tasks, maxParallel);

    if (!plan) {
      if (parsed.flags.has("json")) {
        console.log("null");
      } else {
        console.log("No actionable task found.");
      }
      return;
    }

    if (parsed.flags.has("json")) {
      console.log(JSON.stringify(plan, null, 2));
      return;
    }

    console.log(`Primary    : ${plan.primaryTaskId} (${plan.primaryAction})`);
    if (plan.parallelTracks.length === 0) {
      console.log("Parallel   : none");
    } else {
      console.log(`Parallel   : ${plan.parallelTracks.join(", ")}`);
    }
    console.log(`Sync Points: ${plan.syncPoints.join(", ")}`);
    return;
  }

  if (parsed.command === "suggest-gate") {
    const suggestions = suggestGatesFromPitfalls(readPitfalls(pitfallsFile).entries, {
      projectDir: resolveProjectDirFromPilotArtifact(pitfallsFile)
    });
    process.stdout.write(stringifyYaml(suggestions));
    return;
  }

  if (parsed.command === "eval-compare") {
    const limit = Number.parseInt(String(parsed.options.limit ?? "10"), 10);
    const gate = String(parsed.options.gate ?? "");
    const records = readEvalHistory(historyFile);
    const summary = summarizeEvalHistory(records, { gate, limit });
    if (parsed.flags.has("json")) {
      console.log(JSON.stringify({
        historyFile,
        gate: gate || null,
        limit: Number.isFinite(limit) ? limit : 10,
        ...summary,
      }, null, 2));
    } else {
      process.stdout.write(formatEvalCompare(summary, { gate, historyFile }));
    }
    return;
  }

  if (parsed.command === "render") {
    await withPilotFileLock(stateFile, async () => {
      const state = readState(stateFile);
      writeBoard(boardFile, state);
    });
    console.log(`Sprint board rendered: ${path.relative(process.cwd(), boardFile)}`);
    return;
  }

  if (parsed.command === "add") {
    /** @type {Task | null} */
    let task = null;
    let reused = false;
    await withPilotFileLock(stateFile, async () => {
      const state = readState(stateFile);
      task = parsed.flags.has("reuse-source-title")
        ? state.tasks.find((item) => (
          item.source === String(parsed.options.source ?? "")
          && item.title === String(parsed.options.title ?? "")
          && Boolean(item.source)
        )) ?? null
        : null;
      reused = Boolean(task);
      if (!task) {
        task = addTask(state, parsed.options);
        writeState(stateFile, state);
        writeBoard(boardFile, state);
      }
    });
    if (!task) {
      throw new Error("Task add did not produce a task.");
    }
    console.log(`Task ${reused ? "reused" : "added"}: ${task.id}`);
    console.log(`State file: ${path.relative(process.cwd(), stateFile)}`);
    console.log(`Board file: ${path.relative(process.cwd(), boardFile)}`);
    return;
  }

  if (parsed.command === "update") {
    /** @type {Task | null} */
    let task = null;
    await withPilotFileLock(stateFile, async () => {
      const state = readState(stateFile);
      task = updateTask(state, parsed.options, parsed.flags);
      writeState(stateFile, state);
      writeBoard(boardFile, state);
    });
    if (!task) {
      throw new Error("Task update did not find a task.");
    }
    console.log(`Task updated: ${task.id} -> ${task.state}`);
    console.log(`State file: ${path.relative(process.cwd(), stateFile)}`);
    console.log(`Board file: ${path.relative(process.cwd(), boardFile)}`);
    return;
  }

  if (parsed.command === "pitfall") {
    // --resolve: mark an existing entry resolved
    if (parsed.options.resolve) {
      /** @type {Awaited<ReturnType<typeof resolvePitfall>> | null} */
      let result = null;
      await withPilotFileLock(pitfallsFile, async () => {
        result = await resolvePitfall(pitfallsFile, parsed.options, {
          journalFile,
          configFile: path.resolve(DEFAULT_CONFIG_FILE),
          stateFile,
          workDir: resolveProjectDirFromPilotArtifact(pitfallsFile)
        });
      });
      if (!result) {
        throw new Error("Pitfall resolve did not produce a result.");
      }
      if (result.skipped) {
        console.log(`Pitfall already resolved: ${result.id} (skipped)`);
      } else {
        console.log(`Pitfall resolved: ${result.id}`);
        console.log(`Pitfalls file: ${path.relative(process.cwd(), pitfallsFile)}`);
        console.log(`Constraint file: ${path.relative(process.cwd(), result.constraintFile)}`);
      }
      if (!result.skipped) {
        if (result.commitResult.skipped) {
          console.log(`Commit skipped: ${result.commitResult.reason}`);
        } else {
          console.log(`Commit: ${result.commitResult.hash} (${result.commitResult.header})`);
        }
      }
      return;
    }

    // --list: print entries
    if (parsed.flags.has("list")) {
      const entries = listPitfalls(pitfallsFile, parsed.options, parsed.flags);
      if (parsed.flags.has("json")) {
        console.log(JSON.stringify(entries, null, 2));
      } else {
        if (entries.length === 0) {
          console.log("No pitfall entries found.");
        } else {
          const unresolvedCount = entries.filter((e) => e.resolvedAt === null || e.resolvedAt === "").length;
          console.log(`${entries.length} entries, ${unresolvedCount} unresolved`);
          for (const e of entries) {
            const resolved = e.resolvedAt ? `resolved ${String(e.resolvedAt).slice(0, 10)}` : "unresolved";
            console.log(`${e.id} [${e.taskId}] [${e.failureType}] ${resolved}`);
            console.log(`  attempted: ${e.attempted}`);
            console.log(`  hypothesis: ${e.hypothesis}`);
            if (e.missingContext) console.log(`  missingContext: ${e.missingContext}`);
            if (e.resolution) console.log(`  resolution: ${e.resolution}`);
          }
        }
      }
      return;
    }

    // default: add a new pitfall entry
    const entry = addPitfall(pitfallsFile, parsed.options);
    console.log(`Pitfall recorded: ${entry.id}`);
    console.log(`Pitfalls file: ${path.relative(process.cwd(), pitfallsFile)}`);
    return;
  }

  if (parsed.command === "review") {
    runReviewCommand(pitfallsFile).catch((err) => {
      printCommandError(parsed.flags.has("json"), err instanceof Error ? err : new Error(String(err)));
      process.exit(1);
    });
    return;
  }

  throw new Error(`Unknown command: ${parsed.command}`);
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------
export {
  deriveReviewPerspective,
  formatPitfallsForPrompt,
  buildReviewPrompt,
  runReviewCommand,
  parseReviewStatus
};

// Only run main() when this file is the entry point (not when imported).
// The realpath fallback preserves execution through symlinks (e.g. linked PATH
// entries or symlinked project scripts), matching isMainModule() in auto-pilot.mjs.
const isMain = (() => {
  if (!process.argv[1]) return false;
  const argvPath = path.resolve(process.argv[1]);
  if (pathToFileURL(argvPath).href === import.meta.url) return true;
  try {
    return pathToFileURL(fs.realpathSync(argvPath)).href === import.meta.url;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((error) => {
    const wantsJson = process.argv.slice(2).some((token) => token === "--json" || token.startsWith("--json="));
    printCommandError(wantsJson, error instanceof Error ? error : new Error(String(error)));
    process.exit(1);
  });
}
