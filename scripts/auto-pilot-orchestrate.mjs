import fs from "node:fs";
import path from "node:path";

import { readQualityGateConfig } from "./lib/sprint-utils.mjs";
import { readHumanBoardInstructions, resolveHumanBoardPath } from "./lib/human-board.mjs";
import { ColonyBridge } from "./lib/colony-bridge.mjs";
import {
  buildOrchestrationOpts,
  buildWorkerOverrideCommands,
  emitResult,
  fail,
  sprintBoardExec,
  tryParseJson,
} from "./lib/orchestration-cli.mjs";
import {
  assertActiveRun,
  buildCheckpoint,
  clearCheckpoint,
  createPlanId,
  createRunId,
  hasHaltDirective,
  isCheckpointStale,
  isProcessAlive,
  isTerminalRunPhase,
  readCheckpoint,
  readDirectives,
  readRun,
  readTracks,
  readWorkerOverrides,
  writeCheckpoint,
  writeRun,
  writeTracks,
} from "./lib/orchestration-state.mjs";
import {
  detectStopCondition,
  executeSingleTask,
  finalizeDoneTaskCommit,
  loadUnresolvedPitfalls,
  readSprintState,
} from "./auto-pilot-loop.mjs";
import { refreshSnapshot } from "./auto-pilot-observe.mjs";
import {
  clearPlanReview,
  computeCandidatePlanHash,
  readPlanReview,
  runPlanReviewCommand,
  validatePlanReviewForApprove,
  writePlanReview,
} from "./lib/plan-review.mjs";
import { appendEventLog, buildEvent, observabilityPaths } from "./lib/observability.mjs";

function planTaskIds(plan) {
  if (!plan) {
    return [];
  }
  return [plan.primaryTaskId, ...(Array.isArray(plan.parallelTracks) ? plan.parallelTracks : [])].filter(Boolean);
}

async function appendGovernanceEvent(opts, run, eventType, payload) {
  const checkpoint = readCheckpoint(opts.workDir);
  const logFile = checkpoint?.observability?.eventLogPath ?? observabilityPaths(opts.workDir).eventsLog;
  await appendEventLog(
    logFile,
    buildEvent({
      eventType,
      runId: run.runId,
      phase: run.phase,
      payload,
      provenance: { source: "auto-pilot-orchestrate" },
    })
  );
}

function assertRunnablePhase(run, opts) {
  assertActiveRun(run, opts.runId || undefined);
  if (isTerminalRunPhase(run.phase)) {
    fail(
      opts,
      "RUN_TERMINATED",
      `run phase is ${run.phase}; run orchestrate init before continuing`,
      { runId: run.runId, phase: run.phase },
      2
    );
  }
}

async function validatePreDispatch(run, opts) {
  const directives = readDirectives(opts.workDir);
  if (hasHaltDirective(directives)) {
    fail(opts, "HALTED", "directives.json contains halt-run", { directives }, 2);
  }

  if (!run.approvedPlanId) {
    fail(opts, "APPROVAL_REQUIRED", "approve-plan required before dispatch", {}, 2);
  }

  const checkpoint = readCheckpoint(opts.workDir);
  const stale = isCheckpointStale(checkpoint, { stateFile: opts.stateFile, workDir: opts.workDir });
  if (stale.stale) {
    await appendGovernanceEvent(opts, run, "checkpoint.stale", {
      checkpointId: checkpoint?.governance?.checkpointId ?? checkpoint?.approvedPlanId ?? null,
      approvedPlanId: checkpoint?.approvedPlanId ?? null,
      reason: stale.reason,
      stalePolicy: checkpoint?.governance?.stalePolicy ?? "block-dispatch-and-require-approve-plan",
      resumePhase: "awaiting-plan-approval",
    });
    fail(opts, "STALE_CONTEXT", stale.reason, { checkpoint }, 2);
  }

  const boardPath = resolveHumanBoardPath(opts.stateFile);
  const unchecked = readHumanBoardInstructions(boardPath);
  if (unchecked.length > 0) {
    fail(opts, "HUMAN_BOARD_BLOCKED", `human-board has ${unchecked.length} unchecked instruction(s)`, { unchecked }, 2);
  }

  if (run.locks?.executorPid && isProcessAlive(run.locks.executorPid)) {
    fail(opts, "RUN_LOCKED", `another executor pid is active: ${run.locks.executorPid}`, {}, 2);
  }
}

async function orchestrateClose(opts) {
  const run = readRun(opts.workDir);
  if (!run) {
    return emitResult(opts, { ok: true, action: "close", message: "no active run" });
  }
  run.phase = "done";
  run.locks = { executorPid: null };
  run.candidatePlan = null;
  run.approvedPlanId = null;
  run.approvedCommitTasks = [];
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);
  await writeTracks(opts.workDir, { runId: run.runId, tracks: [] });
  clearCheckpoint(opts.workDir);
  const reviewPath = path.join(opts.workDir, ".va-auto-pilot", "orchestration", "plan-review.json");
  if (fs.existsSync(reviewPath)) {
    fs.unlinkSync(reviewPath);
  }
  await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, action: "close", runId: run.runId });
}

async function initRun(opts) {
  const existing = readRun(opts.workDir);
  if (
    existing?.phase
    && !["done", "error", "halted"].includes(existing.phase)
    && existing.locks?.executorPid
    && isProcessAlive(existing.locks.executorPid)
  ) {
    fail(opts, "RUN_LOCKED", `active run ${existing.runId} still holds lock`, { runId: existing.runId }, 2);
  }

  const runId = opts.runId || createRunId();
  const run = {
    schemaVersion: 1,
    runId,
    manager: { surface: opts.managerSurface },
    mode: "orchestrated",
    phase: "initialized",
    cycle: 0,
    approvedPlanId: null,
    candidatePlan: null,
    approvedCommitTasks: [],
    locks: { executorPid: null },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  await writeRun(opts.workDir, run);
  await writeTracks(opts.workDir, { runId, tracks: [] });
  clearCheckpoint(opts.workDir);
  clearPlanReview(opts.workDir);
  return run;
}

async function orchestratePlan(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  const planResult = await sprintBoardExec(
    ["plan", "--json", "--max-parallel", String(opts.maxParallel)],
    opts
  );
  if (planResult.exitCode !== 0) {
    fail(opts, "PLAN_FAILED", planResult.stderr || planResult.stdout, {}, 1);
  }

  const parsed = tryParseJson(planResult.stdout.trim());
  if (!parsed.parsed || !parsed.value?.primaryTaskId) {
    fail(opts, "PLAN_EMPTY", "no parallel plan available", { stdout: planResult.stdout }, 1);
  }

  run.candidatePlan = parsed.value;
  run.approvedPlanId = null;
  run.approvedCommitTasks = [];
  run.phase = "awaiting-plan-approval";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);
  clearPlanReview(opts.workDir);

  const payload = { ok: true, phase: run.phase, runId: run.runId, candidatePlan: run.candidatePlan };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateReviewPlan(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  if (!run.candidatePlan?.primaryTaskId) {
    fail(opts, "NO_CANDIDATE_PLAN", "run orchestrate plan first", {}, 2);
  }

  const gateConfig = readQualityGateConfig();
  const reviewCommand = gateConfig.planReviewCommand ?? "";
  const review = await runPlanReviewCommand({
    workDir: opts.workDir,
    candidatePlan: run.candidatePlan,
    runId: run.runId,
    reviewCommand,
    dryRun: opts.dryRun,
  });

  if (!review.passed) {
    await writePlanReview(opts.workDir, review);
    fail(opts, "PLAN_REVIEW_CRITICAL", "plan review found CRITICAL findings", { review }, 1);
  }

  await writePlanReview(opts.workDir, review);
  run.phase = "plan-reviewed";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  await sprintBoardExec(
    [
      "journal",
      "--task",
      "plan-review",
      "--summary",
      `plan-review passed planHash=${review.planHash} critical=0 warning=${review.findings?.warning?.length ?? 0}`,
      "--signals",
      `plan-review:${review.planHash}`,
    ],
    opts
  );

  const payload = { ok: true, phase: run.phase, runId: run.runId, planHash: review.planHash, review };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateApprovePlan(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  if (!run.candidatePlan?.primaryTaskId) {
    fail(opts, "NO_CANDIDATE_PLAN", "run orchestrate plan first", {}, 2);
  }

  const waiveReason = opts.parsed?.options?.["waive-review-with-reason"] ?? "";
  if (!waiveReason && !opts.parsed?.flags?.has("waive-review")) {
    const validation = validatePlanReviewForApprove({
      review: readPlanReview(opts.workDir),
      candidatePlan: run.candidatePlan,
      runId: run.runId,
    });
    if (!validation.ok) {
      fail(opts, validation.code, validation.message, validation.context ?? {}, 2);
    }
  } else if (waiveReason) {
    await sprintBoardExec(
      ["journal", "--task", "plan-review", "--summary", `plan-review waived: ${waiveReason}`, "--signals", "plan-review:waived"],
      opts
    );
  }

  const planId = createPlanId();
  run.approvedPlanId = planId;
  run.phase = "plan-approved";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  const checkpoint = buildCheckpoint({
    stateFile: opts.stateFile,
    workDir: opts.workDir,
    approvedPlanId: planId,
    candidatePlan: run.candidatePlan,
  });
  await writeCheckpoint(opts.workDir, checkpoint);
  await appendGovernanceEvent(opts, run, "plan.approved", {
    planId,
    checkpointId: checkpoint.governance.checkpointId,
    candidatePlan: run.candidatePlan,
    approvalScope: checkpoint.governance.approvalScope,
    invalidatesOn: checkpoint.governance.invalidatesOn,
    stalePolicy: checkpoint.governance.stalePolicy,
  });

  const payload = { ok: true, phase: run.phase, runId: run.runId, approvedPlanId: planId, checkpoint };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateDispatch(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);
  await validatePreDispatch(run, opts);

  const taskIds = planTaskIds(run.candidatePlan);
  const workerOverrides = readWorkerOverrides(opts.workDir);
  const tracks = taskIds.map((taskId) => ({
    taskId,
    state: "queued",
    worker: workerOverrides.get(taskId) ?? null,
    pid: null,
    logFile: null,
    startedAt: null,
    lastHeartbeat: new Date().toISOString(),
  }));

  run.phase = "dispatch-queued";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);
  await writeTracks(opts.workDir, { runId: run.runId, tracks });
  await appendGovernanceEvent(opts, run, "dispatch.queued", {
    checkpointId: readCheckpoint(opts.workDir)?.governance?.checkpointId ?? run.approvedPlanId,
    queuedTasks: taskIds,
  });

  const payload = { ok: true, phase: run.phase, runId: run.runId, queuedTasks: taskIds };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function createBridge(opts) {
  const bridge = new ColonyBridge({
    workDir: opts.workDir,
    useColony: !opts.noColony,
  });
  if (!opts.dryRun) {
    await bridge.init();
  }
  return bridge;
}

async function orchestrateAwaitWorkers(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  const tracksDoc = readTracks(opts.workDir);
  const queued = (tracksDoc.tracks ?? []).filter((track) => track.state === "queued");
  if (queued.length === 0) {
    fail(opts, "NO_QUEUED_TRACKS", "no queued tracks; run orchestrate dispatch first", {}, 2);
  }

  if (opts.dryRun) {
    const previewAt = new Date().toISOString();
    for (const track of queued) {
      track.state = "preview";
      track.lastHeartbeat = previewAt;
      track.resultAction = "dry-run-skipped";
    }
    await writeTracks(opts.workDir, tracksDoc);
    run.phase = "dry-run-preview";
    run.updatedAt = previewAt;
    await writeRun(opts.workDir, run);
    const payload = {
      ok: true,
      phase: run.phase,
      runId: run.runId,
      previewTasks: queued.map((t) => t.taskId),
      message: "dry-run: no workers executed; re-dispatch without --dry-run to run",
    };
    await refreshSnapshot(opts);
    return emitResult(opts, payload);
  }

  const bridge = await createBridge(opts);
  const gateConfig = readQualityGateConfig();
  const pitfalls = await loadUnresolvedPitfalls(opts);
  const execOpts = {
    ...opts,
    deferCommit: true,
    workerOverrides: buildWorkerOverrideCommands(opts.workDir, readWorkerOverrides),
  };

  run.phase = "running";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  const now = new Date().toISOString();
  for (const track of queued) {
    if (track.state === "halted") {
      continue;
    }
    track.state = "running";
    track.startedAt = now;
    track.lastHeartbeat = now;
  }
  await writeTracks(opts.workDir, tracksDoc);

  const runTrack = async (track) => {
    if (track.state === "halted") {
      return { taskId: track.taskId, action: "halted", terminal: true, skipped: true };
    }
    const result = await executeSingleTask(track.taskId, bridge, pitfalls, gateConfig, execOpts);
    return { taskId: track.taskId, ...result };
  };

  const settled = await Promise.allSettled(queued.map((track) => runTrack(track)));
  const results = [];
  const settledAt = new Date().toISOString();

  for (let index = 0; index < settled.length; index += 1) {
    const outcome = settled[index];
    const track = queued[index];
    if (outcome.status === "rejected") {
      track.state = "settled";
      track.resultAction = "track-error";
      track.error = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      results.push({ taskId: track.taskId, action: "track-error", details: track.error });
    } else {
      const result = outcome.value;
      const sprintTask = (readSprintState(opts.stateFile).tasks ?? []).find((t) => t.id === track.taskId);
      const sprintTerminal = sprintTask && ["Done", "Failed"].includes(sprintTask.state);
      track.state = opts.dryRun || result.terminal || result.skipped || sprintTerminal ? "settled" : "running";
      track.lastHeartbeat = settledAt;
      track.resultAction = result.action;
      if (result.pid) {
        track.pid = result.pid;
      }
      if (sprintTask) {
        track.sprintState = sprintTask.state;
      }
      results.push(result);
    }
  }

  await writeTracks(opts.workDir, tracksDoc);

  if (!opts.dryRun && bridge.shutdown) {
    await bridge.shutdown();
  }

  run.phase = "awaiting-commit-approval";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  const payload = { ok: true, phase: run.phase, runId: run.runId, results, parallel: queued.length };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateApproveCommit(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  const tasks = String(opts.tasks || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  if (tasks.length === 0) {
    fail(opts, "TASKS_REQUIRED", "approve-commit requires --tasks id1,id2", {}, 2);
  }

  run.approvedCommitTasks = tasks;
  run.phase = "commit-approved";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  const payload = { ok: true, phase: run.phase, runId: run.runId, approvedCommitTasks: tasks };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateCommit(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  if (!opts.waiveApprovals && (!Array.isArray(run.approvedCommitTasks) || run.approvedCommitTasks.length === 0)) {
    fail(opts, "APPROVAL_REQUIRED", "approve-commit required before commit", {}, 2);
  }

  const approved = new Set(run.approvedCommitTasks ?? []);
  const state = readSprintState(opts.stateFile);
  const commits = [];

  for (const taskId of approved) {
    const task = (state.tasks ?? []).find((item) => item.id === taskId);
    if (!task) {
      continue;
    }
    if (task.state !== "Done") {
      fail(opts, "INVALID_STATE", `task ${taskId} must be Done before commit (current: ${task.state})`, {}, 2);
    }
    if (opts.dryRun) {
      commits.push({ taskId, dryRun: true });
      continue;
    }
    const result = await finalizeDoneTaskCommit(task, opts);
    commits.push({ taskId, ok: result.ok, details: result.details, hash: result.commitResult?.hash });
  }

  run.phase = "committed";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  const payload = { ok: true, phase: run.phase, runId: run.runId, commits };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateJournal(opts) {
  const run = readRun(opts.workDir);
  assertRunnablePhase(run, opts);

  const state = readSprintState(opts.stateFile);
  const stopCondition = detectStopCondition(state);
  const summary = `orchestrated cycle-boundary: run=${run.runId} phase=${run.phase} stop=${stopCondition.stop}`;

  await sprintBoardExec(
    ["journal", "--task", "cycle-boundary", "--summary", summary, "--signals", `orchestrated:${run.runId}`],
    opts
  );

  run.cycle = Number(run.cycle ?? 0) + 1;
  run.phase = "cycle-closed";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run);

  const payload = { ok: true, phase: run.phase, runId: run.runId, cycle: run.cycle, stopCondition };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateRunUnattended(opts) {
  if (!opts.waiveApprovals) {
    fail(
      opts,
      "WAIVE_REQUIRED",
      "run-unattended requires --waive-approvals (CI only). Interactive sessions must approve-plan and approve-commit explicitly.",
      {},
      2
    );
  }

  await initRun(opts);
  await orchestratePlan(opts);
  const run = readRun(opts.workDir);
  run.approvedPlanId = createPlanId();
  await writeRun(opts.workDir, run);
  await writeCheckpoint(
    opts.workDir,
    buildCheckpoint({
      stateFile: opts.stateFile,
      workDir: opts.workDir,
      approvedPlanId: run.approvedPlanId,
      candidatePlan: run.candidatePlan,
    })
  );

  const maxCycles = Number.parseInt(opts.parsed?.options?.["max-cycles"] ?? "50", 10);
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    await orchestrateDispatch({ ...opts, json: false });
    await orchestrateAwaitWorkers({ ...opts, json: false });
    const state = readSprintState(opts.stateFile);
    const doneTasks = (state.tasks ?? []).filter((task) => task.state === "Done").map((task) => task.id);
    if (doneTasks.length > 0) {
      await orchestrateApproveCommit({ ...opts, tasks: doneTasks.join(","), json: false });
      await orchestrateCommit({ ...opts, waiveApprovals: true, json: false });
    }
    await orchestrateJournal({ ...opts, json: false });
    const stop = detectStopCondition(state);
    if (stop.stop) {
      break;
    }
  }

  const finalRun = readRun(opts.workDir);
  finalRun.phase = "done";
  await writeRun(opts.workDir, finalRun);
  return emitResult(opts, { ok: true, phase: "done", runId: finalRun.runId });
}

export async function runOrchestrateCommand(subcommand, argv) {
  const opts = buildOrchestrationOpts(argv);
  if (opts.runId) {
    const run = readRun(opts.workDir);
    if (run && !opts.parsed.options["run-id"]) {
      opts.runId = run.runId;
    }
  }

  switch (subcommand) {
    case "init": {
      const run = await initRun(opts);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: true, run });
    }
    case "plan":
      return orchestratePlan(opts);
    case "review-plan":
      return orchestrateReviewPlan(opts);
    case "approve-plan":
      return orchestrateApprovePlan(opts);
    case "dispatch":
      return orchestrateDispatch(opts);
    case "await-workers":
      return orchestrateAwaitWorkers(opts);
    case "approve-commit":
      return orchestrateApproveCommit(opts);
    case "commit":
      return orchestrateCommit(opts);
    case "journal":
      return orchestrateJournal(opts);
    case "close":
      return orchestrateClose(opts);
    case "run-unattended":
      return orchestrateRunUnattended(opts);
    default:
      fail(opts, "UNKNOWN_SUBCOMMAND", `unknown orchestrate subcommand: ${subcommand}`, {}, 1);
  }
}
