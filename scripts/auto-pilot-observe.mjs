import fs from "node:fs";
import path from "node:path";

import { buildGateTrustSummary } from "./lib/gate-trust.mjs";
import { readHumanBoardInstructions, resolveHumanBoardPath } from "./lib/human-board.mjs";
import { buildOrchestrationOpts, emitResult, sprintBoardExec, tryParseJson } from "./lib/orchestration-cli.mjs";
import { readQualityGateConfig } from "./lib/sprint-utils.mjs";
import {
  hasHaltDirective,
  isTerminalRunPhase,
  readCheckpoint,
  readDirectives,
  readRun,
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

function extractJournalSummaries(entries) {
  return entries.map((entry) => {
    const match = entry.match(/^- Summary:\s*(.+)$/m);
    return match ? match[1].trim() : entry.split(/\r?\n/)[0].replace(/^##\s*/, "").trim();
  }).filter(Boolean);
}

function uniqueStrings(items) {
  return Array.from(new Set(items.filter(Boolean)));
}

function matchesAny(text, patterns) {
  return patterns.some((pattern) => pattern.test(text));
}

function buildEvidenceSummary(entries) {
  const recent = extractJournalSummaries(entries).slice(-5);
  const completions = recent.filter((summary) => matchesAny(summary, [
    /\bpass(?:ed)?\b/i,
    /\bcomplete(?:d)?\b/i,
    /\bdone\b/i,
    /\bcommitted\b/i,
    /\blanded\b/i,
  ])).slice(-3);
  const failures = recent.filter((summary) => matchesAny(summary, [
    /\bfail(?:ed|ure)?\b/i,
    /\bblocked\b/i,
    /\bcritical\b/i,
    /\bp0\b/i,
    /\bstop condition\b/i,
    /\bnon-zero\b/i,
    /\bexitCode=\d+/i,
  ])).slice(-3);
  const gates = recent.filter((summary) => matchesAny(summary, [
    /\bgate\b/i,
    /\bcheck:all\b/i,
    /\blint\b/i,
    /\btype-?check\b/i,
    /\btest(?:s|ing)?\b/i,
    /\bvalidate\b/i,
    /\breview\b/i,
    /\bpytest\b/i,
    /\bmypy\b/i,
    /\bruff\b/i,
  ])).slice(-3);
  const decisions = recent.filter((summary) => matchesAny(summary, [
    /\bdecision\b/i,
    /\bapproved\b/i,
    /\baccepted\b/i,
    /\bwaive(?:d|r)?\b/i,
    /\boverride\b/i,
    /\bhuman-intent\b/i,
    /\bobjective\b/i,
    /\brisk\b/i,
    /\bacceptance\b/i,
  ])).slice(-3);

  return {
    recent,
    completions,
    failures,
    gates,
    decisions,
    counts: {
      recent: recent.length,
      completions: completions.length,
      failures: failures.length,
      gates: gates.length,
      decisions: decisions.length,
    },
  };
}

function riskLevelFromSnapshot(snapshot) {
  if (snapshot.anomalies?.some((item) => item.code?.includes("STALE") || item.severity === "critical")) {
    return "high";
  }
  if (snapshot.gateTrust?.status === "missing-required-gates") {
    return "high";
  }
  if (snapshot.directives?.halt || snapshot.sprint?.stopCondition?.stop) {
    return "high";
  }
  if (snapshot.gateTrust?.status === "needs-agent-attention" || snapshot.gateTrust?.status === "not-configured") {
    return "medium";
  }
  const phase = snapshot.run?.phase ?? "idle";
  if (["awaiting-plan-approval", "plan-reviewed", "awaiting-commit-approval"].includes(phase)) {
    return "medium";
  }
  if ((snapshot.sprint?.pendingTasks ?? 0) > 0 || (snapshot.humanBoard?.uncheckedCount ?? 0) > 0) {
    return "medium";
  }
  return "low";
}

export function buildCockpit(snapshot) {
  const pendingTasks = snapshot.sprint?.pendingTasks ?? 0;
  const unchecked = snapshot.humanBoard?.unchecked ?? [];
  const phase = snapshot.run?.phase ?? "idle";
  const evidenceSummary = buildEvidenceSummary(snapshot.journalTail ?? []);
  const evidenceSignals = uniqueStrings([
    ...((snapshot.gateTrust?.weakSignals ?? []).map((signal) => `gate trust: ${signal}`)),
    ...((snapshot.gateTrust?.missingRequired ?? []).map((gate) => `gate trust: missing ${gate}`)),
    ...evidenceSummary.failures,
    ...evidenceSummary.gates,
    ...evidenceSummary.completions,
    ...evidenceSummary.decisions,
    ...evidenceSummary.recent,
  ]).slice(0, 5);
  const pendingApproval =
    phase === "awaiting-plan-approval" ? "plan-review-and-approval"
      : phase === "plan-reviewed" ? "plan-approval"
        : phase === "awaiting-commit-approval" ? "commit-approval"
          : null;
  const riskLevel = riskLevelFromSnapshot(snapshot);

  return {
    schemaVersion: 1,
    updatedAt: snapshot.updatedAt,
    audience: "session-manager-agent",
    principle: "agent manages mechanics; human judges goal, risk, and evidence",
    hiddenMechanics: [
      "sprint-state",
      "run-journal",
      "pitfalls",
      "qualityGate",
      "orchestrate phases",
    ],
    humanJudgment: {
      goal: {
        status: unchecked.length > 0 ? "needs-human-intent-processing" : pendingTasks > 0 ? "active" : "needs-objective",
        question: unchecked.length > 0
          ? "Are these new or changed objectives, constraints, or overrides still correct?"
          : pendingTasks > 0
            ? "Is the current objective still correct?"
            : "What goal should the agent pursue next?",
        signals: unchecked.slice(0, 5).map((item) => item.text),
      },
      risk: {
        level: riskLevel,
        question: riskLevel === "high"
          ? "Risk is above the normal operating range; should the agent pause, replan, or continue with explicit approval?"
          : "Is the current risk level acceptable?",
        signals: [
          ...((snapshot.anomalies ?? []).map((item) => `${item.code}: ${item.message}`)),
          ...((snapshot.gateTrust?.weakSignals ?? []).map((signal) => `gate trust: ${signal}`)),
          ...((snapshot.gateTrust?.missingRequired ?? []).map((gate) => `gate trust: missing ${gate}`)),
          ...(snapshot.directives?.halt ? ["halt directive active"] : []),
          ...(snapshot.sprint?.stopCondition?.stop ? [`stop condition: ${snapshot.sprint.stopCondition.reason}`] : []),
        ].filter(Boolean),
      },
      evidence: {
        status: phase === "awaiting-commit-approval" ? "needs-human-trust-check" : pendingTasks === 0 ? "idle" : "collecting",
        question: phase === "awaiting-commit-approval"
          ? "Is the completion evidence trustworthy enough to approve commit?"
          : "Is more evidence needed before accepting the current direction?",
        summary: {
          ...evidenceSummary,
          gateTrust: snapshot.gateTrust ?? buildGateTrustSummary({}),
        },
        signals: evidenceSignals,
      },
    },
    pendingApproval,
    recommendedActions: snapshot.recommendedActions ?? [],
    nextCommands: snapshot.nextCommands ?? [],
  };
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
  const qualityGate = readQualityGateConfig(path.join(opts.workDir, ".va-auto-pilot", "config.yaml"));
  const gateTrust = buildGateTrustSummary(qualityGate);

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
    gateTrust,
    anomalies,
    recommendedActions: buildRecommendedActions({
      run,
      stopCondition,
      uncheckedBoard,
      directives,
      pendingTasks,
      anomalies,
      gateTrust,
    }),
    nextCommands: buildNextCommands({
      run,
      stopCondition,
      uncheckedBoard,
      directives,
      pendingTasks,
      anomalies,
    }),
  };

  snapshot.cockpit = buildCockpit(snapshot);

  await writeSnapshot(opts.workDir, snapshot);
  return snapshot;
}

function buildAnomalies({ run, trackList, state, pendingTasks, stopCondition }) {
  const anomalies = [];
  const tasksById = new Map((state.tasks ?? []).map((t) => [t.id, t]));

  for (const track of trackList) {
    if (track.state === "preview") {
      continue;
    }
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

function buildRecommendedActions({ run, stopCondition, uncheckedBoard, directives, pendingTasks, anomalies, gateTrust }) {
  const actions = [];
  if (gateTrust?.status === "missing-required-gates") {
    actions.push("configure required evidence gates");
  } else if (gateTrust?.status === "needs-agent-attention" || gateTrust?.status === "not-configured") {
    actions.push("strengthen evidence gates before relying on acceptance");
  }
  if (!run) {
    actions.push("start agent run");
    if (uncheckedBoard.length > 0) {
      actions.push("process human intent from cockpit");
    } else if (pendingTasks === 0) {
      actions.push("capture next goal from human");
    }
    return actions;
  }
  if (isTerminalRunPhase(run.phase)) {
    actions.push("start next agent run");
    if (pendingTasks > 0) {
      actions.push("plan next agent cycle");
    } else if (uncheckedBoard.length > 0) {
      actions.push("process human intent from cockpit");
    } else {
      actions.push("capture next goal from human");
    }
    return actions;
  }
  if (anomalies?.some((a) => a.code === "STALE_RUN_PHASE")) {
    actions.push("close stale run state");
  }
  if (uncheckedBoard.length > 0) {
    actions.push("process human intent from cockpit");
  }
  if (hasHaltDirective(directives)) {
    actions.push("clear halt directive or start new run");
  }
  if (stopCondition.stop) {
    actions.push("intervene replan or capture updated intent before continue");
  }
  if (pendingTasks === 0 && uncheckedBoard.length === 0 && ["initialized", "cycle-closed"].includes(run.phase)) {
    actions.push("capture next goal from human");
  }
  switch (run.phase) {
    case "initialized":
    case "cycle-closed":
      actions.push("plan next agent cycle");
      break;
    case "awaiting-plan-approval":
      actions.push("review plan before approval");
      actions.push("approve plan if risk is acceptable");
      break;
    case "plan-reviewed":
      actions.push("approve reviewed plan if risk is acceptable");
      break;
    case "plan-approved":
      actions.push("dispatch approved agent work");
      break;
    case "dispatch-queued":
      actions.push("wait for agent work to settle");
      break;
    case "dry-run-preview":
      actions.push("run previewed agent work or close the preview");
      break;
    case "awaiting-commit-approval":
      actions.push("approve completion evidence if trustworthy");
      break;
    case "commit-approved":
      actions.push("commit approved results");
      break;
    case "committed":
      actions.push("summarize committed cycle");
      break;
    default:
      break;
  }
  return actions;
}

function command(label, args, reason) {
  return {
    label,
    argv: ["node", "scripts/auto-pilot.mjs", ...args],
    reason,
  };
}

function buildNextCommands({ run, stopCondition, uncheckedBoard, directives, pendingTasks, anomalies }) {
  const commands = [];

  if (anomalies?.some((a) => a.code === "STALE_RUN_PHASE")) {
    commands.push(command("Close stale run", ["orchestrate", "close"], "Run phase is stale after sprint work settled."));
  }
  if (uncheckedBoard.length > 0) {
    commands.push(command("Review cockpit", ["cockpit", "--json"], "Unchecked human intent may affect dispatch decisions."));
  }
  if (hasHaltDirective(directives)) {
    commands.push(command("Observe halt directive", ["observe", "--json"], "A halt directive is active; clear or supersede it before continuing."));
  }
  if (stopCondition.stop) {
    commands.push(command("Replan after stop", ["orchestrate", "plan"], "Sprint stop condition is active and needs a fresh plan or human intervention."));
  }

  if (!run || isTerminalRunPhase(run.phase)) {
    commands.push(command("Start run", ["orchestrate", "init"], run ? "Current run is terminal." : "No active orchestration run exists."));
    if (pendingTasks > 0) {
      commands.push(command("Plan next cycle", ["orchestrate", "plan"], "Pending sprint tasks are available."));
    } else if (uncheckedBoard.length === 0) {
      commands.push(command(
        "Capture goal",
        ["goal", "--text", "<objective>"],
        "No pending sprint tasks are available; ask the human for the next goal."
      ));
    }
    return commands;
  }

  if (pendingTasks === 0 && uncheckedBoard.length === 0 && ["initialized", "cycle-closed"].includes(run.phase)) {
    commands.push(command(
      "Capture goal",
      ["goal", "--text", "<objective>"],
      "The run is ready, but backlog is empty; ask the human for the next goal."
    ));
  }

  switch (run.phase) {
    case "initialized":
    case "cycle-closed":
      commands.push(command("Plan next cycle", ["orchestrate", "plan"], "Run is ready for planning."));
      break;
    case "awaiting-plan-approval":
      commands.push(command("Review plan", ["orchestrate", "review-plan"], "Plan approval requires a review first."));
      commands.push(command("Approve plan", ["orchestrate", "approve-plan"], "Use after plan review passes."));
      break;
    case "plan-reviewed":
      commands.push(command("Approve plan", ["orchestrate", "approve-plan"], "Plan review is complete."));
      break;
    case "plan-approved":
      commands.push(command("Dispatch workers", ["orchestrate", "dispatch"], "Approved plan is ready to dispatch."));
      break;
    case "dispatch-queued":
      commands.push(command("Await workers", ["orchestrate", "await-workers"], "Workers have been queued."));
      break;
    case "dry-run-preview":
      commands.push(command("Run workers", ["orchestrate", "await-workers"], "Dry-run preview is ready for real execution."));
      commands.push(command("Close preview", ["orchestrate", "close"], "Close the preview without executing workers."));
      break;
    case "awaiting-commit-approval":
      commands.push(command("Approve commit", ["orchestrate", "approve-commit", "--tasks", "<ids>"], "Completed worker results need commit approval."));
      break;
    case "commit-approved":
      commands.push(command("Commit results", ["orchestrate", "commit"], "Commit approval has been granted."));
      break;
    case "committed":
      commands.push(command("Write journal", ["orchestrate", "journal"], "Committed work needs journal closure."));
      break;
    default:
      break;
  }

  return commands;
}

export async function runObserve(argv) {
  const opts = buildOrchestrationOpts(argv);
  const snapshot = await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, snapshot });
}

export async function runCockpit(argv) {
  const opts = buildOrchestrationOpts(argv);
  const snapshot = await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, cockpit: snapshot.cockpit });
}
