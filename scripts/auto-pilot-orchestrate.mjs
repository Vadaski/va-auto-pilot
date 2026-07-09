import fs from "node:fs";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { readQualityGateConfig } from "./lib/sprint-utils.mjs";
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
  buildRecoveryPlan,
  buildCheckpoint,
  clearActiveRun,
  clearCheckpoint,
  computeGitHead,
  createPlanId,
  createRunId,
  hasHaltDirective,
  isCheckpointStale,
  isTerminalRunPhase,
  orchestrationPaths,
  readActiveRuns,
  isProcessAlive,
  readCheckpoint,
  readDirectives,
  readRun,
  readTracks,
  readWorkerOverrides,
  resolveActiveRunId,
  writeActiveRun,
  writeCheckpoint,
  writeRun,
  writeTracks,
} from "./lib/orchestration-state.mjs";
import { planFromGoal } from "./lib/goal-backlog.mjs";
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
  readPlanReview,
  runPlanReviewCommand,
  validatePlanReviewForApprove,
  writePlanReview,
} from "./lib/plan-review.mjs";
import { appendEventLog, buildEvent, observabilityPaths } from "./lib/observability.mjs";
import {
  collectApprovalChangeContext,
  evaluateApprovalPolicy,
  readApprovalPolicyConfig,
} from "./lib/approval-policy.mjs";
import {
  commitTrackWorktreeResult,
  prepareTrackWorktree,
  readWorktreeIsolationConfig,
  resolveTrackWorktreePath,
  squashMergeTrackCommit,
} from "./lib/worktree-isolation.mjs";
import { DEFAULT_TASK_CLAIM_TTL_MS } from "./lib/constants.mjs";
import { writeWorkspace } from "./lib/workspace.mjs";
import { planTaskIds } from "./lib/plan-helpers.mjs";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./lib/pilot-state.mjs";

const execFileAsync = promisify(execFile);
const MAX_SQUASH_MERGE_ATTEMPTS = 3;

function tasksForPlan(state, plan) {
  const taskIds = new Set(planTaskIds(plan));
  return (Array.isArray(state?.tasks) ? state.tasks : [])
    .filter((task) => taskIds.has(task.id));
}

function buildTrackOpts(base, overrides = {}) {
  const child = { ...base, ...overrides };
  for (const key of ["sprintBoardLock", "stateMutationLock"]) {
    Object.defineProperty(child, key, {
      get() {
        return base[key];
      },
      set(value) {
        base[key] = value;
      },
      enumerable: true,
      configurable: true,
    });
  }
  return child;
}

/**
 * Decide whether dispatch should build per-track git worktrees.
 *
 * Isolated execution trees force worktree isolation on — BUT only when the project
 * is actually a git repo. Forcing `git worktree add` in a non-git directory (local
 * sandboxes, scratch projects) hard-fails inside prepareTrackWorktree, which would
 * regress zero-config orchestration. So a non-git project gracefully degrades to a
 * shared working tree regardless of executionTree.
 *
 * @param {object} [worktreeConfig]  raw config from readWorktreeIsolationConfig
 * @param {{ executionTree?: string }} [workspace]
 * @param {boolean} [isGitRepo]  whether the workDir is inside a git work tree
 */
export function resolveDispatchWorktreeConfig(worktreeConfig, workspace, isGitRepo = true) {
  const wantIsolated = workspace?.executionTree === "isolated";
  return {
    ...(worktreeConfig ?? {}),
    enabled: wantIsolated
      ? Boolean(isGitRepo)
      : worktreeConfig?.enabled === true,
  };
}

export function resolveCommitLockPath(opts) {
  const workspaceDir = opts.workspace?.dir
    ? path.resolve(opts.workspace.dir)
    : path.resolve(opts.workDir, ".va-auto-pilot", "orchestration");
  return path.join(workspaceDir, "commit.lock");
}

export async function withSerializedCommit(opts, work, lockOptions = {}) {
  const commitLockPath = resolveCommitLockPath(opts);
  fs.mkdirSync(path.dirname(commitLockPath), { recursive: true });
  return withPilotFileLock(commitLockPath, work, lockOptions);
}

function hasPendingTasks(state) {
  return (state.tasks ?? []).some((task) => task.state !== "Done");
}

async function git(args, opts, cwd = opts.workDir) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function formatErrorMessage(error) {
  return String(error?.stderr ?? error?.stdout ?? error?.message ?? error ?? "unknown error").trim();
}

/**
 * Synchronously detect whether workDir is inside a git work tree. Used to decide
 * whether isolated-execution-tree dispatch can build per-track worktrees — non-git
 * directories gracefully degrade to a shared working tree instead of hard-failing
 * inside `git worktree add`.
 */
function detectGitRepo(workDir) {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.trim() === "true";
  } catch {
    return false;
  }
}

async function resetSquashMergeState(opts) {
  await git(["reset", "--merge"], opts);
}

async function squashMergeTrackCommitWithRetry({ opts, track, taskId, observedHead = "", maxAttempts = MAX_SQUASH_MERGE_ATTEMPTS }) {
  let lastError = null;
  let lastHead = computeGitHead(opts.workDir);
  let headChangedWhileWaiting = Boolean(observedHead && lastHead && observedHead !== lastHead);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    lastHead = computeGitHead(opts.workDir);
    headChangedWhileWaiting = Boolean(observedHead && lastHead && observedHead !== lastHead);
    try {
      const merge = await squashMergeTrackCommit({ workDir: opts.workDir, track });
      return {
        ...merge,
        attempts: attempt,
        headBeforeAttempt: lastHead,
        headChangedWhileWaiting,
      };
    } catch (error) {
      lastError = error;
      try {
        await resetSquashMergeState(opts);
      } catch (resetError) {
        throw new Error(
          `failed to clean up squash merge for ${taskId}: ${formatErrorMessage(error)} (reset failed: ${formatErrorMessage(resetError)})`,
          { cause: resetError }
        );
      }
    }
  }

  throw new Error(
    `failed to squash merge ${taskId} after ${maxAttempts} attempt(s): ${formatErrorMessage(lastError)}`
    + (headChangedWhileWaiting ? ` (git HEAD changed while waiting for commit lock; latest HEAD ${lastHead})` : ""),
    { cause: lastError instanceof Error ? lastError : undefined }
  );
}

function toRepoPath(filePath, repoRoot) {
  const relativePath = path.relative(repoRoot, path.resolve(filePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }
  return relativePath.replace(/\\/g, "/");
}

async function commitControlFiles(files, header, opts) {
  if (opts.dryRun) {
    return { committed: false, skipped: true, reason: "dry-run", files: [], hash: "", header };
  }
  if (opts.noCommit) {
    return { committed: false, skipped: true, reason: "disabled by --no-commit", files: [], hash: "", header };
  }

  let repoRoot = opts.workDir;
  try {
    await git(["rev-parse", "--is-inside-work-tree"], opts);
    const root = await git(["rev-parse", "--show-toplevel"], opts);
    repoRoot = root.stdout.trim() || opts.workDir;
  } catch {
    return { committed: false, skipped: true, reason: "not a git repository", files: [], hash: "", header };
  }

  const repoFiles = [...new Set(files.map((file) => toRepoPath(file, repoRoot)).filter(Boolean))].sort();
  if (repoFiles.length === 0) {
    return { committed: false, skipped: true, reason: "no repo-local files", files: [], hash: "", header };
  }

  await git(["add", "--all", "--force", "--", ...repoFiles], opts, repoRoot);
  const staged = await git(["diff", "--cached", "--name-only", "--relative", "--", ...repoFiles], opts, repoRoot);
  const stagedFiles = staged.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (stagedFiles.length === 0) {
    return { committed: false, skipped: true, reason: "no staged changes", files: [], hash: "", header };
  }

  await git([
    "commit",
    "-m", header,
    "-m", "Co-Authored-By: Claude <noreply@anthropic.com>",
    "--only",
    "--",
    ...stagedFiles,
  ], opts, repoRoot);
  const head = await git(["rev-parse", "HEAD"], opts, repoRoot);
  return {
    committed: true,
    skipped: false,
    reason: "",
    files: stagedFiles,
    hash: head.stdout.trim(),
    header,
  };
}

async function appendGovernanceEvent(opts, run, eventType, payload) {
  const checkpoint = readCheckpoint(opts.workDir, opts.runId);
  const logFile = checkpoint?.observability?.eventLogPath ?? observabilityPaths(opts.workDir).eventsLog;
  await appendEventLog(
    logFile,
    buildEvent({
      eventType,
      runId: run.runId,
      taskId: null,
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
  const directives = readDirectives(opts.workDir, opts.runId);
  if (hasHaltDirective(directives)) {
    fail(opts, "HALTED", "directives.json contains halt-run", { directives }, 2);
  }

  if (!run.approvedPlanId) {
    fail(opts, "APPROVAL_REQUIRED", "approve-plan required before dispatch", {}, 2);
  }

  const checkpoint = readCheckpoint(opts.workDir, opts.runId);
  const stale = isCheckpointStale(checkpoint, { stateFile: opts.stateFile, workDir: opts.workDir, workspace: opts.workspace });
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

}

async function orchestrateClose(opts) {
  const run = readRun(opts.workDir, opts.runId);
  if (!run) {
    return emitResult(opts, { ok: true, action: "close", message: "no active run" });
  }
  const releaseResult = await sprintBoardExec(
    ["release", "--run-id", run.runId, "--json"],
    opts
  );
  if (releaseResult.exitCode !== 0) {
    fail(opts, "RELEASE_FAILED", releaseResult.stderr || releaseResult.stdout, {}, 1);
  }
  run.phase = "done";
  run.locks = { executorPid: null };
  run.candidatePlan = null;
  run.candidateBacklog = null;
  run.approvedPlanId = null;
  run.approvedCommitTasks = [];
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);
  await writeTracks(opts.workDir, { runId: run.runId, tracks: [] }, opts.runId);
  clearCheckpoint(opts.workDir, opts.runId);
  clearPlanReview(opts.workDir, opts.runId);
  await clearActiveRun(opts.workDir, opts.runId ? run.runId : "");
  await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, action: "close", runId: run.runId });
}

async function applyRecoveryPlan(plan, run, tracksDoc, opts) {
  if (!opts.parsed?.flags?.has("apply") || plan.mutations.length === 0) {
    return { applied: false, mutations: [] };
  }

  const applied = [];
  let runChanged = false;
  let tracksChanged = false;
  const now = new Date().toISOString();

  for (const mutation of plan.mutations) {
    if (mutation.type === "clear-executor-lock") {
      run.locks = { ...(run.locks ?? {}), executorPid: null };
      runChanged = true;
      applied.push(mutation);
    }

    if (mutation.type === "return-to-plan-approval") {
      run.approvedPlanId = null;
      run.phase = "awaiting-plan-approval";
      clearCheckpoint(opts.workDir, opts.runId);
      runChanged = true;
      applied.push(mutation);
    }

    if (mutation.type === "settle-track") {
      for (const track of tracksDoc.tracks ?? []) {
        if (track.taskId !== mutation.taskId) continue;
        track.state = "settled";
        track.resultAction = mutation.resultAction;
        track.error = mutation.reason;
        track.lastHeartbeat = now;
        tracksChanged = true;
      }
      applied.push(mutation);
    }

    if (mutation.type === "close-run") {
      run.phase = "done";
      run.locks = { ...(run.locks ?? {}), executorPid: null };
      run.approvedPlanId = null;
      run.approvedCommitTasks = [];
      clearCheckpoint(opts.workDir, opts.runId);
      runChanged = true;
      applied.push(mutation);
    }
  }

  if (runChanged) {
    run.updatedAt = now;
    await writeRun(opts.workDir, run, opts.runId);
  }
  if (tracksChanged) {
    await writeTracks(opts.workDir, tracksDoc, opts.runId);
  }
  if (applied.length > 0) {
    await sprintBoardExec(
      ["journal", "--task", "recovery", "--summary", `orchestrate recover applied ${applied.length} mutation(s)`, "--signals", "orchestrate:recovery"],
      opts
    );
  }
  return { applied: true, mutations: applied };
}

async function orchestrateRecover(opts) {
  const run = readRun(opts.workDir, opts.runId);
  const tracksDoc = readTracks(opts.workDir, opts.runId);
  const state = readSprintState(opts.stateFile);
  const checkpoint = readCheckpoint(opts.workDir, opts.runId);
  const checkpointStatus = checkpoint
    ? isCheckpointStale(checkpoint, { stateFile: opts.stateFile, workDir: opts.workDir, workspace: opts.workspace })
    : { stale: false, reason: "" };
  const directives = readDirectives(opts.workDir, opts.runId);
  const plan = buildRecoveryPlan({
    run,
    tracksDoc,
    state,
    checkpointStatus,
    halt: hasHaltDirective(directives),
    trackTimeoutMs: opts.trackTimeout,
  });
  const application = run ? await applyRecoveryPlan(plan, run, tracksDoc, opts) : { applied: false, mutations: [] };
  // Lazily release claims held by dead runs (lease expired + no active track). This is
  // the "steal expired claim" half of the lazy-takeover policy: recover is the only
  // place that actively scans for dead runs. Only mutates under --apply.
  const claimRelease = opts.parsed?.flags?.has("apply")
    ? await recoverDeadRunClaims(opts)
    : { released: [], skipped: true };
  const snapshot = await refreshSnapshot(opts);
  const recovered = (application.applied && application.mutations.length > 0) || claimRelease.released.length > 0;
  const ok = plan.ok || recovered;
  return emitResult(opts, {
    ok,
    action: "recover",
    applied: application.applied,
    plan,
    releasedClaims: claimRelease.released,
    snapshot,
  }, ok ? 0 : 1);
}

/**
 * Scan all active runs and release claims held by runs whose lease has expired
 * (heartbeat older than the claim TTL) AND that have no live track. A run with a
 * running track whose own heartbeat is within the track timeout is NOT considered
 * dead — the worker may still be executing even if the manager has been quiet.
 *
 * @returns {Promise<{ released: Array<{ runId: string, taskIds: string[] }>, skipped: boolean }>}
 */
async function recoverDeadRunClaims(opts) {
  const activeRuns = readActiveRuns(opts.workDir);
  if (activeRuns.length === 0) {
    return { released: [], skipped: true };
  }
  const now = Date.now();
  const ttlMs = DEFAULT_TASK_CLAIM_TTL_MS;
  const released = [];

  for (const entry of activeRuns) {
    const heartbeatMs = entry.heartbeatAt ? Date.parse(entry.heartbeatAt) : NaN;
    if (Number.isFinite(heartbeatMs) && (now - heartbeatMs) < ttlMs) {
      continue; // lease still live
    }
    // Lease expired — but confirm no live track before releasing. A track whose pid is
    // alive, or whose heartbeat is within track timeout, means work is still running.
    const tracksDoc = readTracks(opts.workDir, entry.runId);
    const tracks = tracksDoc?.tracks ?? [];
    const hasLiveTrack = tracks.some((track) => {
      if (track.state !== "running") return false;
      if (track.pid && isProcessAlive(track.pid)) return true;
      const trackMs = track.lastHeartbeat ? Date.parse(track.lastHeartbeat) : NaN;
      return Number.isFinite(trackMs) && (now - trackMs) < opts.trackTimeout;
    });
    if (hasLiveTrack) {
      continue;
    }

    // Find tasks this dead run still claims and release them.
    const state = readSprintState(opts.stateFile);
    const claimedByDead = (state.tasks ?? [])
      .filter((task) => task.claimedBy === entry.runId && task.state !== "Done" && task.state !== "Failed")
      .map((task) => task.id);
    if (claimedByDead.length === 0) {
      continue;
    }

    const releaseResult = await sprintBoardExec(
      ["release", "--run-id", entry.runId, "--json"],
      opts
    );
    if (releaseResult.exitCode === 0) {
      released.push({ runId: entry.runId, taskIds: claimedByDead });
    }
  }

  return { released, skipped: false };
}

async function initRun(opts) {
  // B4 default-startup guard: the first run is zero-config (bare init == today's
  // single-run behavior). But once an active run exists, a bare init is ambiguous —
  // does the user want to join the shared backlog or start an isolated sprint? Force
  // an explicit choice instead of silently joining or silently forking. Explicit
  // --run-id / --workspace / --isolated opts bypass this (the user already chose).
  const hasExplicitRunId = Boolean(opts.parsed?.options?.["run-id"]);
  const hasExplicitWorkspace = Boolean(opts.parsed?.options?.["workspace"])
    || opts.parsed?.flags?.has("isolated")
    || opts.parsed?.flags?.has("isolated-tree")
    || opts.parsed?.flags?.has("shared-tree");
  if (!hasExplicitRunId && !hasExplicitWorkspace) {
    const active = readActiveRuns(opts.workDir);
    if (active.length > 0) {
      const lines = active.map((entry) => `  - ${entry.runId} (heartbeat ${entry.heartbeatAt || "unknown"})`).join("\n");
      fail(opts, "INIT_AMBIGUOUS", `an active run already exists:\n${lines}\n\nChoose explicitly:\n  join shared:    orchestrate init --workspace default\n  isolated sprint: orchestrate init --workspace <name> --isolated\n  specific run:   orchestrate init --run-id <id>`, { activeRuns: active }, 2);
    }
  }

  const scopedRunId = opts.parsed?.options?.["run-id"] ? (opts.runId || createRunId()) : "";
  const runId = scopedRunId || createRunId();
  opts.runId = scopedRunId;
  const now = new Date().toISOString();
  // Persist workspace definition when the user explicitly opted into a non-default
  // workspace, so subsequent commands resolve the same backlog paths without re-passing flags.
  if (opts.workspace && (opts.workspace.type === "isolated" || opts.workspace.name !== "default")) {
    await writeWorkspace(opts.workDir, {
      name: opts.workspace.name,
      type: opts.workspace.type,
      stateFile: opts.stateFile,
      boardFile: opts.boardFile,
      journalFile: opts.journalFile,
      pitfallsFile: opts.pitfallsFile,
      executionTree: opts.workspace.executionTree,
      baseRef: "",
      createdAt: now,
    });
    // Pre-seed the isolated workspace sprint-state so `sprint-board add` does not
    // FILE_NOT_FOUND on a freshly initialized workspace (dogfood #3). Inherit the
    // project task prefix from the root sprint-state/config so generated IDs stay
    // consistent with the project's canonical format (do NOT hardcode "AP").
    if (!fs.existsSync(opts.stateFile)) {
      fs.mkdirSync(path.dirname(opts.stateFile), { recursive: true });
      const rootStateFile = path.resolve(opts.workDir, ".va-auto-pilot", "sprint-state.json");
      let projectPrefix = "AP";
      try {
        if (fs.existsSync(rootStateFile)) {
          const rootState = JSON.parse(fs.readFileSync(rootStateFile, "utf8"));
          if (typeof rootState.projectPrefix === "string" && rootState.projectPrefix) {
            projectPrefix = rootState.projectPrefix;
          }
        }
      } catch {
        // fall back to default prefix if root state is unreadable
      }
      writeJsonFileAtomicSync(opts.stateFile, {
        version: 1,
        projectPrefix,
        updatedAt: now,
        tasks: [],
      });
    }
  }
  const run = {
    schemaVersion: 1,
    runId,
    manager: { surface: opts.managerSurface },
    mode: "orchestrated",
    phase: "initialized",
    cycle: 0,
    approvedPlanId: null,
    candidatePlan: null,
    candidateBacklog: null,
    approvedCommitTasks: [],
    workspace: opts.workspace ?? { name: "default", type: "shared", executionTree: "isolated" },
    locks: { executorPid: null },
    startedAt: now,
    updatedAt: now,
  };
  await writeRun(opts.workDir, run, scopedRunId);
  await writeTracks(opts.workDir, { runId, tracks: [] }, scopedRunId);
  clearCheckpoint(opts.workDir, scopedRunId);
  clearPlanReview(opts.workDir, scopedRunId);
  if (scopedRunId) {
    await writeActiveRun(opts.workDir, {
      runId,
      startedAt: run.startedAt,
      heartbeatAt: now,
    });
  } else {
    await clearActiveRun(opts.workDir);
  }
  return run;
}

async function orchestratePlan(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);

  const goalBacklogResult = await planFromGoal(opts, {
    apply: true,
    reason: "orchestrate plan",
  });
  if (!goalBacklogResult.ok && (goalBacklogResult.intents ?? []).length > 0) {
    fail(opts, "INTENT_PROCESSING_REQUIRED", "unprocessed human intent must be converted into backlog before planning", {
      boardPath: goalBacklogResult.boardPath,
      intents: goalBacklogResult.intents,
    }, 2);
  }

  // Atomic plan-and-claim: sprint-board plan --claim-run-id selects tasks AND stamps
  // ownership inside the same file lock. This closes the check-then-act window where
  // two concurrent runs both read a claim-free snapshot and selected the same Backlog
  // task (dogfood finding #1). Priority semantics are preserved (Failed/Review/In
  // Progress still outrank Backlog); only Backlog assignment is claim-gated. Replanning
  // the same run is idempotent — claim allows re-claim by the same runId.
  // Claim budget (dogfood #4): in a SHARED workspace, cap how many Backlog tasks this
  // run claims so sibling runs are not starved. Budget = ceil(claimableBacklog / activeRuns),
  // floored at 1. Isolated workspaces have their own backlog, so no budget needed.
  const planArgs = ["plan", "--claim-run-id", run.runId, "--json", "--max-parallel", String(opts.maxParallel)];
  if (run.workspace?.type === "shared") {
    const activeRuns = readActiveRuns(opts.workDir);
    const activeCount = Math.max(1, activeRuns.length);
    const state = readSprintState(opts.stateFile);
    const nowMs = Date.now();
    // claimable = unclaimed Backlog OR Backlog whose claim has expired (the planner
    // and claimer treat expired claims as available, so the budget must too — otherwise
    // a dead run's expired claims make claimableBacklog=0 and the budget is skipped).
    const isClaimable = (task) => {
      if (task.state !== "Backlog") return false;
      if (!task.claimedBy) return true;
      const exp = task.claimExpiresAt ? Date.parse(task.claimExpiresAt) : NaN;
      return Number.isFinite(exp) && exp < nowMs;
    };
    const claimableBacklog = (state.tasks ?? []).filter(isClaimable).length;
    if (claimableBacklog > 0 && activeCount > 1) {
      const budget = Math.max(1, Math.ceil(claimableBacklog / activeCount));
      planArgs.push("--max-claim", String(budget));
    }
  }
  const planResult = await sprintBoardExec(planArgs, opts);
  if (planResult.exitCode !== 0) {
    fail(opts, "PLAN_FAILED", planResult.stderr || planResult.stdout, {}, 1);
  }
  const planParsed = tryParseJson(planResult.stdout.trim());
  if (!planParsed.parsed || !planParsed.value?.primaryTaskId) {
    fail(opts, "PLAN_EMPTY", "no parallel plan available", { stdout: planResult.stdout }, 1);
  }
  const candidatePlan = planParsed.value;

  run.candidatePlan = candidatePlan;
  run.candidateBacklog = goalBacklogResult.ok ? goalBacklogResult.candidateBacklog : (run.candidateBacklog ?? null);
  run.approvedPlanId = null;
  run.approvedCommitTasks = [];
  run.phase = "awaiting-plan-approval";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);
  clearPlanReview(opts.workDir, opts.runId);

  const payload = {
    ok: true,
    phase: run.phase,
    runId: run.runId,
    candidateBacklog: run.candidateBacklog,
    goalToBacklog: goalBacklogResult.ok
      ? {
        applied: goalBacklogResult.applied,
        appliedTasks: goalBacklogResult.appliedTasks,
        handledIntent: goalBacklogResult.handledIntent,
      }
      : null,
    candidatePlan: run.candidatePlan,
  };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateReviewPlan(opts) {
  const run = readRun(opts.workDir, opts.runId);
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
    await writePlanReview(opts.workDir, review, opts.runId);
    fail(opts, "PLAN_REVIEW_CRITICAL", "plan review found CRITICAL findings", { review }, 1);
  }

  await writePlanReview(opts.workDir, review, opts.runId);
  run.phase = "plan-reviewed";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);

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

  const approvalPolicy = evaluateApprovalPolicy({
    decisionPoint: "plan",
    policy: readApprovalPolicyConfig(path.join(opts.workDir, ".va-auto-pilot", "config.yaml")),
    qualityGate: gateConfig,
    tasks: tasksForPlan(readSprintState(opts.stateFile), run.candidatePlan),
    diffStat: {
      changedFileCount: planTaskIds(run.candidatePlan).length,
      estimatedDiffLines: 0,
    },
  });
  let autoApproval = null;
  if (approvalPolicy.autoApproved) {
    autoApproval = await approveCandidatePlan(run, opts, {
      approvalMode: "approvalPolicy",
      policyDecision: approvalPolicy,
    });
    await sprintBoardExec(
      [
        "journal",
        "--task",
        "plan-review",
        "--summary",
        `approvalPolicy auto-approved plan ${autoApproval.planId}: ${approvalPolicy.reason}`,
        "--signals",
        `approval-policy:plan:${approvalPolicy.category}`,
      ],
      opts
    );
  } else {
    run.approvalPolicyDecisions = {
      ...(run.approvalPolicyDecisions ?? {}),
      plan: approvalPolicy,
    };
    await writeRun(opts.workDir, run, opts.runId);
  }

  const payload = {
    ok: true,
    phase: run.phase,
    runId: run.runId,
    planHash: review.planHash,
    review,
    approvalPolicy,
    autoApproval,
  };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function approveCandidatePlan(run, opts, { approvalMode = "human", policyDecision = null } = {}) {
  const planId = createPlanId();
  run.approvedPlanId = planId;
  run.phase = "plan-approved";
  run.updatedAt = new Date().toISOString();
  run.approvalPolicyDecisions = {
    ...(run.approvalPolicyDecisions ?? {}),
    ...(policyDecision ? { plan: policyDecision } : {}),
  };
  await writeRun(opts.workDir, run, opts.runId);

  const checkpoint = buildCheckpoint({
    stateFile: opts.stateFile,
    workDir: opts.workDir,
    approvedPlanId: planId,
    candidatePlan: run.candidatePlan,
    workspace: opts.workspace,
  });
  checkpoint.governance = {
    ...checkpoint.governance,
    approvalMode,
    ...(policyDecision ? { approvalPolicy: policyDecision } : {}),
  };
  await writeCheckpoint(opts.workDir, checkpoint, opts.runId);
  await appendGovernanceEvent(opts, run, "plan.approved", {
    planId,
    checkpointId: checkpoint.governance.checkpointId,
    candidatePlan: run.candidatePlan,
    approvalScope: checkpoint.governance.approvalScope,
    invalidatesOn: checkpoint.governance.invalidatesOn,
    stalePolicy: checkpoint.governance.stalePolicy,
    approvalMode,
    ...(policyDecision ? { approvalPolicy: policyDecision } : {}),
  });

  return { planId, checkpoint };
}

async function orchestrateApprovePlan(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);

  if (!run.candidatePlan?.primaryTaskId) {
    fail(opts, "NO_CANDIDATE_PLAN", "run orchestrate plan first", {}, 2);
  }

  const waiveReason = opts.parsed?.options?.["waive-review-with-reason"] ?? "";
  if (!waiveReason && !opts.parsed?.flags?.has("waive-review")) {
    const validation = validatePlanReviewForApprove({
      review: readPlanReview(opts.workDir, opts.runId),
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

  const approval = await approveCandidatePlan(run, opts, { approvalMode: "human" });

  const payload = { ok: true, phase: run.phase, runId: run.runId, approvedPlanId: approval.planId, checkpoint: approval.checkpoint };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateDispatch(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);
  await validatePreDispatch(run, opts);

  const taskIds = planTaskIds(run.candidatePlan);
  const workerOverrides = readWorkerOverrides(opts.workDir, opts.runId);
  const isGitRepo = detectGitRepo(opts.workDir);
  const worktreeConfig = resolveDispatchWorktreeConfig(
    readWorktreeIsolationConfig(path.join(opts.workDir, ".va-auto-pilot", "config.yaml")),
    opts.workspace,
    isGitRepo
  );
  const tracks = [];
  for (const taskId of taskIds) {
    const track = {
      taskId,
      state: "queued",
      worker: workerOverrides.get(taskId) ?? null,
      pid: null,
      logFile: null,
      startedAt: null,
      lastHeartbeat: new Date().toISOString(),
    };
    if (worktreeConfig.enabled === true) {
      track.worktree = opts.dryRun
        ? {
          enabled: true,
          status: "preview",
          path: resolveTrackWorktreePath(opts.workDir, worktreeConfig, run.runId, taskId),
        }
        : await prepareTrackWorktree({ workDir: opts.workDir, runId: run.runId, taskId, config: worktreeConfig });
    }
    tracks.push(track);
  }

  run.phase = "dispatch-queued";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);
  await writeTracks(opts.workDir, { runId: run.runId, tracks }, opts.runId);
  await appendGovernanceEvent(opts, run, "dispatch.queued", {
    checkpointId: readCheckpoint(opts.workDir, opts.runId)?.governance?.checkpointId ?? run.approvedPlanId,
    queuedTasks: taskIds,
    worktreeIsolation: {
      enabled: worktreeConfig.enabled === true,
      rootDir: worktreeConfig.rootDir,
      tracks: tracks.map((track) => ({ taskId: track.taskId, worktree: track.worktree ?? null })),
    },
  });

  const payload = {
    ok: true,
    phase: run.phase,
    runId: run.runId,
    queuedTasks: taskIds,
    worktreeIsolation: {
      enabled: worktreeConfig.enabled === true,
      rootDir: worktreeConfig.rootDir,
      tracks: tracks.map((track) => ({ taskId: track.taskId, worktree: track.worktree ?? null })),
    },
  };
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
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);

  const tracksDoc = readTracks(opts.workDir, opts.runId);
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
    await writeTracks(opts.workDir, tracksDoc, opts.runId);
    run.phase = "dry-run-preview";
    run.updatedAt = previewAt;
    await writeRun(opts.workDir, run, opts.runId);
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

  const usesWorktreeIsolation = queued.some((track) => track.worktree?.enabled === true && track.worktree?.path);
  const sharedBridge = usesWorktreeIsolation ? null : await createBridge(opts);
  const gateConfig = readQualityGateConfig();
  const pitfalls = await loadUnresolvedPitfalls(opts);
  const execOpts = {
    ...opts,
    runId: run.runId,
    deferCommit: true,
    observabilityWorkDir: opts.workDir,
    workerOverrides: buildWorkerOverrideCommands(opts.workDir, (workDir) => readWorkerOverrides(workDir, run.runId)),
  };

  run.phase = "running";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);

  const now = new Date().toISOString();
  for (const track of queued) {
    if (track.state === "halted") {
      continue;
    }
    track.state = "running";
    track.startedAt = now;
    track.lastHeartbeat = now;
  }
  await writeTracks(opts.workDir, tracksDoc, opts.runId);

  const runTrack = async (track) => {
    if (track.state === "halted") {
      return { taskId: track.taskId, action: "halted", terminal: true, skipped: true };
    }
    const trackOpts = track.worktree?.enabled === true && track.worktree?.path
      ? buildTrackOpts(execOpts, { workDir: track.worktree.path })
      : execOpts;
    const bridge = track.worktree?.enabled === true && track.worktree?.path
      ? await createBridge(trackOpts)
      : (sharedBridge ?? await createBridge(trackOpts));
    try {
      const result = await executeSingleTask(track.taskId, bridge, pitfalls, gateConfig, trackOpts);
      if (track.worktree?.enabled === true && result?.task?.state === "Done") {
        const commitResult = await commitTrackWorktreeResult({
          task: result.task,
          worktree: track.worktree,
        });
        track.worktree.resultCommit = commitResult.hash;
        track.worktree.commitResult = commitResult;
      }
      return { taskId: track.taskId, ...result };
    } finally {
      if (bridge && bridge !== sharedBridge && bridge.shutdown) {
        await bridge.shutdown();
      }
    }
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

  await writeTracks(opts.workDir, tracksDoc, opts.runId);

  if (!opts.dryRun && sharedBridge?.shutdown) {
    await sharedBridge.shutdown();
  }

  const stateAfterWorkers = readSprintState(opts.stateFile);
  const plannedTaskIds = new Set(planTaskIds(run.candidatePlan));
  const doneTasks = (stateAfterWorkers.tasks ?? [])
    .filter((task) => plannedTaskIds.has(task.id) && task.state === "Done");
  let approvalPolicy = null;
  let autoApproval = null;

  run.phase = "awaiting-commit-approval";
  if (doneTasks.length > 0) {
    const changeContext = await collectApprovalChangeContext(opts.workDir);
    approvalPolicy = evaluateApprovalPolicy({
      decisionPoint: "commit",
      policy: readApprovalPolicyConfig(path.join(opts.workDir, ".va-auto-pilot", "config.yaml")),
      qualityGate: gateConfig,
      tasks: doneTasks,
      changedFiles: changeContext.changedFiles,
      diffStat: changeContext.diffStat,
    });
    run.approvalPolicyDecisions = {
      ...(run.approvalPolicyDecisions ?? {}),
      commit: approvalPolicy,
    };
    if (approvalPolicy.autoApproved) {
      run.approvedCommitTasks = doneTasks.map((task) => task.id);
      run.phase = "commit-approved";
      autoApproval = {
        approvedCommitTasks: run.approvedCommitTasks,
        approvalPolicy,
      };
      await appendGovernanceEvent(opts, run, "commit.approved", {
        approvalMode: "approvalPolicy",
        approvedCommitTasks: run.approvedCommitTasks,
        approvalPolicy,
      });
      await sprintBoardExec(
        [
          "journal",
          "--task",
          "commit-approval",
          "--summary",
          `approvalPolicy auto-approved commit for ${run.approvedCommitTasks.join(", ")}: ${approvalPolicy.reason}`,
          "--signals",
          `approval-policy:commit:${approvalPolicy.category}`,
        ],
        opts
      );
    }
  }
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);

  const payload = {
    ok: true,
    phase: run.phase,
    runId: run.runId,
    results,
    parallel: queued.length,
    approvalPolicy,
    autoApproval,
  };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateApproveCommit(opts) {
  const run = readRun(opts.workDir, opts.runId);
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
  await writeRun(opts.workDir, run, opts.runId);

  const payload = { ok: true, phase: run.phase, runId: run.runId, approvedCommitTasks: tasks };
  await refreshSnapshot(opts);
  return emitResult(opts, payload);
}

async function orchestrateCommit(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);

  if (!opts.waiveApprovals && run.phase !== "commit-approved") {
    fail(opts, "APPROVAL_REQUIRED", "approve-commit required before commit", { phase: run.phase }, 2);
  }

  if (!opts.waiveApprovals && (!Array.isArray(run.approvedCommitTasks) || run.approvedCommitTasks.length === 0)) {
    fail(opts, "APPROVAL_REQUIRED", "approve-commit required before commit", {}, 2);
  }

  const approved = new Set(run.approvedCommitTasks ?? []);
  const state = readSprintState(opts.stateFile);
  const tracksDoc = readTracks(opts.workDir, opts.runId);
  const tracksByTaskId = new Map((tracksDoc.tracks ?? []).map((track) => [track.taskId, track]));
  const tasksToCommit = [];
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
    tasksToCommit.push({ taskId, task });
  }

  for (const { taskId, task } of tasksToCommit) {
    const track = tracksByTaskId.get(taskId);
    const observedHead = computeGitHead(opts.workDir);
    let result;
    let worktreeMerge;
    try {
      const lockedCommit = await withSerializedCommit(opts, async () => {
        let lockedMergeResult = null;
        if (track?.worktree?.enabled === true) {
          lockedMergeResult = await squashMergeTrackCommitWithRetry({
            opts,
            track,
            taskId,
            observedHead,
          });
        }
        const lockedCommitResult = await finalizeDoneTaskCommit(task, opts);
        return {
          result: lockedCommitResult,
          worktreeMerge: lockedMergeResult,
        };
      });
      result = lockedCommit.result;
      worktreeMerge = lockedCommit.worktreeMerge;
    } catch (error) {
      fail(opts, "WORKTREE_MERGE_FAILED", `failed to squash merge ${taskId} worktree result`, {
        taskId,
        worktree: track?.worktree ?? null,
        message: formatErrorMessage(error),
      }, 1);
    }
    commits.push({ taskId, ok: result.ok, details: result.details, hash: result.commitResult?.hash, worktreeMerge });
    if (!result.ok) {
      run.phase = "awaiting-commit-approval";
      run.approvedCommitTasks = [];
      run.updatedAt = new Date().toISOString();
      await writeRun(opts.workDir, run, opts.runId);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: false, phase: run.phase, runId: run.runId, commits }, 1);
    }
  }

  const failedCommits = commits.filter((commit) => commit.ok === false);
  if (failedCommits.length > 0) {
    run.phase = "awaiting-commit-approval";
    run.approvedCommitTasks = [];
    run.updatedAt = new Date().toISOString();
    await writeRun(opts.workDir, run, opts.runId);
    await refreshSnapshot(opts);
    return emitResult(opts, { ok: false, phase: run.phase, runId: run.runId, commits }, 1);
  }

  run.phase = "committed";
  run.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, run, opts.runId);
  await refreshSnapshot(opts);

  const payload = { ok: true, phase: run.phase, runId: run.runId, commits };
  return emitResult(opts, payload);
}

async function orchestrateJournal(opts) {
  const run = readRun(opts.workDir, opts.runId);
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
  await writeRun(opts.workDir, run, opts.runId);
  await appendGovernanceEvent(opts, run, "journal", {
    summary,
    cycle: run.cycle,
    stopCondition,
  });
  const snapshot = await refreshSnapshot(opts);

  const paths = orchestrationPaths(opts.workDir, opts.runId);
  const eventsLog = snapshot.checkpoint?.observability?.eventLogPath ?? observabilityPaths(opts.workDir).eventsLog;
  const journalCommit = await commitControlFiles(
    [
      paths.run,
      paths.snapshot,
      opts.journalFile,
      eventsLog,
    ],
    `chore(orchestration): close cycle ${run.cycle}`,
    opts
  );

  const payload = { ok: true, phase: run.phase, runId: run.runId, cycle: run.cycle, stopCondition, journalCommit };
  return emitResult(opts, payload);
}

async function approveCurrentPlanForUnattended(opts) {
  const run = readRun(opts.workDir, opts.runId);
  if (!run?.candidatePlan?.primaryTaskId) {
    fail(opts, "NO_CANDIDATE_PLAN", "run orchestrate plan first", {}, 2);
  }

  const { checkpoint } = await approveCandidatePlan(run, opts, { approvalMode: "waive-approvals" });
  await refreshSnapshot(opts);

  return { run, checkpoint };
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

  const maxCycles = Number.parseInt(opts.parsed?.options?.["max-cycles"] ?? "50", 10);
  for (let cycle = 0; cycle < maxCycles; cycle += 1) {
    const stateBeforePlan = readSprintState(opts.stateFile);
    const stopBeforePlan = detectStopCondition(stateBeforePlan);
    if (stopBeforePlan.stop || !hasPendingTasks(stateBeforePlan)) {
      break;
    }

    await orchestratePlan({ ...opts, json: false });
    const { run } = await approveCurrentPlanForUnattended(opts);
    const plannedTaskIds = new Set(planTaskIds(run.candidatePlan));

    await orchestrateDispatch({ ...opts, json: false });
    await orchestrateAwaitWorkers({ ...opts, json: false });
    const state = readSprintState(opts.stateFile);
    const doneTasks = (state.tasks ?? [])
      .filter((task) => plannedTaskIds.has(task.id) && task.state === "Done")
      .map((task) => task.id);
    if (doneTasks.length > 0) {
      await orchestrateApproveCommit({ ...opts, tasks: doneTasks.join(","), json: false });
      await orchestrateCommit({ ...opts, waiveApprovals: true, json: false });
    }
    await orchestrateJournal({ ...opts, json: false });
    const stop = detectStopCondition(readSprintState(opts.stateFile));
    if (stop.stop) {
      break;
    }
  }

  const finalRun = readRun(opts.workDir, opts.runId);
  finalRun.phase = "done";
  finalRun.updatedAt = new Date().toISOString();
  await writeRun(opts.workDir, finalRun, opts.runId);
  await refreshSnapshot(opts);
  const paths = orchestrationPaths(opts.workDir, opts.runId);
  const finalCommit = await commitControlFiles(
    [
      paths.run,
      paths.snapshot,
    ],
    `chore(orchestration): finish run ${finalRun.runId}`,
    opts
  );
  return emitResult(opts, { ok: true, phase: "done", runId: finalRun.runId, finalCommit });
}

async function orchestrateListRuns(opts) {
  const paths = orchestrationPaths(opts.workDir);
  if (!fs.existsSync(paths.runsDir)) {
    return emitResult(opts, { ok: true, action: "list-runs", runs: [] });
  }

  // Active runs come from the index table (may contain more than one entry).
  const activeRuns = readActiveRuns(opts.workDir);
  const activeSet = new Set(activeRuns.map((entry) => entry.runId));
  const heartbeatByRun = new Map(activeRuns.map((entry) => [entry.runId, entry.heartbeatAt]));

  // Scan sprint-state files to attribute claimed tasks per run. Track which absolute
  // paths we have already scanned so a workspace-scoped list-runs (opts.stateFile
  // already pointing at a workspace) does not double-count the same file.
  const claimedByRun = new Map();
  const scanned = new Set();
  const collectClaims = (stateFile) => {
    // Normalize via realpath so the same file is not counted twice when reached via
    // different path strings (e.g. opts.stateFile vs a workspaces/ scan, or /var vs
    // /private/var on macOS). dogfood review #P3.
    let abs;
    try {
      abs = fs.realpathSync(path.resolve(stateFile));
    } catch {
      return;
    }
    if (scanned.has(abs)) return;
    scanned.add(abs);
    try {
      const state = readSprintState(abs);
      for (const task of state.tasks ?? []) {
        if (task.claimedBy) {
          if (!claimedByRun.has(task.claimedBy)) claimedByRun.set(task.claimedBy, []);
          claimedByRun.get(task.claimedBy).push(task.id);
        }
      }
    } catch {
      // unreadable state file; skip
    }
  };
  collectClaims(opts.stateFile);
  // Also scan workspace sprint-states (isolated sprints own their own claims).
  const wsRoot = path.resolve(opts.workDir, ".va-auto-pilot", "workspaces");
  if (fs.existsSync(wsRoot)) {
    for (const name of fs.readdirSync(wsRoot)) {
      const wsState = path.join(wsRoot, name, "sprint-state.json");
      if (fs.existsSync(wsState)) {
        collectClaims(wsState); // dedup via scanned-set
      }
    }
  }

  const now = Date.now();
  const runs = fs.readdirSync(paths.runsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const run = readRun(opts.workDir, entry.name);
      if (!run?.runId) {
        return null;
      }
      const heartbeat = heartbeatByRun.get(run.runId) ?? run.updatedAt ?? null;
      const heartbeatMs = heartbeat ? Date.parse(heartbeat) : NaN;
      return {
        runId: run.runId,
        phase: run.phase ?? null,
        workspace: run.workspace?.name ?? null,
        workspaceType: run.workspace?.type ?? null,
        executionTree: run.workspace?.executionTree ?? null,
        startedAt: run.startedAt ?? null,
        heartbeatAt: heartbeat,
        heartbeatAgeSec: Number.isFinite(heartbeatMs) ? Math.round((now - heartbeatMs) / 1000) : null,
        active: activeSet.has(run.runId),
        claimedTasks: claimedByRun.get(run.runId) ?? [],
      };
    })
    .filter(Boolean)
    .sort((left, right) => String(right.startedAt ?? "").localeCompare(String(left.startedAt ?? "")));

  return emitResult(opts, { ok: true, action: "list-runs", runs });
}

export async function runOrchestrateCommand(subcommand, argv) {
  const opts = buildOrchestrationOpts(argv, {
    resolveActiveRunId: !["init", "run-unattended", "list-runs"].includes(subcommand),
  });
  if (!opts.parsed.options["run-id"] && !opts.runId && !["init", "run-unattended", "list-runs"].includes(subcommand)) {
    const activeRunId = resolveActiveRunId(opts.workDir);
    if (activeRunId) {
      opts.runId = activeRunId;
    }
  }

  // Lease heartbeat: each orchestrate command (except init/list-runs, which manage
  // the index themselves) refreshes this run's heartbeatAt on entry. This is the
  // lease that recover uses to detect dead runs and release their claims. One
  // command = one process, so there is no long-lived daemon to write heartbeats —
  // the command boundary IS the heartbeat.
  if (opts.runId && !["init", "list-runs"].includes(subcommand)) {
    const run = readRun(opts.workDir, opts.runId);
    if (run?.runId) {
      await writeActiveRun(opts.workDir, {
        runId: run.runId,
        startedAt: run.startedAt,
        heartbeatAt: new Date().toISOString(),
      });
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
    case "recover":
      return orchestrateRecover(opts);
    case "list-runs":
      return orchestrateListRuns(opts);
    case "run-unattended":
      return orchestrateRunUnattended(opts);
    default:
      fail(opts, "UNKNOWN_SUBCOMMAND", `unknown orchestrate subcommand: ${subcommand}`, {}, 1);
  }
}
