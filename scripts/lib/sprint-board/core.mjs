#!/usr/bin/env node

import { VAPilotError } from "../errors.mjs";
import { nowIso } from "../sprint-utils.mjs";

/**
 * @typedef {import("../sprint-utils.mjs").Task} Task
 */

/**
 * @typedef {"Backlog" | "In Progress" | "Review" | "Testing" | "Failed" | "Done"} TaskState
 */

/**
 * @typedef {Object} NextTaskResult
 * @property {string} state
 * @property {string} action
 * @property {Task} task
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

/** @type {readonly string[]} */
const VALID_STATES = ["Backlog", "In Progress", "Review", "Testing", "Failed", "Done"];
const NEXT_ORDER = ["Failed", "Testing", "Review", "In Progress", "Backlog"];
const PRIORITY_WEIGHT = { P0: 0, P1: 1, P2: 2, P3: 3 };
const DEFAULT_MAX_PARALLEL = 2;

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
 * @param {Task} task
 * @param {Set<string>} doneIds
 * @returns {boolean}
 */
function isDependencySatisfied(task, doneIds) {
  return task.dependsOn.every((dependencyId) => doneIds.has(dependencyId));
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
 * Counts tasks that are not yet Done.
 *
 * @param {{ tasks?: Array<{ state?: string }> }} state
 * @returns {number}
 */
function countPendingTasks(state) {
  return Array.isArray(state.tasks)
    ? state.tasks.filter((task) => task?.state !== "Done").length
    : 0;
}

export {
  VALID_STATES,
  NEXT_ORDER,
  PRIORITY_WEIGHT,
  DEFAULT_MAX_PARALLEL,
  normalizeDependsOn,
  normalizeTask,
  escapeCell,
  sortTasks,
  isDependencySatisfied,
  detectCycles,
  findNextTask,
  buildParallelPlan,
  countPendingTasks
};
