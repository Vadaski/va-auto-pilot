#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import {
  nowIso,
  resolveDefaults,
  parseArgv,
  requireOption
} from "./lib/sprint-utils.mjs";
import {
  resolveHumanBoardPath,
  readHumanBoardInstructions
} from "./lib/human-board.mjs";
import { VAPilotError } from "./lib/errors.mjs";

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

/** @type {readonly string[]} */
const VALID_STATES = ["Backlog", "In Progress", "Review", "Testing", "Failed", "Done"];
const NEXT_ORDER = ["Failed", "Testing", "Review", "In Progress", "Backlog"];
const PRIORITY_WEIGHT = { P0: 0, P1: 1, P2: 2, P3: 3 };
const DEFAULT_MAX_PARALLEL = 2;

const DEFAULTS = resolveDefaults();
const DEFAULT_PITFALLS_FILE = ".va-auto-pilot/pitfalls.json";
const VALID_FAILURE_TYPES = ["gate", "acceptance", "review"];

function printHelp() {
  console.log(`sprint-board

Usage:
  node scripts/sprint-board.mjs summary [--state-file <path>]
  node scripts/sprint-board.mjs next [--json] [--strict] [--state-file <path>]
  node scripts/sprint-board.mjs plan [--json] [--max-parallel <n>] [--state-file <path>]
  node scripts/sprint-board.mjs render [--state-file <path>] [--board-file <path>]
  node scripts/sprint-board.mjs add --title <text> --priority <P0|P1|P2|P3> [options]
  node scripts/sprint-board.mjs update --id <TASK-ID> [--state <state>] [options]
  node scripts/sprint-board.mjs journal --task <TASK-ID> --summary <text> [options]
  node scripts/sprint-board.mjs pitfall --task <TASK-ID> --failure-type <gate|acceptance|review> --attempted <text> --hypothesis <text> [--missing-context <text>]
  node scripts/sprint-board.mjs pitfall --resolve <PF-ID> --resolution <text>
  node scripts/sprint-board.mjs pitfall --list [--unresolved] [--json]

Options (add):
  --title <text>            (required) Task title
  --priority <P0|P1|P2|P3> (required) Task priority
  --source <text>           Origin of the task (e.g. "codex review", "dogfood")
  --depends-on <ID1,ID2,...> Comma-separated task IDs this task depends on

Options (update):
  --title <text>
  --priority <P0|P1|P2|P3>
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
  --strict                  Keep human-board Instructions as a hard block

Global options:
  --max-parallel <n>
  --state-file <path>
  --board-file <path>
  --journal-file <path>
  --pitfalls-file <path>
`);
}

/**
 * @param {string} code
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
      console.error(`Human board: ${context.boardFile}`);
    }
    if (Array.isArray(context.instructions) && context.instructions.length > 0) {
      console.error("Unprocessed Instructions:");
      for (const instruction of context.instructions) {
        const lineNumber = instruction?.lineNumber ?? "?";
        const text = instruction?.text ?? "";
        console.error(`  - line ${lineNumber}: ${text}`);
      }
    }
    console.error("Process the human-board Instructions, mark them [x], then run next again.");
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
    `Warning: human-board Instructions contain ${instructions.length} unprocessed item(s).`,
    "Continuing because --strict was not provided.",
    "Unprocessed Instructions:"
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
  const message = `human-board Instructions contain ${instructions.length} unprocessed item(s).`;
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
 * @param {unknown} value
 * @returns {string}
 */
function escapeCell(value) {
  const input = String(value ?? "").trim();
  if (!input) return "-";
  return input.replaceAll("|", "\\|").replaceAll("\n", "<br>");
}

/**
 * @param {Task[]} tasks
 * @returns {Task[]}
 */
function sortTasks(tasks) {
  return [...tasks].sort((a, b) => {
    const pA = PRIORITY_WEIGHT[a.priority] ?? 99;
    const pB = PRIORITY_WEIGHT[b.priority] ?? 99;
    if (pA !== pB) return pA - pB;

    const cA = String(a.createdAt ?? "");
    const cB = String(b.createdAt ?? "");
    if (cA !== cB) return cA.localeCompare(cB);

    return String(a.id ?? "").localeCompare(String(b.id ?? ""));
  });
}

/**
 * @param {string | string[] | undefined} raw
 * @returns {string[]}
 */
function normalizeDependsOn(raw) {
  if (Array.isArray(raw)) {
    return raw.map((item) => String(item ?? "").trim()).filter(Boolean);
  }

  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }

  return [];
}

/**
 * Normalizes a raw task object into a fully-populated Task with default values.
 *
 * @param {Partial<Task> & Record<string, unknown>} task
 * @returns {Task}
 */
function normalizeTask(task) {
  return {
    id: String(task.id ?? ""),
    title: String(task.title ?? ""),
    priority: String(task.priority ?? "P2"),
    state: String(task.state ?? "Backlog"),
    owner: String(task.owner ?? ""),
    source: String(task.source ?? ""),
    createdAt: String(task.createdAt ?? ""),
    startedAt: String(task.startedAt ?? ""),
    completedAt: String(task.completedAt ?? ""),
    lastFailedAt: String(task.lastFailedAt ?? ""),
    failCount: Number(task.failCount ?? 0),
    reason: String(task.reason ?? ""),
    verification: String(task.verification ?? ""),
    notes: String(task.notes ?? ""),
    review: {
      implementer: String(task.review?.implementer ?? ""),
      security: String(task.review?.security ?? ""),
      qa: String(task.review?.qa ?? ""),
      domain: String(task.review?.domain ?? ""),
      architect: String(task.review?.architect ?? "")
    },
    testing: {
      flow: String(task.testing?.flow ?? ""),
      mustPassRate: String(task.testing?.mustPassRate ?? ""),
      shouldPassRate: String(task.testing?.shouldPassRate ?? "")
    },
    dependsOn: normalizeDependsOn(task.dependsOn),
    failureDetail: task.failureDetail != null ? {
      failureType: String(task.failureDetail.failureType ?? ""),
      attempted: String(task.failureDetail.attempted ?? ""),
      hypothesis: String(task.failureDetail.hypothesis ?? ""),
      missingContext: String(task.failureDetail.missingContext ?? "")
    } : undefined
  };
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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
 * @param {string} boardFile
 * @param {SprintState} state
 * @returns {void}
 */
function writeBoard(boardFile, state) {
  const markdown = renderBoardMarkdown(state);
  fs.mkdirSync(path.dirname(boardFile), { recursive: true });
  fs.writeFileSync(boardFile, markdown, "utf8");
}

/**
 * Detects dependency cycles using DFS.
 *
 * Returns an array of cycle descriptions (empty if no cycles).
 * Each description is a string like "A -> B -> C -> A".
 *
 * @param {Task[]} tasks
 * @returns {string[]}
 */
function detectCycles(tasks) {
  const adjById = new Map();
  for (const task of tasks) {
    adjById.set(task.id, task.dependsOn ?? []);
  }

  // 0 = unvisited, 1 = in stack, 2 = done
  const color = new Map();
  const parent = new Map();
  const cycles = [];

  function dfs(nodeId) {
    color.set(nodeId, 1);

    for (const depId of (adjById.get(nodeId) ?? [])) {
      if (!adjById.has(depId)) continue; // unknown dep, skip

      if (color.get(depId) === 1) {
        // Back edge found — reconstruct the cycle path
        const path = [depId];
        let cur = nodeId;
        while (cur !== depId) {
          path.unshift(cur);
          cur = parent.get(cur);
          if (cur === undefined) break; // safety guard
        }
        path.unshift(depId);
        cycles.push(path.join(" -> "));
        continue;
      }

      if (!color.has(depId) || color.get(depId) === 0) {
        parent.set(depId, nodeId);
        dfs(depId);
      }
    }

    color.set(nodeId, 2);
  }

  for (const task of tasks) {
    if (!color.has(task.id) || color.get(task.id) === 0) {
      dfs(task.id);
    }
  }

  return cycles;
}

/**
 * @param {Task} task
 * @param {Set<string>} doneIds
 * @returns {boolean}
 */
function isDependencySatisfied(task, doneIds) {
  return task.dependsOn.every((dependencyId) => doneIds.has(dependencyId));
}

/**
 * @param {Task[]} tasks
 * @returns {NextTaskResult | null}
 */
function findNextTask(tasks) {
  const doneIds = new Set(
    tasks
      .filter((task) => task.state === "Done")
      .map((task) => task.id)
  );

  for (const state of NEXT_ORDER) {
    let candidates = sortTasks(tasks.filter((task) => task.state === state));
    if (state === "Backlog") {
      candidates = candidates.filter((task) => isDependencySatisfied(task, doneIds));
    }

    if (candidates.length > 0) {
      const action =
        state === "Failed"
          ? "fix-and-retest"
          : state === "Testing"
            ? "run-acceptance"
            : state === "Review"
              ? "run-review"
              : state === "In Progress"
                ? "continue-implementation"
                : "start-task";
      return { state, action, task: candidates[0] };
    }
  }

  return null;
}

/**
 * @param {Task[]} tasks
 * @param {number} maxParallel
 * @returns {ParallelPlan | null}
 */
function buildParallelPlan(tasks, maxParallel) {
  // Guard: report cycles before planning to prevent silent deadlocks.
  const cycles = detectCycles(tasks);
  if (cycles.length > 0) {
    throw new VAPilotError(
      "CYCLE_DETECTED",
      `Dependency cycle(s) detected in sprint state:\n${cycles.map((c) => `  ${c}`).join("\n")}\nFix dependsOn fields before running a parallel plan.`,
      { cycles }
    );
  }

  const primary = findNextTask(tasks);
  if (!primary) return null;

  const parallelAllowedActions = new Set(["start-task", "continue-implementation"]);
  const doneIds = new Set(
    tasks
      .filter((task) => task.state === "Done")
      .map((task) => task.id)
  );
  const primaryTask = primary.task;

  const dependencyGraph = {
    [primaryTask.id]: [...primaryTask.dependsOn]
  };

  if (!parallelAllowedActions.has(primary.action) || maxParallel <= 0) {
    return {
      generatedAt: nowIso(),
      primaryTaskId: primaryTask.id,
      primaryAction: primary.action,
      parallelTracks: [],
      dependencyGraph,
      syncPoints: ["quality-gates"]
    };
  }

  const tracks = [];
  const backlog = sortTasks(tasks.filter((task) => task.state === "Backlog" && task.id !== primaryTask.id));

  for (const task of backlog) {
    if (tracks.length >= maxParallel) break;
    if (task.dependsOn.includes(primaryTask.id)) continue;
    if (!isDependencySatisfied(task, doneIds)) continue;
    tracks.push(task.id);
    dependencyGraph[task.id] = [...task.dependsOn];
  }

  return {
    generatedAt: nowIso(),
    primaryTaskId: primaryTask.id,
    primaryAction: primary.action,
    parallelTracks: tracks,
    dependencyGraph,
    syncPoints: ["quality-gates"]
  };
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
    owner: "",
    source: options.source ?? "",
    createdAt,
    startedAt: "",
    completedAt: "",
    lastFailedAt: "",
    failCount: 0,
    reason: "",
    verification: "",
    notes: "",
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

  if (options.state) {
    if (!VALID_STATES.includes(options.state)) {
      throw new VAPilotError("INVALID_STATE", `Invalid state '${options.state}'. Expected one of: ${VALID_STATES.join(", ")}`, { state: options.state, validStates: [...VALID_STATES] });
    }

    task.state = options.state;

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
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
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
 * @returns {PitfallRecord}
 */
function resolvePitfall(pitfallsFile, options) {
  const pfId = requireOption(options, "resolve");
  const resolution = requireOption(options, "resolution");

  const data = readPitfalls(pitfallsFile);
  const entry = data.entries.find((e) => e.id === pfId);
  if (!entry) {
    throw new Error(`Pitfall not found: ${pfId}`);
  }
  entry.resolution = resolution;
  entry.resolvedAt = nowIso();
  writePitfalls(pitfallsFile, data);
  return entry;
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

function main() {
  const argv = process.argv.slice(2);
  const parsed = parseArgv(argv, new Set(["json", "help", "reset-fail-count", "unresolved", "list", "strict"]));

  if (!parsed.command || parsed.flags.has("help") || parsed.command === "help") {
    printHelp();
    return;
  }

  const stateFile = path.resolve(parsed.options["state-file"] ?? DEFAULTS.stateFile);
  const boardFile = path.resolve(parsed.options["board-file"] ?? DEFAULTS.boardFile);
  const journalFile = path.resolve(parsed.options["journal-file"] ?? DEFAULTS.journalFile);
  const pitfallsFile = path.resolve(parsed.options["pitfalls-file"] ?? DEFAULT_PITFALLS_FILE);
  const humanBoardFile = resolveHumanBoardPath(stateFile);

  if (parsed.command === "journal") {
    appendJournal(journalFile, parsed.options);
    console.log(`Journal updated: ${path.relative(process.cwd(), journalFile)}`);
    return;
  }

  if (parsed.command === "summary") {
    const state = readState(stateFile);
    printSummary(state, pitfallsFile);
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

  if (parsed.command === "render") {
    const state = readState(stateFile);
    writeBoard(boardFile, state);
    console.log(`Sprint board rendered: ${path.relative(process.cwd(), boardFile)}`);
    return;
  }

  if (parsed.command === "add") {
    const state = readState(stateFile);
    const task = addTask(state, parsed.options);
    writeState(stateFile, state);
    writeBoard(boardFile, state);
    console.log(`Task added: ${task.id}`);
    console.log(`State file: ${path.relative(process.cwd(), stateFile)}`);
    console.log(`Board file: ${path.relative(process.cwd(), boardFile)}`);
    return;
  }

  if (parsed.command === "update") {
    const state = readState(stateFile);
    const task = updateTask(state, parsed.options, parsed.flags);
    writeState(stateFile, state);
    writeBoard(boardFile, state);
    console.log(`Task updated: ${task.id} -> ${task.state}`);
    console.log(`State file: ${path.relative(process.cwd(), stateFile)}`);
    console.log(`Board file: ${path.relative(process.cwd(), boardFile)}`);
    return;
  }

  if (parsed.command === "pitfall") {
    // --resolve: mark an existing entry resolved
    if (parsed.options.resolve) {
      const entry = resolvePitfall(pitfallsFile, parsed.options);
      console.log(`Pitfall resolved: ${entry.id}`);
      console.log(`Pitfalls file: ${path.relative(process.cwd(), pitfallsFile)}`);
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

  throw new Error(`Unknown command: ${parsed.command}`);
}

try {
  main();
} catch (error) {
  const wantsJson = process.argv.slice(2).some((token) => token === "--json" || token.startsWith("--json="));
  printCommandError(wantsJson, error instanceof Error ? error : new Error(String(error)));
  process.exit(1);
}
