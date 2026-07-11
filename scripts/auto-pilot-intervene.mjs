import path from "node:path";

import {
  buildOrchestrationOpts,
  emitResult,
  fail,
  sprintBoardExec,
} from "./lib/orchestration-cli.mjs";
import {
  appendDirectiveAtomic,
  assertActiveRun,
  findLiveTrackedWorker,
  isTerminalRunPhase,
  isTrackWorkerAlive,
  isTrackWorkerSignalSafe,
  orchestrationPaths,
  readActiveRuns,
  readRun,
  readTrackWorkerHeartbeat,
  readTracks,
  recoverRunTracksTransaction,
  updateRunAtomic,
  updateTrackAtomic,
} from "./lib/orchestration-state.mjs";
import { signalProcessTree, signalProcessTreeByPid } from "./lib/colony-bridge.mjs";
import { withPilotFileLock } from "./lib/pilot-state.mjs";
import { refreshSnapshot } from "./auto-pilot-observe.mjs";

async function appendDirective(opts, directive) {
  await appendDirectiveAtomic(opts.workDir, opts.runId, {
    ...directive,
    at: new Date().toISOString(),
    reason: opts.reason || directive.reason || "",
  });
}

function executorLockTarget(opts) {
  return `${orchestrationPaths(opts.workDir, opts.runId).run}.executor`;
}

function commitLockTarget(opts) {
  return path.resolve(opts.workDir, ".va-auto-pilot", "orchestration", "commit.lock");
}

async function withIdleExecutor(opts, work) {
  try {
    return await withPilotFileLock(executorLockTarget(opts), work, { timeoutMs: 500 });
  } catch (error) {
    if (error?.name === "TransactionConflictError") {
      fail(opts, "EXECUTOR_BUSY", "intervention requires the active await-workers executor to finish or be halted", {
        runId: opts.runId,
      }, 2);
    }
    throw error;
  }
}

async function withLegacyPromotionBoundary(opts, work) {
  if (opts.runId) return work();
  const lock = path.join(orchestrationPaths(opts.workDir).rootDir, "legacy-root-promotion");
  return withPilotFileLock(lock, work);
}

function assertMutableRun(current, expectedRunId, { allowError = false } = {}) {
  const immutable = isTerminalRunPhase(current?.phase)
    && !(allowError && current?.phase === "error");
  if (!current || current.runId !== expectedRunId || immutable) {
    const error = /** @type {Error & { code: string }} */ (new Error(
      `run is no longer mutable (phase=${current?.phase ?? "missing"})`
    ));
    error.code = "RUN_NOT_MUTABLE";
    throw error;
  }
  return current;
}

async function terminatePersistedWorker(opts, track) {
  if (!track?.pid || !isTrackWorkerAlive(opts.workDir, opts.runId, track)) {
    return false;
  }
  if (!isTrackWorkerSignalSafe(opts.workDir, opts.runId, track)) {
    return null; // live but identity is too stale to signal without PID/PGID reuse risk
  }
  const signalWorker = (signal) => {
    let signalled = signalProcessTree({ pid: track.pid }, signal);
    const childPid = Number(readTrackWorkerHeartbeat(opts.workDir, opts.runId, track)?.childPid);
    if (Number.isInteger(childPid) && childPid > 0) {
      signalled = signalProcessTreeByPid(childPid, signal) || signalled;
    }
    return signalled;
  };
  try {
    signalWorker("SIGTERM");
  } catch {
    return isTrackWorkerAlive(opts.workDir, opts.runId, track) ? null : false;
  }
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && isTrackWorkerAlive(opts.workDir, opts.runId, track)) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (isTrackWorkerAlive(opts.workDir, opts.runId, track)) {
    try { signalWorker("SIGKILL"); } catch { /* already exited */ }
    const forceDeadline = Date.now() + 1_000;
    while (Date.now() < forceDeadline && isTrackWorkerAlive(opts.workDir, opts.runId, track)) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (isTrackWorkerAlive(opts.workDir, opts.runId, track)) return null;
  }
  return true;
}

async function haltTrack(opts, taskId) {
  let worker = null;
  const requestedAt = new Date().toISOString();
  const update = await updateTrackAtomic(opts.workDir, opts.runId, taskId, (current) => {
    const isFreshHalt = ["queued", "starting", "running"].includes(current.state);
    const isDurableHaltRetry = current.state === "halted"
      && Boolean(current.cancelRequestedAt)
      && Number.isInteger(Number(current.pid))
      && Number(current.pid) > 0
      && Boolean(current.workerToken)
      && Boolean(current.dispatchId);
    if (!isFreshHalt && !isDurableHaltRetry) return null;
    worker = { ...current };
    if (isDurableHaltRetry) return current;
    return {
      ...current,
      state: "halted",
      cancelRequestedAt: requestedAt,
      resultStatus: "cancelled",
      resultAction: "halted",
      approvalFiles: [],
      error: opts.reason || "halted by intervention",
      lastHeartbeat: requestedAt,
    };
  });
  if (!update.updated) {
    return { updated: false, cancelled: false, track: update.track };
  }
  const cancelled = await terminatePersistedWorker(opts, worker);
  const final = await updateTrackAtomic(opts.workDir, opts.runId, taskId, (current) => {
    if (current.state !== "halted" || (worker?.dispatchId && current.dispatchId !== worker.dispatchId)) return null;
    // PID/token identity is cleared only after observed exit. This invariant
    // also covers signal delivery failures (EPERM, reused/stale identity), not
    // just the explicit ambiguous-identity return path.
    if (isTrackWorkerAlive(opts.workDir, opts.runId, current)) {
      return {
        ...current,
        error: cancelled === null
          ? "halt requested, but worker identity is stale; manual process-tree cleanup required"
          : "halt requested, but the worker process tree remains live; retry or clean it up manually",
      };
    }
    return {
      ...current,
      pid: null,
      workerToken: "",
      heartbeatFile: "",
      lastWorker: worker?.pid ? {
        pid: worker.pid,
        workerToken: worker.workerToken ?? "",
        dispatchId: worker.dispatchId ?? "",
        startedAt: worker.startedAt ?? null,
        endedAt: new Date().toISOString(),
      } : current.lastWorker ?? null,
    };
  });
  return { updated: true, cancelled, track: final.track ?? update.track };
}

export async function runIntervene(subcommand, argv) {
  const opts = buildOrchestrationOpts(argv);
  await recoverRunTracksTransaction(opts.workDir, opts.runId);
  if (!opts.parsed.options["run-id"] && readActiveRuns(opts.workDir).length > 1) {
    fail(opts, "RUN_ID_REQUIRED", "multiple active runs exist; intervention requires an explicit --run-id", {}, 2);
  }
  const run = readRun(opts.workDir, opts.runId);
  assertActiveRun(run, opts.runId || undefined);
  const canRecoverError = ["replan", "supersede-plan", "set-worker"].includes(subcommand);
  const canRetryHalt = subcommand === "halt-run" && run.phase === "halted";
  if (isTerminalRunPhase(run.phase)
      && !(run.phase === "error" && canRecoverError)
      && !canRetryHalt) {
    fail(opts, "RUN_TERMINAL", `cannot intervene on terminal run phase ${run.phase}`, {
      runId: run.runId,
      phase: run.phase,
    }, 2);
  }

  switch (subcommand) {
    case "halt-run": {
      return withLegacyPromotionBoundary(opts, async () => {
        await appendDirective(opts, { type: "halt-run", halt: true });
        if (run.phase !== "halted") {
          await updateRunAtomic(opts.workDir, opts.runId, (current) => ({
            ...assertMutableRun(current, run.runId),
            phase: "halted",
            approvedCommitTasks: [],
            commitApprovalManifest: null,
            commitApprovalManifestHash: null,
            approvedCommitManifest: null,
            approvedCommitManifestHash: null,
            updatedAt: new Date().toISOString(),
          }));
        }
        const tracks = readTracks(opts.workDir, opts.runId);
        const cancelledTasks = [];
        for (const track of tracks.tracks ?? []) {
          const result = await haltTrack(opts, track.taskId);
          if (result.cancelled) cancelledTasks.push(track.taskId);
        }
        // Wait for any already-started Git transaction after stopping workers.
        // Returning from halt-run is the barrier: no in-flight commit can update
        // HEAD after the user observes success.
        await withPilotFileLock(commitLockTarget(opts), async () => {});
        const remainingLive = findLiveTrackedWorker(opts.workDir, opts.runId);
        let claimsReleased = false;
        let claimReleaseError = "";
        if (!remainingLive) {
          const release = await sprintBoardExec(["release", "--run-id", run.runId, "--json"], opts);
          claimsReleased = release.exitCode === 0;
          claimReleaseError = claimsReleased ? "" : (release.stderr || release.stdout);
        }
        await refreshSnapshot(opts);
        return emitResult(opts, {
          ok: true,
          action: "halt-run",
          cancelledTasks,
          claimsReleased,
          claimReleaseDeferred: Boolean(remainingLive),
          ...(remainingLive ? { liveTaskId: remainingLive.taskId } : {}),
          ...(claimReleaseError ? { claimReleaseError } : {}),
          ...(claimReleaseError ? { retry: "intervene halt-run --run-id <runId>" } : {}),
        });
      });
    }
    case "halt-track": {
      if (!opts.parsed.options.task) {
        fail(opts, "TASK_REQUIRED", "halt-track requires --task AP-XXX", {}, 2);
      }
      return withLegacyPromotionBoundary(opts, async () => {
        const taskId = opts.parsed.options.task;
        assertMutableRun(readRun(opts.workDir, opts.runId), run.runId);
        await appendDirective(opts, { type: "halt-track", taskId });
        const halted = await haltTrack(opts, taskId);
        await refreshSnapshot(opts);
        return emitResult(opts, {
          ok: true,
          action: "halt-track",
          taskId,
          cancelled: halted.cancelled,
          state: halted.track?.state ?? "missing",
        });
      });
    }
    case "replan": {
      const taskId = opts.parsed.options.task;
      if (!taskId) {
        fail(opts, "TASK_REQUIRED", "replan requires --task AP-XXX", {}, 2);
      }
      return withIdleExecutor(opts, async () => {
        await appendDirective(opts, { type: "replan", taskId });
        const args = ["update", "--id", taskId, "--state", "Backlog"];
        if (opts.parsed.flags.has("reset-fail-count")) {
          args.push("--reset-fail-count");
        }
        await sprintBoardExec(args, opts);
        await updateRunAtomic(opts.workDir, opts.runId, (current) => ({
          ...assertMutableRun(current, run.runId, { allowError: true }),
          approvedPlanId: null,
          candidatePlan: null,
          phase: "awaiting-plan-approval",
          updatedAt: new Date().toISOString(),
        }));
        await refreshSnapshot(opts);
        return emitResult(opts, { ok: true, action: "replan", taskId });
      });
    }
    case "supersede-plan": {
      return withIdleExecutor(opts, async () => {
        await appendDirective(opts, { type: "supersede-plan" });
        await updateRunAtomic(opts.workDir, opts.runId, (current) => ({
          ...assertMutableRun(current, run.runId, { allowError: true }),
          approvedPlanId: null,
          candidatePlan: null,
          phase: "awaiting-plan-approval",
          updatedAt: new Date().toISOString(),
        }));
        await refreshSnapshot(opts);
        return emitResult(opts, { ok: true, action: "supersede-plan" });
      });
    }
    case "set-worker": {
      const taskId = opts.parsed.options.task;
      const worker = opts.worker || opts.parsed.options.worker;
      if (!taskId || !worker) {
        fail(opts, "ARGS_REQUIRED", "set-worker requires --task and --worker", {}, 2);
      }
      return withLegacyPromotionBoundary(opts, async () => {
        assertMutableRun(readRun(opts.workDir, opts.runId), run.runId, { allowError: true });
        await appendDirective(opts, { type: "set-worker", taskId, worker });
        await refreshSnapshot(opts);
        return emitResult(opts, { ok: true, action: "set-worker", taskId, worker });
      });
    }
    default:
      fail(opts, "UNKNOWN_SUBCOMMAND", `unknown intervene subcommand: ${subcommand}`, {}, 1);
  }
}
