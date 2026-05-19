import fs from "node:fs";

import { readHumanBoardInstructions, resolveHumanBoardPath } from "./lib/human-board.mjs";
import { buildOrchestrationOpts, emitResult, sprintBoardExec, tryParseJson } from "./lib/orchestration-cli.mjs";
import {
  hasHaltDirective,
  orchestrationPaths,
  readCheckpoint,
  readDirectives,
  readRun,
  readSprintStateFile,
  readTracks,
  writeSnapshot,
} from "./lib/orchestration-state.mjs";
import { detectStopCondition, readSprintState } from "./auto-pilot-loop.mjs";

function tailJournal(journalFile, maxEntries = 5) {
  if (!fs.existsSync(journalFile)) {
    return [];
  }
  const content = fs.readFileSync(journalFile, "utf8");
  const blocks = content.split(/^## /m).filter(Boolean);
  return blocks.slice(-maxEntries).map((block) => `## ${block.trim()}`);
}

export async function refreshSnapshot(opts) {
  const run = readRun(opts.workDir);
  const tracks = readTracks(opts.workDir);
  const checkpoint = readCheckpoint(opts.workDir);
  const directives = readDirectives(opts.workDir);
  const state = readSprintState(opts.stateFile);
  const stopCondition = detectStopCondition(state);

  const boardPath = resolveHumanBoardPath(opts.stateFile);
  const uncheckedBoard = readHumanBoardInstructions(boardPath);

  const summaryResult = await sprintBoardExec(["summary"], opts);
  const pitfallResult = await sprintBoardExec(["pitfall", "--list", "--unresolved", "--json"], opts);
  const pitfallsParsed = tryParseJson(pitfallResult.stdout.trim());

  const pendingTasks = Array.isArray(state.tasks)
    ? state.tasks.filter((task) => task.state !== "Done").length
    : 0;

  const trackList = tracks?.tracks ?? [];
  const anomalies = buildAnomalies({
    run,
    trackList,
    state,
    pendingTasks,
    stopCondition,
  });

  const snapshot = {
    schemaVersion: 1,
    updatedAt: new Date().toISOString(),
    run,
    tracks: tracks?.tracks ? tracks : { runId: run?.runId ?? null, tracks: [] },
    checkpoint,
    directives: {
      halt: hasHaltDirective(directives),
      items: directives.directives ?? [],
    },
    sprint: {
      pendingTasks,
      stopCondition,
      taskCount: state.tasks?.length ?? 0,
    },
    humanBoard: {
      uncheckedCount: uncheckedBoard.length,
      unchecked: uncheckedBoard,
    },
    journalTail: tailJournal(opts.journalFile),
    summaryText: summaryResult.stdout.trim(),
    pitfalls: pitfallsParsed.parsed ? pitfallsParsed.value : [],
    anomalies,
    recommendedActions: buildRecommendedActions({
      run,
      stopCondition,
      uncheckedBoard,
      directives,
      pendingTasks,
      anomalies,
    }),
  };

  await writeSnapshot(opts.workDir, snapshot);
  return snapshot;
}

function buildAnomalies({ run, trackList, state, pendingTasks, stopCondition }) {
  const anomalies = [];
  const tasksById = new Map((state.tasks ?? []).map((t) => [t.id, t]));

  for (const track of trackList) {
    const sprintTask = tasksById.get(track.taskId);
    if (track.state === "running" && sprintTask && ["Done", "Failed"].includes(sprintTask.state)) {
      anomalies.push({
        code: "STALE_TRACK_RUNNING",
        taskId: track.taskId,
        message: `track still running but sprint state is ${sprintTask.state}`,
      });
    }
    if (track.state === "settled" && sprintTask && sprintTask.state === "Backlog") {
      anomalies.push({
        code: "TRACK_SETTLED_SPRINT_BACKLOG",
        taskId: track.taskId,
        message: "track settled but sprint task still Backlog",
      });
    }
  }

  if (run && pendingTasks === 0 && stopCondition.stop && !["done", "error", "halted"].includes(run.phase)) {
    anomalies.push({
      code: "STALE_RUN_PHASE",
      phase: run.phase,
      message: `run phase ${run.phase} but sprint has no pending work`,
    });
  }

  return anomalies;
}

function buildRecommendedActions({ run, stopCondition, uncheckedBoard, directives, pendingTasks, anomalies }) {
  const actions = [];
  if (!run) {
    actions.push("orchestrate init");
    return actions;
  }
  if (anomalies?.some((a) => a.code === "STALE_RUN_PHASE")) {
    actions.push("orchestrate close");
  }
  if (uncheckedBoard.length > 0) {
    actions.push("process human-board instructions");
  }
  if (hasHaltDirective(directives)) {
    actions.push("clear halt directive or start new run");
  }
  if (stopCondition.stop) {
    actions.push("intervene replan or update human-board before continue");
  }
  switch (run.phase) {
    case "initialized":
    case "cycle-closed":
      actions.push("orchestrate plan");
      break;
    case "awaiting-plan-approval":
      actions.push("orchestrate approve-plan");
      break;
    case "plan-approved":
      actions.push("orchestrate dispatch");
      break;
    case "dispatch-queued":
      actions.push("orchestrate await-workers");
      break;
    case "awaiting-commit-approval":
      actions.push("orchestrate approve-commit --tasks <ids>");
      break;
    case "commit-approved":
      actions.push("orchestrate commit");
      break;
    case "committed":
      actions.push("orchestrate journal");
      break;
    default:
      if (pendingTasks > 0) {
        actions.push("orchestrate plan");
      }
  }
  return actions;
}

export async function runObserve(argv) {
  const opts = buildOrchestrationOpts(argv);
  const snapshot = await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, snapshot });
}
