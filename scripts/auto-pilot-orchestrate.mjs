import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";

import { readQualityGateConfig, resolveDefaults } from "./lib/sprint-utils.mjs";
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
  assertSafeRunId,
  buildRecoveryPlan,
  buildCheckpoint,
  clearActiveRun,
  clearCheckpoint,
  computeGitHead,
  createPlanId,
  createRunId,
  hasHaltDirective,
  findLiveTrackedWorker,
  isCheckpointStale,
  isTerminalRunPhase,
  orchestrationPaths,
  readActiveRuns,
  readCheckpoint,
  readDirectives,
  readRun,
  readTracks,
  readWorkerOverrides,
  recoverRunTracksTransaction,
  resolveActiveRunId,
  resolveWorkerLifecycleDir,
  isTrackWorkerAlive,
  writeActiveRun,
  writeCheckpoint,
  writeDirectives,
  updateRunAtomic,
  updateRunAndTracksAtomic,
  updateRunningTrackLiveness,
  updateTrackAtomic,
} from "./lib/orchestration-state.mjs";
import { planFromGoal } from "./lib/goal-backlog.mjs";
import {
  commitPaths,
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
import {
  appendEventLog,
  buildEvent,
  ensureSafeManagedPath,
  observabilityPaths,
} from "./lib/observability.mjs";
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
import { resolveWorkspacePaths, writeWorkspace } from "./lib/workspace.mjs";
import { planTaskIds } from "./lib/plan-helpers.mjs";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./lib/pilot-state.mjs";
import { resolveHumanBoardPath } from "./lib/human-board.mjs";

const execFileAsync = promisify(execFile);
const MAX_SQUASH_MERGE_ATTEMPTS = 3;

function executorLockTarget(workDir, runId = "") {
  return `${orchestrationPaths(workDir, runId).run}.executor`;
}

async function transitionRunIfUnchanged(opts, expectedRun, buildNext, action, onConflict = null) {
  let updated = false;
  const persisted = await updateRunAtomic(opts.workDir, opts.runId, (current) => {
    if (!current
        || current.runId !== expectedRun.runId
        || current.phase !== expectedRun.phase
        || current.updatedAt !== expectedRun.updatedAt
        || isTerminalRunPhase(current.phase)
        || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) {
      return null;
    }
    updated = true;
    return buildNext(current);
  });
  if (!updated) {
    const cleanup = typeof onConflict === "function"
      ? await onConflict(persisted)
      : null;
    fail(opts, "RUN_STATE_CHANGED", `${action} was superseded by a newer run state or halt directive`, {
      runId: expectedRun.runId,
      expectedPhase: expectedRun.phase,
      currentPhase: persisted?.phase ?? "missing",
      ...(cleanup ? { cleanup } : {}),
    }, 2);
  }
  return persisted;
}

const ACTION_PHASES = Object.freeze({
  plan: Object.freeze([
    "initialized",
    "awaiting-plan-approval",
    "plan-reviewed",
    "plan-approved",
    "dry-run-preview",
    "cycle-closed",
  ]),
  "review-plan": Object.freeze([
    "awaiting-plan-approval",
    "plan-reviewed",
    "plan-approved",
  ]),
  "approve-plan": Object.freeze([
    "awaiting-plan-approval",
    "plan-reviewed",
    "plan-approved",
  ]),
});

/**
 * Pure phase validation for plan-governance actions. These actions may be retried
 * before dispatch, and a new cycle may plan again after its journal is closed, but
 * they must never rewrite approval state while workers or commits are in flight.
 */
export function validateOrchestrationActionPhase(action, phase) {
  const allowedPhases = ACTION_PHASES[action] ?? [];
  return {
    ok: allowedPhases.includes(phase),
    action,
    phase,
    allowedPhases: [...allowedPhases],
  };
}

function sortedUniqueStrings(values) {
  return [...new Set(Array.isArray(values) ? values.map(String) : [])].sort();
}

/**
 * A Done sprint task is commit-eligible only when its worker track settled
 * successfully. Isolated tracks additionally bind the exact result commit and its
 * file list, so a commit failure or manifest mismatch cannot be mistaken for a
 * successful worker result.
 */
export function validateCommitReadyTrack(track) {
  if (!track) {
    return { ok: false, reason: "missing worker track" };
  }
  if (track.state !== "settled") {
    return { ok: false, reason: `worker track state is ${track.state ?? "missing"}, not settled` };
  }
  if (track.resultStatus !== "succeeded") {
    return { ok: false, reason: `worker track result is ${track.resultStatus ?? "unverified"}, not succeeded` };
  }
  if (track.error) {
    return { ok: false, reason: `worker track recorded an error: ${track.error}` };
  }
  if (track.sprintState !== "Done") {
    return { ok: false, reason: `worker track sprint state is ${track.sprintState ?? "missing"}, not Done` };
  }
  if (track.worktree?.enabled === true) {
    const resultCommit = String(track.worktree.resultCommit ?? "").trim();
    if (!resultCommit) {
      return { ok: false, reason: "isolated worker track has no result commit" };
    }
    const approvedFiles = sortedUniqueStrings(track.approvalFiles);
    const committedFiles = sortedUniqueStrings(track.worktree.commitResult?.files);
    if (JSON.stringify(approvedFiles) !== JSON.stringify(committedFiles)) {
      return {
        ok: false,
        reason: `isolated worker file manifest mismatch: approved ${approvedFiles.join(", ") || "<none>"}; committed ${committedFiles.join(", ") || "<none>"}`,
      };
    }
  }
  return { ok: true, reason: "" };
}

export function selectCommitReadyTasks(state, candidatePlan, tracksDoc) {
  const plannedTaskIds = new Set(planTaskIds(candidatePlan));
  const tracksByTaskId = new Map((tracksDoc?.tracks ?? []).map((track) => [track.taskId, track]));
  return (state?.tasks ?? []).filter((task) => {
    if (!plannedTaskIds.has(task.id) || task.state !== "Done") {
      return false;
    }
    return validateCommitReadyTrack(tracksByTaskId.get(task.id)).ok;
  });
}

/**
 * Persist one Promise.allSettled worker outcome onto its track. Rejections and
 * non-committable Done results become explicit failed tracks; they are never
 * represented by the same `settled` state used by successful results.
 */
export function settleWorkerTrackOutcome(track, outcome, sprintTask, settledAt) {
  const clearTerminalWorker = () => {
    if (["running", "starting"].includes(track.state)) return;
    if (track.pid || track.workerToken) {
      track.lastWorker = {
        pid: track.pid ?? null,
        workerToken: track.workerToken ?? "",
        dispatchId: track.dispatchId ?? "",
        startedAt: track.startedAt ?? null,
        endedAt: settledAt,
      };
    }
    track.pid = null;
    track.workerToken = "";
    track.heartbeatFile = "";
  };
  track.lastHeartbeat = settledAt;
  if (sprintTask) {
    track.sprintState = sprintTask.state;
  }

  if (outcome.status === "rejected") {
    const message = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
    if (outcome.reason?.code === "WORKER_LAUNCH_AMBIGUOUS") {
      track.state = "running";
      track.resultStatus = "failed";
      track.resultAction = "launch-ambiguous";
      track.error = message;
      track.approvalFiles = [];
      return { taskId: track.taskId, action: "launch-ambiguous", details: message };
    }
    track.state = "failed";
    track.resultStatus = "failed";
    track.resultAction = "track-error";
    track.error = message;
    track.approvalFiles = [];
    if (track.worktree) {
      delete track.worktree.resultCommit;
      delete track.worktree.commitResult;
    }
    clearTerminalWorker();
    return { taskId: track.taskId, action: "track-error", details: message };
  }

  const result = outcome.value;
  const sprintTerminal = sprintTask && ["Done", "Failed"].includes(sprintTask.state);
  track.state = result.terminal || result.skipped || sprintTerminal ? "settled" : "running";
  track.resultAction = result.action;
  delete track.error;
  if (result.pid) {
    track.pid = result.pid;
  }

  if (track.state === "settled" && sprintTask?.state === "Done") {
    track.resultStatus = "succeeded";
    const readiness = validateCommitReadyTrack(track);
    if (!readiness.ok) {
      track.state = "failed";
      track.resultStatus = "failed";
      track.resultAction = "track-error";
      track.error = readiness.reason;
      track.approvalFiles = [];
      if (track.worktree) {
        delete track.worktree.resultCommit;
        delete track.worktree.commitResult;
      }
      clearTerminalWorker();
      return { taskId: track.taskId, action: "track-error", details: readiness.reason };
    }
  } else if (sprintTask?.state === "Failed") {
    track.state = "failed";
    track.resultStatus = "failed";
  } else if (track.state === "settled") {
    track.resultStatus = "skipped";
  } else {
    track.resultStatus = "pending";
  }

  clearTerminalWorker();
  return result;
}

function tasksForPlan(state, plan) {
  const taskIds = new Set(planTaskIds(plan));
  return (Array.isArray(state?.tasks) ? state.tasks : [])
    .filter((task) => taskIds.has(task.id));
}

function hashApprovalValue(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function hashFileIdentity(mode, content) {
  return crypto.createHash("sha256")
    .update(`${mode}\0`, "utf8")
    .update(content)
    .digest("hex");
}

function hashApprovedFile(workDir, file) {
  const root = path.resolve(workDir);
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`approved commit file escapes worktree: ${file}`);
  }
  if (!fs.existsSync(target)) {
    return null;
  }
  const stat = fs.lstatSync(target);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`approved commit file must be a regular file: ${file}`);
  }
  const mode = (stat.mode & 0o111) !== 0 ? "100755" : "100644";
  return hashFileIdentity(mode, fs.readFileSync(target));
}

function hashApprovedCommitFile(workDir, commit, file) {
  const root = path.resolve(workDir);
  const target = path.resolve(root, file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`approved commit file escapes worktree: ${file}`);
  }
  const treeEntry = execFileSync("git", ["ls-tree", "-z", commit, "--", file], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (treeEntry.length === 0) {
    return null;
  }
  const mode = treeEntry.toString("utf8").split(" ", 1)[0];
  const content = execFileSync("git", ["show", `${commit}:${file}`], {
    cwd: root,
    encoding: "buffer",
    stdio: ["ignore", "pipe", "ignore"],
    maxBuffer: 50 * 1024 * 1024,
  });
  return hashFileIdentity(mode, content);
}

export function collectEvidenceBundleFiles(workDir, relativeManifest) {
  if (!relativeManifest) {
    return [];
  }
  const root = path.resolve(workDir);
  const evidenceRoot = path.resolve(root, ".va-auto-pilot", "evidence");
  const manifest = path.resolve(root, relativeManifest);
  const manifestRelative = path.relative(evidenceRoot, manifest);
  if (!manifestRelative
      || manifestRelative.startsWith("..")
      || path.isAbsolute(manifestRelative)
      || path.basename(manifest) !== "manifest.json") {
    throw new Error(`evidence manifest escapes the managed evidence root: ${relativeManifest}`);
  }
  const bundleDir = path.dirname(manifest);
  ensureSafeManagedPath(root, bundleDir, { directory: true, create: false });
  ensureSafeManagedPath(root, manifest);
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`evidence bundle must not contain symbolic links: ${toRepoPath(absolute, root)}`);
      }
      if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        files.push(toRepoPath(absolute, root));
      }
    }
  };
  if (!fs.existsSync(manifest) || !fs.lstatSync(manifest).isFile()) {
    throw new Error(`evidence manifest does not exist: ${relativeManifest}`);
  }
  visit(bundleDir);
  return sortedUniqueStrings(files.filter(Boolean));
}

function collectManagerApprovalFiles(opts) {
  return sortedUniqueStrings([
    opts.stateFile,
    opts.boardFile,
    opts.journalFile,
    opts.pitfallsFile,
    opts.stateFile ? resolveHumanBoardPath(opts.stateFile) : "",
    path.resolve(opts.workDir, ".va-auto-pilot", "evidence", "eval-history.jsonl"),
  ].map((file) => file ? toRepoPath(file, opts.workDir) : "").filter((file) => (
    file && fs.existsSync(path.resolve(opts.workDir, file))
  )));
}

export function buildCommitApprovalManifest(tasks, tracksDoc, opts) {
  const tracksByTaskId = new Map((tracksDoc?.tracks ?? []).map((track) => [track.taskId, track]));
  const entries = tasks.map((task) => {
    const track = tracksByTaskId.get(task.id);
    const readiness = validateCommitReadyTrack(track);
    if (!readiness.ok) {
      throw new Error(`cannot build commit approval manifest for ${task.id}: ${readiness.reason}`);
    }
    const files = sortedUniqueStrings(track.approvalFiles);
    const evidenceFiles = sortedUniqueStrings(track.evidenceFiles);
    const resultCommit = String(track.worktree?.resultCommit ?? "");
    const evidenceBundle = String(track.evidenceBundle ?? "");
    if (evidenceBundle && !evidenceFiles.includes(evidenceBundle)) {
      throw new Error(`cannot build commit approval manifest for ${task.id}: evidence manifest is not in the approved evidence files`);
    }
    return {
      taskId: task.id,
      files,
      resultCommit,
      evidenceBundle,
      evidenceFiles,
      fileHashes: Object.fromEntries(files.map((file) => [
        file,
        resultCommit
          ? hashApprovedCommitFile(opts.workDir, resultCommit, file)
          : hashApprovedFile(opts.workDir, file),
      ])),
      evidenceFileHashes: Object.fromEntries(
        evidenceFiles.map((file) => [file, hashApprovedFile(opts.workDir, file)])
      ),
    };
  }).sort((left, right) => left.taskId.localeCompare(right.taskId));
  const managerFiles = collectManagerApprovalFiles(opts);
  const manifest = {
    schemaVersion: 1,
    baseHead: computeGitHead(opts.workDir),
    managerFiles,
    managerFileHashes: Object.fromEntries(
      managerFiles.map((file) => [file, hashApprovedFile(opts.workDir, file)])
    ),
    tasks: entries,
  };
  return { manifest, hash: hashApprovalValue(manifest) };
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
  // Always under the gitignored orchestration tree — never workspace.dir / project root.
  // Shared workspace.dir is the project root (dogfood #6). withPilotFileLock(path) creates
  // `${path}.lock`; if that lands at repo root, finalizeDoneTaskCommit's `git add` stages
  // it, releaseLock deletes it, and the worktree is left dirty (`D commit.lock.lock`).
  // All runs in one project serialize through one lock (commits share one git index).
  void opts.workspace;
  return path.resolve(opts.workDir, ".va-auto-pilot", "orchestration", "commit.lock");
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

async function rollbackSquashMergedFiles(track, opts) {
  const files = sortedUniqueStrings([
    ...(track?.approvalFiles ?? []),
    ...(track?.worktree?.commitResult?.files ?? []),
  ]);
  if (files.length === 0) {
    await resetSquashMergeState(opts);
    return;
  }
  await git(["reset", "-q", "HEAD", "--", ...files], opts);
  for (const file of files) {
    const repoFile = toRepoPath(path.resolve(opts.workDir, file), opts.workDir);
    if (!repoFile) {
      throw new Error(`cannot roll back squash path outside integration tree: ${file}`);
    }
    const trackedAtHead = await git(["cat-file", "-e", `HEAD:${repoFile}`], opts)
      .then(() => true)
      .catch(() => false);
    if (trackedAtHead) {
      await git(["restore", "--worktree", "--source=HEAD", "--", repoFile], opts);
    } else {
      fs.rmSync(path.resolve(opts.workDir, repoFile), { recursive: true, force: true });
    }
  }
}

export async function assertCleanIntegrationTree(opts, { runtimeWorktreePaths = [] } = {}) {
  const status = await git(["status", "--porcelain", "--untracked-files=all"], opts);
  const allowedControlFiles = new Set([
    opts.stateFile,
    opts.boardFile,
    opts.journalFile,
    opts.pitfallsFile,
    opts.stateFile ? resolveHumanBoardPath(opts.stateFile) : "",
  ].map((file) => file ? toRepoPath(file, opts.workDir) : "").filter(Boolean));
  const allowedWorktreePrefixes = runtimeWorktreePaths
    .map((file) => file ? toRepoPath(file, opts.workDir) : "")
    .filter(Boolean)
    .map((file) => `${file.replace(/\/+$/, "")}/`);
  const dirty = status.stdout.split(/\r?\n/)
    .filter(Boolean)
    .map((line) => ({ line, file: line.slice(3).replace(/^"|"$/g, "") }))
    .filter(({ file }) => !allowedControlFiles.has(file)
      && !file.startsWith(".va-auto-pilot/orchestration/")
      && !file.startsWith(".va-auto-pilot/evidence/")
      && !file.startsWith(".va-auto-pilot/parallel-runs/")
      && !allowedWorktreePrefixes.some((prefix) => file.startsWith(prefix)))
    .map(({ line }) => line.trim());
  if (dirty.length > 0) {
    const error = /** @type {Error & { code: string, dirtyFiles: string[] }} */ (new Error(
      `refusing to squash-merge into a dirty integration tree; preserve or commit these files first: ${dirty.join(", ")}`
    ));
    error.code = "DIRTY_INTEGRATION_TREE";
    error.dirtyFiles = dirty;
    throw error;
  }
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

  const tracked = await git(["ls-files", "--cached", "-z", "--", ...repoFiles], opts, repoRoot);
  const trackedFiles = new Set(tracked.stdout.split("\0").filter(Boolean));
  const stageableFiles = repoFiles.filter((file) => (
    trackedFiles.has(file) || fs.existsSync(path.join(repoRoot, file))
  ));
  if (stageableFiles.length === 0) {
    return { committed: false, skipped: true, reason: "no existing or tracked control files", files: [], hash: "", header };
  }

  return withSerializedCommit(opts, () => commitPaths(header, stageableFiles, {
    ...opts,
    workDir: repoRoot,
    commitLockHeld: true,
  }));
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
    }),
    { safeRoot: opts.workDir }
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

function assertActionPhase(run, action, opts) {
  const validation = validateOrchestrationActionPhase(action, run.phase);
  if (!validation.ok) {
    fail(
      opts,
      "INVALID_PHASE",
      `${action} requires phase ${validation.allowedPhases.join(" or ")} (current: ${run.phase})`,
      { action, phase: run.phase, allowedPhases: validation.allowedPhases },
      2
    );
  }
}

async function validatePreDispatch(run, opts) {
  if (!["plan-approved", "dry-run-preview"].includes(run.phase)) {
    fail(opts, "INVALID_PHASE", `dispatch requires phase plan-approved (current: ${run.phase})`, { phase: run.phase }, 2);
  }
  const directives = readDirectives(opts.workDir, opts.runId);
  if (hasHaltDirective(directives)) {
    fail(opts, "HALTED", "directives.json contains halt-run", { directives }, 2);
  }

  if (!run.approvedPlanId) {
    fail(opts, "APPROVAL_REQUIRED", "approve-plan required before dispatch", {}, 2);
  }

  const checkpoint = readCheckpoint(opts.workDir, opts.runId);
  const stale = isCheckpointStale(checkpoint, {
    stateFile: opts.stateFile,
    workDir: opts.workDir,
    workspace: opts.workspace,
    runId: run.runId,
    candidatePlan: run.candidatePlan,
    approvedPlanId: run.approvedPlanId,
  });
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

  const state = readSprintState(opts.stateFile);
  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  for (const taskId of planTaskIds(run.candidatePlan)) {
    const task = taskById.get(taskId);
    if (!task) {
      fail(opts, "PLAN_TASK_MISSING", `planned task ${taskId} no longer exists`, { taskId }, 2);
    }
    const expiresAt = task.claimExpiresAt ? Date.parse(task.claimExpiresAt) : NaN;
    const claimExpired = Number.isFinite(expiresAt) && expiresAt < Date.now();
    if (task.claimedBy !== run.runId || claimExpired) {
      fail(opts, "CLAIM_REQUIRED", `planned task ${taskId} is not actively claimed by ${run.runId}`, {
        taskId,
        claimedBy: task.claimedBy ?? "",
        claimExpiresAt: task.claimExpiresAt ?? "",
      }, 2);
    }
  }

}

async function orchestrateCloseUnlocked(opts) {
  const run = readRun(opts.workDir, opts.runId);
  if (!run) {
    return emitResult(opts, { ok: true, action: "close", message: "no active run" });
  }
  const liveTrack = findLiveTrackedWorker(opts.workDir, opts.runId);
  if (liveTrack) {
    fail(opts, "LIVE_WORKERS", `cannot close while worker ${liveTrack.taskId} is alive; halt or await it first`, {
      taskId: liveTrack.taskId,
      dispatchId: liveTrack.dispatchId ?? "",
    }, 2);
  }
  const expectedPhase = run.phase;
  const expectedUpdatedAt = run.updatedAt;
  const publication = await updateRunAndTracksAtomic(
    opts.workDir,
    opts.runId,
    (currentRun, currentTracks) => {
      if (currentRun?.runId !== run.runId
          || currentRun.phase !== expectedPhase
          || currentRun.updatedAt !== expectedUpdatedAt
          || findLiveTrackedWorker(opts.workDir, opts.runId, currentTracks)) {
        return null;
      }
      const now = new Date().toISOString();
      return {
        run: {
          ...currentRun,
          phase: "done",
          locks: { ...(currentRun.locks ?? {}), executorPid: null },
          candidatePlan: null,
          candidateBacklog: null,
          approvedPlanId: null,
          approvedCommitTasks: [],
          commitApprovalManifest: null,
          commitApprovalManifestHash: null,
          approvedCommitManifest: null,
          approvedCommitManifestHash: null,
          updatedAt: now,
        },
        tracksDoc: { ...currentTracks, runId: run.runId, tracks: [] },
      };
    }
  );
  if (!publication.updated) {
    fail(opts, "RUN_STATE_CHANGED", "run state changed before close could publish; retry after inspecting the latest state", {
      runId: run.runId,
      phase: publication.run?.phase ?? "missing",
    }, 2);
  }
  // Publish the terminal state first. A crash or release failure then leaves a
  // harmless stale claim (fail-closed), never an active run whose claim was
  // already released to a sibling.
  const releaseResult = await sprintBoardExec(
    ["release", "--run-id", run.runId, "--json"],
    opts
  );
  if (releaseResult.exitCode !== 0) {
    fail(opts, "RELEASE_FAILED", releaseResult.stderr || releaseResult.stdout, {
      runId: run.runId,
      phase: "done",
      retry: "orchestrate close --run-id <runId>",
    }, 1);
  }
  clearCheckpoint(opts.workDir, opts.runId);
  clearPlanReview(opts.workDir, opts.runId);
  if (opts.runId) {
    await clearActiveRun(opts.workDir, run.runId);
  }
  await refreshSnapshot(opts);
  return emitResult(opts, { ok: true, action: "close", runId: run.runId });
}

async function orchestrateClose(opts) {
  try {
    return await withPilotFileLock(
      executorLockTarget(opts.workDir, opts.runId),
      () => orchestrateCloseUnlocked(opts),
      { timeoutMs: 2_000 }
    );
  } catch (error) {
    if (error?.name === "TransactionConflictError") {
      fail(opts, "EXECUTOR_BUSY", "cannot close while await-workers owns this run", {
        runId: opts.runId,
      }, 2);
    }
    throw error;
  }
}

export async function applyRecoveryPlan(plan, run, tracksDoc, opts) {
  if (!opts.parsed?.flags?.has("apply") || plan.mutations.length === 0) {
    return { applied: false, mutations: [] };
  }

  let applied = [];
  const publication = await updateRunAndTracksAtomic(
    opts.workDir,
    opts.runId,
    (currentRun, currentTracks) => {
      if (currentRun?.runId !== run.runId
          || isTerminalRunPhase(currentRun.phase)
          || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) {
        return null;
      }
      const now = new Date().toISOString();
      let nextRun = { ...currentRun, locks: { ...(currentRun.locks ?? {}) } };
      let nextTracks = (currentTracks.tracks ?? []).map((track) => ({ ...track }));
      const accepted = [];
      let requeued = false;

      for (const mutation of plan.mutations) {
        if (mutation.type === "clear-executor-lock") {
          nextRun.locks.executorPid = null;
          accepted.push(mutation);
          continue;
        }
        if (mutation.type === "return-to-plan-approval") {
          if (findLiveTrackedWorker(opts.workDir, opts.runId, { ...currentTracks, tracks: nextTracks })) continue;
          if (!["plan-approved", "dispatch-queued", "running"].includes(nextRun.phase)) continue;
          nextRun.approvedPlanId = null;
          nextRun.phase = "awaiting-plan-approval";
          accepted.push(mutation);
          continue;
        }
        if (["settle-track", "requeue-track"].includes(mutation.type)) {
          const index = nextTracks.findIndex((track) => track.taskId === mutation.taskId);
          if (index < 0) continue;
          const track = nextTracks[index];
          if (track.cancelRequestedAt || track.state === "halted") continue;
          if (mutation.expectedDispatchId && track.dispatchId !== mutation.expectedDispatchId) continue;
          if (isTrackWorkerAlive(opts.workDir, opts.runId, track)) continue;
          const lastWorker = track.pid || track.workerToken ? {
            pid: track.pid ?? null,
            workerToken: track.workerToken ?? "",
            dispatchId: track.dispatchId ?? "",
            startedAt: track.startedAt ?? null,
            endedAt: now,
          } : track.lastWorker ?? null;
          nextTracks[index] = mutation.type === "settle-track"
            ? {
              ...track,
              state: "settled",
              pid: null,
              workerToken: "",
              heartbeatFile: "",
              lastWorker,
              resultAction: mutation.resultAction,
              error: mutation.reason,
              lastHeartbeat: now,
            }
            : {
              ...track,
              state: "queued",
              pid: null,
              workerToken: "",
              heartbeatFile: "",
              lastWorker,
              startedAt: null,
              resultStatus: null,
              resultAction: mutation.resultAction,
              error: "",
              lastHeartbeat: now,
            };
          if (mutation.type === "requeue-track") requeued = true;
          accepted.push(mutation);
          continue;
        }
        if (mutation.type === "close-run") {
          if (findLiveTrackedWorker(opts.workDir, opts.runId, { ...currentTracks, tracks: nextTracks })) continue;
          if (nextRun.phase !== "cycle-closed") continue;
          nextRun = {
            ...nextRun,
            phase: "done",
            locks: { ...(nextRun.locks ?? {}), executorPid: null },
            approvedPlanId: null,
            approvedCommitTasks: [],
            candidatePlan: null,
            candidateBacklog: null,
            commitApprovalManifest: null,
            commitApprovalManifestHash: null,
            approvedCommitManifest: null,
            approvedCommitManifestHash: null,
          };
          nextTracks = [];
          accepted.push(mutation);
        }
      }
      if (requeued) {
        if (nextRun.phase === "running") nextRun.phase = "dispatch-queued";
        nextRun.locks.executorPid = null;
      }
      if (accepted.length === 0) return null;
      nextRun.updatedAt = now;
      applied = accepted;
      return {
        run: nextRun,
        tracksDoc: { ...currentTracks, runId: run.runId, tracks: nextTracks },
      };
    }
  );
  if (!publication.updated) applied = [];
  const returnedToApproval = applied.some((mutation) => mutation.type === "return-to-plan-approval");
  const closedRun = applied.some((mutation) => mutation.type === "close-run");
  if (returnedToApproval || closedRun) {
    clearCheckpoint(opts.workDir, opts.runId);
    clearPlanReview(opts.workDir, opts.runId);
  }
  if (closedRun) {
    const releaseResult = await sprintBoardExec(["release", "--run-id", run.runId, "--json"], opts);
    if (releaseResult.exitCode !== 0) {
      throw new Error(`recovery closed ${run.runId} but could not release its claims: ${releaseResult.stderr || releaseResult.stdout}`);
    }
    if (opts.runId) {
      await clearActiveRun(opts.workDir, run.runId);
    }
  }
  if (applied.length > 0) {
    await sprintBoardExec(
      ["journal", "--task", "recovery", "--summary", `orchestrate recover applied ${applied.length} mutation(s)`, "--signals", "orchestrate:recovery"],
      opts
    );
  }
  return { applied: applied.length > 0, mutations: applied };
}

async function orchestrateRecover(opts) {
  const inspectAndApply = async () => {
    // Always rebuild from disk after acquiring the executor boundary. Applying
    // a plan computed before await-workers started would release live claims or
    // overwrite its executor/track state.
    const run = readRun(opts.workDir, opts.runId);
    const tracksDoc = readTracks(opts.workDir, opts.runId);
    const state = readSprintState(opts.stateFile);
    const checkpoint = readCheckpoint(opts.workDir, opts.runId);
    const checkpointStatus = isCheckpointStale(checkpoint, {
      stateFile: opts.stateFile,
      workDir: opts.workDir,
      workspace: opts.workspace,
      runId: run?.runId ?? opts.runId,
      candidatePlan: run?.candidatePlan,
      approvedPlanId: run?.approvedPlanId,
    });
    const directives = readDirectives(opts.workDir, opts.runId);
    const plan = buildRecoveryPlan({
      run,
      tracksDoc,
      state,
      workDir: opts.workDir,
      runSelector: opts.runId,
      checkpointStatus,
      halt: hasHaltDirective(directives),
      trackTimeoutMs: opts.trackTimeout,
    });
    const application = run
      ? await applyRecoveryPlan(plan, run, tracksDoc, opts)
      : { applied: false, mutations: [] };
    return { plan, application };
  };

  let inspection;
  if (opts.parsed?.flags?.has("apply")) {
    try {
      inspection = await withPilotFileLock(
        executorLockTarget(opts.workDir, opts.runId),
        inspectAndApply,
        { timeoutMs: 2_000 }
      );
    } catch (error) {
      if (error?.name === "TransactionConflictError") {
        fail(opts, "RECOVERY_BUSY", "cannot apply recovery while await-workers owns this run", {
          runId: opts.runId,
        }, 2);
      }
      throw error;
    }
  } else {
    inspection = await inspectAndApply();
  }
  const { plan, application } = inspection;
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

/** Rebuild the state/board routing captured by a persisted run. */
export function buildPersistedRunOpts(opts, run) {
  const defaults = resolveDefaults(opts.workDir);
  const persisted = run?.workspace && typeof run.workspace === "object" ? run.workspace : {};
  const workspacePaths = resolveWorkspacePaths(opts.workDir, {
    name: persisted.name ?? "default",
    isolated: persisted.type === "isolated",
    fallback: {
      stateFile: defaults.stateFile,
      boardFile: defaults.boardFile,
      journalFile: defaults.journalFile,
      pitfallsFile: ".va-auto-pilot/pitfalls.json",
    },
  });
  const selectPath = (key) => path.resolve(persisted[key] || workspacePaths[key]);
  return {
    ...opts,
    runId: run.runId,
    stateFile: selectPath("stateFile"),
    boardFile: selectPath("boardFile"),
    journalFile: selectPath("journalFile"),
    pitfallsFile: selectPath("pitfallsFile"),
    workspace: {
      name: persisted.name ?? workspacePaths.name,
      type: persisted.type === "isolated" ? "isolated" : "shared",
      dir: persisted.dir ?? workspacePaths.dir,
      executionTree: persisted.executionTree ?? "isolated",
    },
    sprintBoardLock: Promise.resolve(),
  };
}

/**
 * Scan all active runs and release claims held by runs whose lease has expired
 * (heartbeat older than the claim TTL) AND that have no live track. A run with a
 * running track whose own heartbeat is within the track timeout is NOT considered
 * dead — the worker may still be executing even if the manager has been quiet.
 *
 * @returns {Promise<{ released: Array<{ runId: string, taskIds: string[] }>, skipped: boolean }>}
 */
export async function recoverDeadRunClaims(opts) {
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
    try {
      await withPilotFileLock(executorLockTarget(opts.workDir, entry.runId), async () => {
        const latestEntry = readActiveRuns(opts.workDir).find((item) => item.runId === entry.runId);
        const latestHeartbeatMs = latestEntry?.heartbeatAt ? Date.parse(latestEntry.heartbeatAt) : NaN;
        if (!latestEntry || (Number.isFinite(latestHeartbeatMs) && (Date.now() - latestHeartbeatMs) < ttlMs)) {
          return;
        }
        const persistedRun = readRun(opts.workDir, entry.runId);
        if (!persistedRun) return;
        const checkAt = Date.now();
        const tracksDoc = readTracks(opts.workDir, entry.runId);
        const hasLiveTrack = (tracksDoc?.tracks ?? []).some((track) => {
          if (isTrackWorkerAlive(opts.workDir, entry.runId, track)) return true;
          if (!["starting", "running"].includes(track.state)) return false;
          const trackMs = track.lastHeartbeat ? Date.parse(track.lastHeartbeat) : NaN;
          return Number.isFinite(trackMs) && (checkAt - trackMs) < opts.trackTimeout;
        });
        if (hasLiveTrack) return;

        const runOpts = buildPersistedRunOpts(opts, persistedRun);
        if (!fs.existsSync(runOpts.stateFile)) return;
        const state = readSprintState(runOpts.stateFile);
        const claimedByDead = (state.tasks ?? [])
          .filter((task) => task.claimedBy === entry.runId && task.state !== "Done" && task.state !== "Failed")
          .map((task) => task.id);
        if (claimedByDead.length === 0) return;

        const releaseResult = await sprintBoardExec(
          ["release", "--run-id", entry.runId, "--json"],
          runOpts
        );
        if (releaseResult.exitCode === 0) {
          released.push({ runId: entry.runId, taskIds: claimedByDead });
        }
      }, { timeoutMs: 250 });
    } catch (error) {
      if (error?.name !== "TransactionConflictError") throw error;
      // A live await-workers executor owns the run; leave its claims untouched.
    }
  }

  return { released, skipped: false };
}

async function promoteLegacyRootRun(opts) {
  const rootPaths = orchestrationPaths(opts.workDir);
  fs.mkdirSync(rootPaths.rootDir, { recursive: true });
  const promotionLock = path.join(rootPaths.rootDir, "legacy-root-promotion");
  return withPilotFileLock(executorLockTarget(opts.workDir, ""), () => (
    withPilotFileLock(promotionLock, async () => {
    const legacyRun = readRun(opts.workDir, "");
    if (!legacyRun?.runId || legacyRun.phase === "migrated") {
      return null;
    }
    const legacyTracks = readTracks(opts.workDir, "");
    const liveTrack = findLiveTrackedWorker(opts.workDir, "", legacyTracks);
    if (liveTrack) {
      const error = /** @type {Error & { code: string }} */ (new Error(
        `cannot promote legacy root run while worker ${liveTrack.taskId} is still alive`
      ));
      error.code = "LEGACY_RUN_BUSY";
      throw error;
    }
    const runId = assertSafeRunId(legacyRun.runId);
    const scopedPaths = orchestrationPaths(opts.workDir, runId);
    const completionMarker = path.join(scopedPaths.dir, "legacy-promotion-complete.json");
    if (!fs.existsSync(completionMarker)) {
      fs.mkdirSync(scopedPaths.dir, { recursive: true });
      for (const key of [
        "run",
        "tracks",
        "checkpoint",
        "snapshot",
        "directives",
        "candidateBacklog",
        "candidatePlan",
        "planReview",
      ]) {
        const source = rootPaths[key];
        const destination = scopedPaths[key];
        if (!source || !destination || !fs.existsSync(source)) continue;
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw new Error(`legacy orchestration control file is not a regular file: ${source}`);
        }
        const value = key === "run"
          ? legacyRun
          : JSON.parse(fs.readFileSync(source, "utf8"));
        writeJsonFileAtomicSync(destination, value);
      }
      writeJsonFileAtomicSync(completionMarker, {
        schemaVersion: 1,
        runId,
        source: "legacy-root",
        completedAt: new Date().toISOString(),
      });
    } else {
      const marker = JSON.parse(fs.readFileSync(completionMarker, "utf8"));
      if (marker?.runId !== runId) {
        throw new Error(`legacy promotion marker belongs to another run: ${marker?.runId ?? "missing"}`);
      }
    }
    if (!isTerminalRunPhase(legacyRun.phase)) {
      await writeActiveRun(opts.workDir, {
        runId,
        startedAt: legacyRun.startedAt,
        heartbeatAt: legacyRun.updatedAt ?? legacyRun.startedAt,
      });
    }
    const migrated = await updateRunAndTracksAtomic(opts.workDir, "", (currentRun, currentTracks) => {
      if (currentRun?.runId !== legacyRun.runId
          || currentRun.phase !== legacyRun.phase
          || findLiveTrackedWorker(opts.workDir, "", currentTracks)) {
        return null;
      }
      return {
        run: {
          ...currentRun,
          phase: "migrated",
          migratedTo: runId,
          locks: { ...(currentRun.locks ?? {}), executorPid: null },
          updatedAt: new Date().toISOString(),
        },
        tracksDoc: { ...currentTracks, runId: legacyRun.runId, migratedTo: runId, tracks: [] },
      };
    });
    if (!migrated.updated) {
      const error = /** @type {Error & { code: string }} */ (new Error(
        "legacy root run changed while promotion was publishing"
      ));
      error.code = "LEGACY_PROMOTION_STALE";
      throw error;
    }
    return legacyRun;
    })
  ), { timeoutMs: 2_000 });
}

async function initRunUnlocked(opts) {
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
  const liveLegacyTrack = findLiveTrackedWorker(opts.workDir, "");
  if (liveLegacyTrack) {
    fail(opts, "LEGACY_RUN_BUSY", `cannot initialize while legacy worker ${liveLegacyTrack.taskId} is still alive`, {
      taskId: liveLegacyTrack.taskId,
      dispatchId: liveLegacyTrack.dispatchId ?? "",
    }, 2);
  }
  if (!hasExplicitRunId && !hasExplicitWorkspace) {
    const active = readActiveRuns(opts.workDir);
    const legacyRoot = readRun(opts.workDir, "");
    if (legacyRoot?.runId
        && !isTerminalRunPhase(legacyRoot.phase)
        && !active.some((entry) => entry.runId === legacyRoot.runId)) {
      active.push({
        runId: legacyRoot.runId,
        startedAt: legacyRoot.startedAt ?? "",
        heartbeatAt: legacyRoot.updatedAt ?? legacyRoot.startedAt ?? "",
      });
    }
    if (active.length > 0) {
      const lines = active.map((entry) => `  - ${entry.runId} (heartbeat ${entry.heartbeatAt || "unknown"})`).join("\n");
      fail(opts, "INIT_AMBIGUOUS", `an active run already exists:\n${lines}\n\nChoose explicitly:\n  join shared:    orchestrate init --workspace default\n  isolated sprint: orchestrate init --workspace <name> --isolated\n  specific run:   orchestrate init --run-id <id>`, { activeRuns: active }, 2);
    }
  }

  // Any explicit multi-run choice gets a scoped identity, even when the caller
  // omits --run-id. Keeping such runs at the legacy root would overwrite the
  // zero-config run and clear sibling entries from active.json.
  const explicitMultiRunChoice = Boolean(opts.parsed?.options?.["run-id"])
    || hasExplicitWorkspace;
  if (explicitMultiRunChoice) {
    await promoteLegacyRootRun(opts);
  }
  const scopedRunId = explicitMultiRunChoice ? (opts.runId || createRunId()) : "";
  const runId = scopedRunId || createRunId();
  opts.runId = scopedRunId;
  const liveScopedTrack = scopedRunId
    ? findLiveTrackedWorker(opts.workDir, scopedRunId)
    : null;
  if (liveScopedTrack) {
    fail(opts, "RUN_BUSY", `cannot reinitialize while worker ${liveScopedTrack.taskId} is still alive`, {
      runId: scopedRunId,
      taskId: liveScopedTrack.taskId,
      dispatchId: liveScopedTrack.dispatchId ?? "",
    }, 2);
  }
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
    commitApprovalManifest: null,
    commitApprovalManifestHash: null,
    approvedCommitManifest: null,
    approvedCommitManifestHash: null,
    workspace: {
      ...(opts.workspace ?? { name: "default", type: "shared", executionTree: "isolated" }),
      stateFile: opts.stateFile,
      boardFile: opts.boardFile,
      journalFile: opts.journalFile,
      pitfallsFile: opts.pitfallsFile,
    },
    locks: { executorPid: null },
    startedAt: now,
    updatedAt: now,
  };
  const existingTargetRun = readRun(opts.workDir, scopedRunId);
  if (existingTargetRun && !isTerminalRunPhase(existingTargetRun.phase)) {
    fail(opts, "RUN_ALREADY_ACTIVE", "cannot initialize over an existing non-terminal run", {
      runId: existingTargetRun.runId,
      phase: existingTargetRun.phase,
    }, 2);
  }
  await writeDirectives(opts.workDir, { schemaVersion: 1, runId, directives: [] }, scopedRunId);
  const initialized = await updateRunAndTracksAtomic(opts.workDir, scopedRunId, (currentRun, currentTracks) => {
    if (currentRun && !isTerminalRunPhase(currentRun.phase)) {
      return null;
    }
    return {
      run,
      tracksDoc: { ...currentTracks, runId, tracks: [] },
    };
  });
  if (!initialized.updated) {
    fail(opts, "RUN_ALREADY_ACTIVE", "cannot initialize over an existing non-terminal run", {
      runId: initialized.run?.runId ?? runId,
      phase: initialized.run?.phase ?? "missing",
    }, 2);
  }
  clearCheckpoint(opts.workDir, scopedRunId);
  clearPlanReview(opts.workDir, scopedRunId);
  if (scopedRunId) {
    await writeActiveRun(opts.workDir, {
      runId,
      startedAt: run.startedAt,
      heartbeatAt: now,
    });
  }
  // A legacy root run is intentionally not indexed. Do not clear active.json:
  // another process may have registered a scoped run after the startup guard.
  return run;
}

async function initRun(opts) {
  const initLock = path.join(orchestrationPaths(opts.workDir).rootDir, "init");
  try {
    return await withPilotFileLock(initLock, () => initRunUnlocked(opts), { timeoutMs: 2_000 });
  } catch (error) {
    if (error?.name === "TransactionConflictError") {
      fail(opts, "INIT_BUSY", "another initialization or legacy promotion is active", {}, 2);
    }
    throw error;
  }
}

async function orchestratePlan(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);
  assertActionPhase(run, "plan", opts);

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

  const plannedRun = await transitionRunIfUnchanged(opts, run, (current) => ({
    ...current,
    candidatePlan,
    candidateBacklog: goalBacklogResult.ok
      ? goalBacklogResult.candidateBacklog
      : (current.candidateBacklog ?? null),
    approvedPlanId: null,
    approvedCommitTasks: [],
    commitApprovalManifest: null,
    commitApprovalManifestHash: null,
    approvedCommitManifest: null,
    approvedCommitManifestHash: null,
    phase: "awaiting-plan-approval",
    updatedAt: new Date().toISOString(),
  }), "plan publication", async (current) => {
    // `sprint-board plan --claim-run-id` claims before run publication. A halt
    // may finish between those two operations, so a late plan must compensate
    // for the claim it just created. Restrict cleanup to a fully persisted halt
    // with no live identity; ordinary concurrent replans must keep their claims.
    const halted = current?.runId === run.runId
      && current.phase === "halted"
      && hasHaltDirective(readDirectives(opts.workDir, opts.runId));
    if (!halted || findLiveTrackedWorker(opts.workDir, opts.runId)) {
      return { claimsReleased: false, reason: halted ? "live-worker" : "not-halted" };
    }
    const release = await sprintBoardExec(["release", "--run-id", run.runId, "--json"], opts);
    return {
      claimsReleased: release.exitCode === 0,
      ...(release.exitCode === 0 ? {} : { error: release.stderr || release.stdout }),
    };
  });
  Object.assign(run, plannedRun);
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
  assertActionPhase(run, "review-plan", opts);

  if (!run.candidatePlan?.primaryTaskId) {
    fail(opts, "NO_CANDIDATE_PLAN", "run orchestrate plan first", {}, 2);
  }

  // The previous review ceases to be authoritative as soon as a re-review
  // starts. Clear it before invoking the external reviewer so an interrupted
  // command cannot leave an old PASS available for approve-plan.
  clearPlanReview(opts.workDir, opts.runId);

  // A requested re-review supersedes the old decision immediately. If the new
  // reviewer fails or crashes, the prior checkpoint must not remain dispatchable.
  if (run.phase === "plan-approved") {
    const invalidated = await transitionRunIfUnchanged(opts, run, (current) => ({
      ...current,
      approvedPlanId: null,
      approvedCommitTasks: [],
      commitApprovalManifest: null,
      commitApprovalManifestHash: null,
      approvedCommitManifest: null,
      approvedCommitManifestHash: null,
      phase: "awaiting-plan-approval",
      updatedAt: new Date().toISOString(),
    }), "plan review invalidation");
    Object.assign(run, invalidated);
    clearCheckpoint(opts.workDir, opts.runId);
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

  const reviewedRun = await transitionRunIfUnchanged(opts, run, (current) => ({
    ...current,
    phase: "plan-reviewed",
    updatedAt: new Date().toISOString(),
  }), "plan review publication");
  Object.assign(run, reviewedRun);
  // A crash here leaves plan-reviewed without a matching review artifact, which
  // approve-plan rejects fail-closed. Publishing the PASS before the CAS would
  // leave misleading success evidence when a concurrent halt wins.
  await writePlanReview(opts.workDir, review, opts.runId);

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
    const policyRun = await transitionRunIfUnchanged(opts, run, (current) => ({
      ...current,
      approvalPolicyDecisions: {
        ...(current.approvalPolicyDecisions ?? {}),
        plan: approvalPolicy,
      },
      updatedAt: new Date().toISOString(),
    }), "plan approval-policy publication");
    Object.assign(run, policyRun);
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
  const checkpoint = buildCheckpoint({
    stateFile: opts.stateFile,
    workDir: opts.workDir,
    approvedPlanId: planId,
    candidatePlan: run.candidatePlan,
    workspace: opts.workspace,
    runId: run.runId,
  });
  checkpoint.governance = {
    ...checkpoint.governance,
    approvalMode,
    ...(policyDecision ? { approvalPolicy: policyDecision } : {}),
  };
  const approvedRun = await transitionRunIfUnchanged(opts, run, (current) => ({
    ...current,
    approvedPlanId: planId,
    phase: "plan-approved",
    updatedAt: new Date().toISOString(),
    approvalPolicyDecisions: {
      ...(current.approvalPolicyDecisions ?? {}),
      ...(policyDecision ? { plan: policyDecision } : {}),
    },
  }), "plan approval");
  Object.assign(run, approvedRun);
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
  assertActionPhase(run, "approve-plan", opts);

  if (!run.candidatePlan?.primaryTaskId) {
    fail(opts, "NO_CANDIDATE_PLAN", "run orchestrate plan first", {}, 2);
  }

  const waiveReason = opts.parsed?.options?.["waive-review-with-reason"] ?? "";
  if (opts.parsed?.flags?.has("waive-review") && !waiveReason) {
    fail(opts, "WAIVE_REASON_REQUIRED", "--waive-review is not accepted without --waive-review-with-reason", {}, 2);
  }
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

async function orchestrateDispatchUnlocked(opts) {
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
      dispatchId: crypto.randomUUID(),
      pid: null,
      workerToken: "",
      heartbeatFile: "",
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

  let rejection = "";
  const publication = await updateRunAndTracksAtomic(
    opts.workDir,
    opts.runId,
    (currentRun, currentTracks) => {
      if (currentRun?.runId !== run.runId
          || currentRun.phase !== "plan-approved"
          || currentRun.approvedPlanId !== run.approvedPlanId
          || JSON.stringify(currentRun.candidatePlan ?? null) !== JSON.stringify(run.candidatePlan ?? null)) {
        rejection = "run or approved plan changed while dispatch worktrees were being prepared";
        return null;
      }
      if (hasHaltDirective(readDirectives(opts.workDir, opts.runId))) {
        rejection = "a halt directive arrived while dispatch worktrees were being prepared";
        return null;
      }
      const liveTrack = findLiveTrackedWorker(opts.workDir, opts.runId, currentTracks);
      if (liveTrack) {
        rejection = `worker ${liveTrack.taskId} is still alive`;
        return null;
      }
      const now = new Date().toISOString();
      return {
        run: { ...currentRun, phase: "dispatch-queued", updatedAt: now },
        tracksDoc: { ...currentTracks, runId: run.runId, tracks },
      };
    }
  );
  if (!publication.updated) {
    fail(opts, "DISPATCH_CONTEXT_CHANGED", rejection || "dispatch context changed before publication", {
      runId: run.runId,
      phase: publication.run?.phase ?? "missing",
    }, 2);
  }
  const publishedRun = publication.run;
  await appendGovernanceEvent(opts, publishedRun, "dispatch.queued", {
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
    phase: publishedRun.phase,
    runId: publishedRun.runId,
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

async function orchestrateDispatch(opts) {
  try {
    return await withPilotFileLock(
      executorLockTarget(opts.workDir, opts.runId),
      () => orchestrateDispatchUnlocked(opts),
      { timeoutMs: 2_000 }
    );
  } catch (error) {
    if (error?.name === "TransactionConflictError") {
      fail(opts, "EXECUTOR_BUSY", "cannot dispatch while another executor or recovery owns this run", {
        runId: opts.runId,
      }, 2);
    }
    throw error;
  }
}

async function createBridge(opts, lifecycle = {}) {
  const bridge = new ColonyBridge({
    workDir: opts.workDir,
    // Orchestrated workers need a locally durable READY→persist→GO identity.
    // Colony adapters do not currently expose a crash-safe execution handle,
    // so lifecycle-managed dispatch deliberately uses the spawn supervisor.
    useColony: !opts.noColony && lifecycle.requireSpawnLifecycle !== true,
    ...lifecycle,
  });
  if (!opts.dryRun) {
    await bridge.init();
  }
  return bridge;
}

function createWorkerProcessStartedHandler(opts, tracksDoc) {
  let pendingWrite = Promise.resolve();
  return (event) => {
    const operation = pendingWrite.then(async () => {
      const heartbeatAt = event.startedAt ?? new Date().toISOString();
      const persisted = await updateRunningTrackLiveness(
        opts.workDir,
        opts.runId,
        event.taskId,
        {
          pid: event.pid,
          dispatchId: event.dispatchId,
          workerToken: event.workerToken,
          heartbeatAt,
        }
      );
      if (!persisted.updated) {
        throw new Error(`track ${event.taskId} is ${persisted.state}; refusing to run an untracked worker process`);
      }
      const inMemoryTrack = (tracksDoc.tracks ?? []).find((track) => track.taskId === event.taskId);
      if (inMemoryTrack?.state === "running"
          && (!event.dispatchId || !inMemoryTrack.dispatchId || event.dispatchId === inMemoryTrack.dispatchId)) {
        inMemoryTrack.pid = event.pid;
        inMemoryTrack.workerToken = event.workerToken;
        inMemoryTrack.heartbeatFile = event.heartbeatFile;
        inMemoryTrack.lastHeartbeat = heartbeatAt;
      }
    });
    pendingWrite = operation.catch(() => {});
    return operation;
  };
}

export async function persistSettledWorkerTrack(opts, candidate) {
  const result = await updateTrackAtomic(opts.workDir, opts.runId, candidate.taskId, (current) => {
    if (current.dispatchId && candidate.dispatchId && current.dispatchId !== candidate.dispatchId) {
      const error = /** @type {Error & { code: string }} */ (new Error(
        `worker settlement dispatch mismatch for ${candidate.taskId}: ${candidate.dispatchId} != ${current.dispatchId}`
      ));
      error.code = "TRACK_DISPATCH_STALE";
      throw error;
    }
    if (current.state === "halted" || current.cancelRequestedAt) {
      return {
        ...current,
        state: "halted",
        pid: null,
        workerToken: "",
        heartbeatFile: "",
        lastWorker: candidate.lastWorker ?? current.lastWorker ?? null,
        resultStatus: "cancelled",
        resultAction: "halted",
        approvalFiles: [],
        error: current.error || "halted by intervention",
        lastHeartbeat: candidate.lastHeartbeat ?? new Date().toISOString(),
      };
    }
    return { ...candidate };
  });
  if (!result.updated) {
    const error = /** @type {Error & { code: string }} */ (new Error(
      `worker settlement could not update ${candidate.taskId}: ${result.state}`
    ));
    error.code = "TRACK_SETTLEMENT_STALE";
    throw error;
  }
  return result.track;
}

async function orchestrateAwaitWorkersUnlocked(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);
  if (run.phase !== "dispatch-queued") {
    fail(opts, "INVALID_PHASE", `await-workers requires phase dispatch-queued (current: ${run.phase})`, { phase: run.phase }, 2);
  }

  if (!run.approvedPlanId) {
    fail(opts, "APPROVAL_REQUIRED", "approve-plan required before awaiting workers", {}, 2);
  }
  const checkpoint = readCheckpoint(opts.workDir, opts.runId);
  const stale = isCheckpointStale(checkpoint, {
    stateFile: opts.stateFile,
    workDir: opts.workDir,
    workspace: opts.workspace,
    runId: run.runId,
    candidatePlan: run.candidatePlan,
    approvedPlanId: run.approvedPlanId,
  });
  if (stale.stale) {
    fail(opts, "STALE_CONTEXT", stale.reason, { checkpoint }, 2);
  }

  const tracksDoc = readTracks(opts.workDir, opts.runId);
  const queued = (tracksDoc.tracks ?? []).filter((track) => track.state === "queued");
  if (queued.length === 0) {
    fail(opts, "NO_QUEUED_TRACKS", "no queued tracks; run orchestrate dispatch first", {}, 2);
  }

  if (opts.dryRun) {
    const previewAt = new Date().toISOString();
    const preview = await updateRunAndTracksAtomic(opts.workDir, opts.runId, (currentRun, currentTracks) => {
      if (currentRun?.runId !== run.runId
          || currentRun.phase !== "dispatch-queued"
          || currentRun.updatedAt !== run.updatedAt
          || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) {
        return null;
      }
      const queuedIds = new Set(queued.map((track) => track.taskId));
      return {
        run: { ...currentRun, phase: "dry-run-preview", updatedAt: previewAt },
        tracksDoc: {
          ...currentTracks,
          tracks: (currentTracks.tracks ?? []).map((track) => queuedIds.has(track.taskId)
            ? {
              ...track,
              state: "preview",
              lastHeartbeat: previewAt,
              resultAction: "dry-run-skipped",
            }
            : track),
        },
      };
    });
    if (!preview.updated) {
      fail(opts, "RUN_STATE_CHANGED", "dry-run preview was superseded by a newer run state or halt directive", {
        runId: run.runId,
      }, 2);
    }
    Object.assign(run, preview.run);
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

  const onProcessStarted = createWorkerProcessStartedHandler(opts, tracksDoc);
  const lifecycleDir = resolveWorkerLifecycleDir(opts.workDir, opts.runId);
  const lifecycle = { onProcessStarted, lifecycleDir, requireSpawnLifecycle: true };
  const usesWorktreeIsolation = queued.some((track) => track.worktree?.enabled === true && track.worktree?.path);
  const sharedBridge = usesWorktreeIsolation ? null : await createBridge(opts, lifecycle);
  const gateConfig = readQualityGateConfig();
  const pitfalls = await loadUnresolvedPitfalls(opts);
  const execOpts = {
    ...opts,
    runId: run.runId,
    deferCommit: true,
    observabilityWorkDir: opts.workDir,
    dispatchIds: new Map(queued.map((track) => [track.taskId, track.dispatchId ?? ""])),
    workerOverrides: buildWorkerOverrideCommands(opts.workDir, (workDir) => readWorkerOverrides(workDir, run.runId)),
  };

  const runningRun = await updateRunAtomic(opts.workDir, opts.runId, (current) => {
    if (current?.phase === "halted" || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) return current;
    if (!current || current.runId !== run.runId || current.phase !== "dispatch-queued") {
      const error = /** @type {Error & { code: string }} */ (new Error(
        `run changed before worker start (phase=${current?.phase ?? "missing"})`
      ));
      error.code = "RUN_START_STALE";
      throw error;
    }
    return { ...current, phase: "running", updatedAt: new Date().toISOString() };
  });
  Object.assign(run, runningRun);
  if (run.phase === "halted" || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) {
    if (sharedBridge?.shutdown) await sharedBridge.shutdown();
    await refreshSnapshot(opts);
    return emitResult(opts, {
      ok: true,
      phase: "halted",
      runId: run.runId,
      results: [],
      parallel: 0,
    });
  }

  const now = new Date().toISOString();
  for (const track of queued) {
    const started = await updateTrackAtomic(opts.workDir, opts.runId, track.taskId, (current) => {
      if (current.state === "halted"
          || current.cancelRequestedAt
          || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) return null;
      if (current.state !== "queued"
          || (current.dispatchId && track.dispatchId && current.dispatchId !== track.dispatchId)) {
        const error = /** @type {Error & { code: string }} */ (new Error(
          `track ${track.taskId} changed before worker start (state=${current.state})`
        ));
        error.code = "TRACK_START_STALE";
        throw error;
      }
      return { ...current, state: "running", startedAt: now, lastHeartbeat: now };
    });
    if (started.track) {
      Object.assign(track, started.track);
    }
  }

  const runTrack = async (track) => {
    const latestRun = readRun(opts.workDir, opts.runId);
    const latestTrack = (readTracks(opts.workDir, opts.runId).tracks ?? [])
      .find((item) => item.taskId === track.taskId);
    if (track.state !== "running"
        || latestTrack?.state !== "running"
        || isTerminalRunPhase(latestRun?.phase)
        || hasHaltDirective(readDirectives(opts.workDir, opts.runId))) {
      return { taskId: track.taskId, action: "halted", terminal: true, skipped: true };
    }
    const trackOpts = track.worktree?.enabled === true && track.worktree?.path
      ? buildTrackOpts(execOpts, { workDir: track.worktree.path })
      : execOpts;
    const bridge = track.worktree?.enabled === true && track.worktree?.path
      ? await createBridge(trackOpts, lifecycle)
      : (sharedBridge ?? await createBridge(trackOpts, lifecycle));
    try {
      const result = await executeSingleTask(track.taskId, bridge, pitfalls, gateConfig, trackOpts);
      track.approvalFiles = [...new Set(result?.commitFiles ?? [])].sort();
      track.evidenceBundle = result?.evidenceBundle ?? "";
      track.evidenceFiles = collectEvidenceBundleFiles(opts.workDir, track.evidenceBundle);
      if (track.worktree?.enabled === true && result?.task?.state === "Done") {
        const commitResult = await commitTrackWorktreeResult({
          task: result.task,
          worktree: track.worktree,
        });
        const committedFiles = [...new Set(commitResult.files ?? [])].sort();
        if (!commitResult.committed || !String(commitResult.hash ?? "").trim()) {
          throw new Error(
            `isolated worktree produced no result commit for ${track.taskId}: ${commitResult.reason || "missing commit hash"}`
          );
        }
        if (JSON.stringify(committedFiles) !== JSON.stringify(track.approvalFiles)) {
          throw new Error(
            `worktree commit manifest mismatch for ${track.taskId}: approved ${track.approvalFiles.join(", ") || "<none>"}; committed ${committedFiles.join(", ") || "<none>"}`
          );
        }
        track.worktree.resultCommit = commitResult.hash;
        track.worktree.commitResult = commitResult;
        track.approvalFiles = committedFiles;
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
    const sprintTask = (readSprintState(opts.stateFile).tasks ?? []).find((t) => t.id === track.taskId);
    results.push(settleWorkerTrackOutcome(track, outcome, sprintTask, settledAt));
  }

  for (let index = 0; index < queued.length; index += 1) {
    const persisted = await persistSettledWorkerTrack(opts, queued[index]);
    queued[index] = persisted;
    const trackIndex = (tracksDoc.tracks ?? []).findIndex((track) => track.taskId === persisted.taskId);
    if (trackIndex >= 0) tracksDoc.tracks[trackIndex] = persisted;
    if (persisted.state === "halted") {
      results[index] = { taskId: persisted.taskId, action: "halted", details: persisted.error };
    }
  }

  if (!opts.dryRun && sharedBridge?.shutdown) {
    await sharedBridge.shutdown();
  }

  const stateAfterWorkers = readSprintState(opts.stateFile);
  const runBeforeApproval = readRun(opts.workDir, opts.runId);
  const haltedBeforeApproval = runBeforeApproval?.phase === "halted"
    || hasHaltDirective(readDirectives(opts.workDir, opts.runId));
  const doneTasks = haltedBeforeApproval
    ? []
    : selectCommitReadyTasks(stateAfterWorkers, run.candidatePlan, tracksDoc);
  const failedTracks = (tracksDoc.tracks ?? []).filter((track) => track.resultStatus === "failed");
  let approvalPolicy = null;
  let autoApproval = null;

  run.phase = doneTasks.length > 0
    ? "awaiting-commit-approval"
    : failedTracks.length > 0
      ? "error"
      : "running";
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
    // Bind the manifest only after every approval side effect that changes a
    // manager-owned file (notably the journal). Otherwise an auto-approval
    // invalidates itself before `commit` can consume it.
    const commitApproval = buildCommitApprovalManifest(doneTasks, tracksDoc, opts);
    run.commitApprovalManifest = commitApproval.manifest;
    run.commitApprovalManifestHash = commitApproval.hash;
    run.approvedCommitManifest = null;
    run.approvedCommitManifestHash = null;
    if (approvalPolicy.autoApproved) {
      run.approvedCommitManifest = commitApproval.manifest;
      run.approvedCommitManifestHash = commitApproval.hash;
      run.phase = "commit-approved";
      autoApproval = {
        approvedCommitTasks: run.approvedCommitTasks,
        approvedCommitManifestHash: run.approvedCommitManifestHash,
        approvalPolicy,
      };
      await appendGovernanceEvent(opts, run, "commit.approved", {
        approvalMode: "approvalPolicy",
        approvedCommitTasks: run.approvedCommitTasks,
        approvedCommitManifestHash: run.approvedCommitManifestHash,
        approvalPolicy,
      });
    }
  }
  run.updatedAt = new Date().toISOString();
  const persistedRun = await updateRunAtomic(opts.workDir, opts.runId, (current) => {
    if (!current || current.runId !== run.runId) {
      const error = /** @type {Error & { code: string }} */ (new Error("run changed before worker settlement"));
      error.code = "RUN_SETTLEMENT_STALE";
      throw error;
    }
    if (current.phase === "halted" || isTerminalRunPhase(current.phase)) {
      return {
        ...current,
        approvedCommitTasks: [],
        commitApprovalManifest: null,
        commitApprovalManifestHash: null,
        approvedCommitManifest: null,
        approvedCommitManifestHash: null,
        updatedAt: run.updatedAt,
      };
    }
    return run;
  });
  Object.assign(run, persistedRun);

  const payload = {
    ok: failedTracks.length === 0,
    phase: run.phase,
    runId: run.runId,
    results,
    parallel: queued.length,
    approvalPolicy,
    autoApproval,
  };
  await refreshSnapshot(opts);
  if (failedTracks.length > 0) {
    const error = /** @type {Error & { code: string, failedTracks: any[] }} */ (
      new Error(`${failedTracks.length} worker track(s) failed: ${failedTracks.map((track) => `${track.taskId}: ${track.error || track.resultAction}`).join("; ")}`)
    );
    error.code = "WORKER_TRACK_FAILED";
    error.failedTracks = failedTracks.map((track) => ({
      taskId: track.taskId,
      state: track.state,
      resultStatus: track.resultStatus,
      resultAction: track.resultAction,
      error: track.error ?? "",
    }));
    throw error;
  }
  return emitResult(opts, payload);
}

async function orchestrateAwaitWorkers(opts) {
  const lockTarget = executorLockTarget(opts.workDir, opts.runId);
  try {
    return await withPilotFileLock(lockTarget, async () => {
      const run = readRun(opts.workDir, opts.runId);
      assertRunnablePhase(run, opts);
      const ownedRun = await transitionRunIfUnchanged(opts, run, (current) => ({
        ...current,
        locks: { ...(current.locks ?? {}), executorPid: process.pid },
        updatedAt: new Date().toISOString(),
      }), "await-workers executor acquisition");
      try {
        return await orchestrateAwaitWorkersUnlocked(opts);
      } finally {
        await updateRunAtomic(opts.workDir, opts.runId, (latest) => (
          latest?.runId === ownedRun.runId && latest?.locks?.executorPid === process.pid
            ? {
              ...latest,
              locks: { ...(latest.locks ?? {}), executorPid: null },
              updatedAt: new Date().toISOString(),
            }
            : null
        ));
      }
    }, { timeoutMs: 2_000 });
  } catch (error) {
    if (error?.name === "TransactionConflictError") {
      fail(opts, "EXECUTOR_BUSY", "another await-workers executor is already active for this run", {
        runId: opts.runId,
      }, 2);
    }
    if (error?.code === "WORKER_TRACK_FAILED") {
      fail(opts, "WORKER_TRACK_FAILED", error.message, {
        runId: opts.runId,
        failedTracks: error.failedTracks ?? [],
      }, 1);
    }
    throw error;
  }
}

async function orchestrateApproveCommit(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);

  if (run.phase !== "awaiting-commit-approval") {
    fail(opts, "INVALID_PHASE", `approve-commit requires phase awaiting-commit-approval (current: ${run.phase})`, { phase: run.phase }, 2);
  }

  const tasks = [...new Set(String(opts.tasks || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean))];
  if (tasks.length === 0) {
    fail(opts, "TASKS_REQUIRED", "approve-commit requires --tasks id1,id2", {}, 2);
  }

  const plannedTaskIds = new Set(planTaskIds(run.candidatePlan));
  const state = readSprintState(opts.stateFile);
  const taskById = new Map((state.tasks ?? []).map((task) => [task.id, task]));
  const tracksByTaskId = new Map((readTracks(opts.workDir, opts.runId).tracks ?? []).map((track) => [track.taskId, track]));
  for (const taskId of tasks) {
    const task = taskById.get(taskId);
    if (!task) {
      fail(opts, "TASK_NOT_FOUND", `cannot approve unknown task ${taskId}`, { taskId }, 2);
    }
    if (!plannedTaskIds.has(taskId)) {
      fail(opts, "TASK_NOT_PLANNED", `task ${taskId} is not part of the approved candidate plan`, { taskId }, 2);
    }
    if (task.state !== "Done") {
      fail(opts, "INVALID_STATE", `task ${taskId} must be Done before commit approval (current: ${task.state})`, { taskId, state: task.state }, 2);
    }
    const track = tracksByTaskId.get(taskId);
    const readiness = validateCommitReadyTrack(track);
    if (!readiness.ok) {
      fail(opts, "TRACK_NOT_COMMITTABLE", `task ${taskId} has no successful settled worker result: ${readiness.reason}`, {
        taskId,
        reason: readiness.reason,
        track: track ?? null,
      }, 2);
    }
  }

  const commitApproval = buildCommitApprovalManifest(
    tasks.map((taskId) => taskById.get(taskId)),
    { tracks: [...tracksByTaskId.values()] },
    opts
  );

  const approvedRun = await transitionRunIfUnchanged(opts, run, (current) => ({
    ...current,
    approvedCommitTasks: tasks,
    approvedCommitManifest: commitApproval.manifest,
    approvedCommitManifestHash: commitApproval.hash,
    phase: "commit-approved",
    updatedAt: new Date().toISOString(),
  }), "commit approval");
  Object.assign(run, approvedRun);
  await appendGovernanceEvent(opts, run, "commit.approved", {
    approvalMode: "human",
    approvedCommitTasks: tasks,
    approvedCommitManifestHash: run.approvedCommitManifestHash,
  });

  const payload = {
    ok: true,
    phase: run.phase,
    runId: run.runId,
    approvedCommitTasks: tasks,
    approvedCommitManifestHash: run.approvedCommitManifestHash,
  };
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
  const approvedTaskObjects = [];
  const commits = [];

  for (const taskId of approved) {
    const task = (state.tasks ?? []).find((item) => item.id === taskId);
    if (!task) {
      fail(opts, "TASK_NOT_FOUND", `approved task ${taskId} no longer exists`, { taskId }, 2);
    }
    if (task.state !== "Done") {
      fail(opts, "INVALID_STATE", `task ${taskId} must be Done before commit (current: ${task.state})`, {}, 2);
    }
    approvedTaskObjects.push(task);
    if (opts.dryRun) {
      commits.push({ taskId, dryRun: true });
      continue;
    }
    tasksToCommit.push({ taskId, task });
  }

  const currentApproval = buildCommitApprovalManifest(approvedTaskObjects, tracksDoc, opts);
  if (!opts.waiveApprovals && !run.approvedCommitManifestHash) {
    const resetRun = await transitionRunIfUnchanged(opts, run, (current) => ({
      ...current,
      phase: "awaiting-commit-approval",
      approvedCommitTasks: [],
      approvedCommitManifest: null,
      approvedCommitManifestHash: null,
      updatedAt: new Date().toISOString(),
    }), "commit approval reset");
    Object.assign(run, resetRun);
    fail(opts, "COMMIT_MANIFEST_REQUIRED", "approve-commit must bind an immutable commit manifest before commit", {}, 2);
  }
  if (!opts.waiveApprovals && currentApproval.hash !== run.approvedCommitManifestHash) {
    const expectedManifestHash = run.approvedCommitManifestHash;
    const resetRun = await transitionRunIfUnchanged(opts, run, (current) => ({
      ...current,
      phase: "awaiting-commit-approval",
      approvedCommitTasks: [],
      approvedCommitManifest: null,
      approvedCommitManifestHash: null,
      updatedAt: new Date().toISOString(),
    }), "stale commit approval reset");
    Object.assign(run, resetRun);
    fail(opts, "COMMIT_CONTEXT_STALE", "approved files or base HEAD changed after commit approval", {
      expected: expectedManifestHash,
      current: currentApproval.hash,
    }, 2);
  }
  const allApprovedWorkingTreeFiles = sortedUniqueStrings([
    ...(currentApproval.manifest.managerFiles ?? []),
    ...currentApproval.manifest.tasks.flatMap((entry) => [
      ...(entry.files ?? []),
      ...(entry.evidenceFiles ?? []),
    ]),
  ]);
  const runtimeWorktreePaths = (tracksDoc.tracks ?? [])
    .map((item) => item.worktree?.path)
    .filter(Boolean);
  const runtimeWorktreePrefixes = runtimeWorktreePaths
    .map((worktreePath) => toRepoPath(worktreePath, opts.workDir))
    .filter(Boolean);
  const approvalEntryByTaskId = new Map(
    currentApproval.manifest.tasks.map((entry) => [entry.taskId, entry])
  );
  let expectedIntegrationHead = currentApproval.manifest.baseHead;

  for (const { taskId, task } of tasksToCommit) {
    const track = tracksByTaskId.get(taskId);
    const approvedEntry = approvalEntryByTaskId.get(taskId);
    const observedHead = computeGitHead(opts.workDir);
    let result;
    let worktreeMerge;
    try {
      const lockedCommit = await withSerializedCommit(opts, async () => {
        const latestRun = readRun(opts.workDir, opts.runId);
        if (hasHaltDirective(readDirectives(opts.workDir, opts.runId))
            || isTerminalRunPhase(latestRun?.phase)
            || latestRun?.runId !== run.runId
            || (!opts.waiveApprovals && latestRun.approvedCommitManifestHash !== run.approvedCommitManifestHash)) {
          const error = /** @type {Error & { code: string }} */ (new Error(
            "commit was superseded by a halt or newer approval state"
          ));
          error.code = "COMMIT_SUPERSEDED";
          throw error;
        }
        const lockedHead = computeGitHead(opts.workDir);
        if (expectedIntegrationHead && lockedHead && lockedHead !== expectedIntegrationHead) {
          const error = /** @type {Error & { code: string }} */ (new Error(
            `integration HEAD changed after commit approval: expected ${expectedIntegrationHead}, current ${lockedHead}`
          ));
          error.code = "COMMIT_CONTEXT_STALE";
          throw error;
        }
        let lockedMergeResult = null;
        if (track?.worktree?.enabled === true) {
          await assertCleanIntegrationTree(opts, {
            runtimeWorktreePaths,
          });
          lockedMergeResult = await squashMergeTrackCommitWithRetry({
            opts,
            track,
            taskId,
            observedHead,
          });
        }
        let lockedCommitResult;
        try {
          lockedCommitResult = await finalizeDoneTaskCommit(task, {
            ...opts,
            commitLockHeld: true,
            // The shared run event log is committed at the journal boundary,
            // not inside an individual task's approval manifest.
            deferCommit: true,
            approvedCommitFiles: sortedUniqueStrings([
              ...(track?.approvalFiles ?? []),
              ...(track?.evidenceFiles ?? []),
              ...(currentApproval.manifest.managerFiles ?? []),
            ]),
            allowedUncommittedFiles: allApprovedWorkingTreeFiles,
            allowedUncommittedPrefixes: runtimeWorktreePrefixes,
            approvedCommitFileHashes: {
              ...(currentApproval.manifest.managerFileHashes ?? {}),
              ...(approvedEntry?.fileHashes ?? {}),
              ...(approvedEntry?.evidenceFileHashes ?? {}),
            },
          });
        } catch (error) {
          if (lockedMergeResult?.merged) {
            await rollbackSquashMergedFiles(track, opts);
          }
          throw error;
        }
        if (lockedMergeResult?.merged && !lockedCommitResult.ok) {
          await rollbackSquashMergedFiles(track, opts);
        }
        return {
          result: lockedCommitResult,
          worktreeMerge: lockedMergeResult,
        };
      });
      result = lockedCommit.result;
      worktreeMerge = lockedCommit.worktreeMerge;
      expectedIntegrationHead = computeGitHead(opts.workDir) || expectedIntegrationHead;
    } catch (error) {
      if (error?.code === "COMMIT_SUPERSEDED") {
        fail(opts, "COMMIT_SUPERSEDED", error.message, { taskId }, 2);
      }
      if (error?.code === "COMMIT_CONTEXT_STALE") {
        const latest = await updateRunAtomic(opts.workDir, opts.runId, (current) => (
          current?.runId === run.runId && !isTerminalRunPhase(current.phase)
            ? {
              ...current,
              phase: "awaiting-commit-approval",
              approvedCommitTasks: [],
              approvedCommitManifest: null,
              approvedCommitManifestHash: null,
              updatedAt: new Date().toISOString(),
            }
            : null
        ));
        Object.assign(run, latest ?? run);
        fail(opts, "COMMIT_CONTEXT_STALE", error.message, { taskId }, 2);
      }
      fail(opts, "WORKTREE_MERGE_FAILED", `failed to squash merge ${taskId} worktree result`, {
        taskId,
        worktree: track?.worktree ?? null,
        message: formatErrorMessage(error),
      }, 1);
    }
    commits.push({ taskId, ok: result.ok, details: result.details, hash: result.commitResult?.hash, worktreeMerge });
    if (!result.ok) {
      const latest = await updateRunAtomic(opts.workDir, opts.runId, (current) => (
        current?.runId === run.runId && !isTerminalRunPhase(current.phase)
          ? {
            ...current,
            phase: "awaiting-commit-approval",
            approvedCommitTasks: [],
            approvedCommitManifest: null,
            approvedCommitManifestHash: null,
            updatedAt: new Date().toISOString(),
          }
          : null
      ));
      Object.assign(run, latest ?? run);
      await refreshSnapshot(opts);
      return emitResult(opts, { ok: false, phase: run.phase, runId: run.runId, commits }, 1);
    }
  }

  const failedCommits = commits.filter((commit) => commit.ok === false);
  if (failedCommits.length > 0) {
    const latest = await updateRunAtomic(opts.workDir, opts.runId, (current) => (
      current?.runId === run.runId && !isTerminalRunPhase(current.phase)
        ? {
          ...current,
          phase: "awaiting-commit-approval",
          approvedCommitTasks: [],
          approvedCommitManifest: null,
          approvedCommitManifestHash: null,
          updatedAt: new Date().toISOString(),
        }
        : null
    ));
    Object.assign(run, latest ?? run);
    await refreshSnapshot(opts);
    return emitResult(opts, { ok: false, phase: run.phase, runId: run.runId, commits }, 1);
  }

  const committedRun = await transitionRunIfUnchanged(opts, run, (current) => ({
    ...current,
    phase: "committed",
    approvedCommitManifest: null,
    approvedCommitManifestHash: null,
    updatedAt: new Date().toISOString(),
  }), "commit completion");
  Object.assign(run, committedRun);
  await refreshSnapshot(opts);

  const payload = { ok: true, phase: run.phase, runId: run.runId, commits };
  return emitResult(opts, payload);
}

async function orchestrateJournal(opts) {
  const run = readRun(opts.workDir, opts.runId);
  assertRunnablePhase(run, opts);
  if (run.phase !== "committed") {
    fail(opts, "INVALID_PHASE", `journal requires phase committed (current: ${run.phase})`, {
      phase: run.phase,
    }, 2);
  }

  const state = readSprintState(opts.stateFile);
  const stopCondition = detectStopCondition(state);
  const summary = `orchestrated cycle-boundary: run=${run.runId} phase=${run.phase} stop=${stopCondition.stop}`;

  await sprintBoardExec(
    ["journal", "--task", "cycle-boundary", "--summary", summary, "--signals", `orchestrated:${run.runId}`],
    opts
  );

  const journaledRun = await transitionRunIfUnchanged(opts, run, (current) => ({
    ...current,
    cycle: Number(current.cycle ?? 0) + 1,
    phase: "cycle-closed",
    updatedAt: new Date().toISOString(),
  }), "journal publication");
  Object.assign(run, journaledRun);
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
      opts.stateFile,
      opts.boardFile,
      opts.journalFile,
      opts.pitfallsFile,
      resolveHumanBoardPath(opts.stateFile),
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
      const latestRun = readRun(opts.workDir, opts.runId);
      if (latestRun.phase !== "commit-approved") {
        await orchestrateApproveCommit({ ...opts, tasks: doneTasks.join(","), json: false });
      }
      await orchestrateCommit({ ...opts, waiveApprovals: true, json: false });
    }
    await orchestrateJournal({ ...opts, json: false });
    const stop = detectStopCondition(readSprintState(opts.stateFile));
    if (stop.stop) {
      break;
    }
  }

  const currentFinalRun = readRun(opts.workDir, opts.runId);
  const finalRun = await transitionRunIfUnchanged(opts, currentFinalRun, (current) => ({
    ...current,
    phase: "done",
    updatedAt: new Date().toISOString(),
  }), "unattended run completion");
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

  const destructiveDefaultSelection = subcommand === "close"
    || (subcommand === "recover" && opts.parsed.flags.has("apply"));
  if (destructiveDefaultSelection
      && !opts.parsed.options["run-id"]
      && readActiveRuns(opts.workDir).length > 1) {
    fail(opts, "RUN_ID_REQUIRED", `multiple active runs exist; orchestrate ${subcommand} requires an explicit --run-id`, {}, 2);
  }

  try {
    if (subcommand === "init" || subcommand === "run-unattended") {
      await recoverRunTracksTransaction(opts.workDir, "");
      if (opts.runId) await recoverRunTracksTransaction(opts.workDir, opts.runId);
    } else if (subcommand !== "list-runs") {
      await recoverRunTracksTransaction(opts.workDir, opts.runId);
    }
  } catch (error) {
    fail(opts, error?.code ?? "ORCHESTRATION_TRANSACTION_FAILED", error?.message ?? String(error), {
      runId: opts.runId,
    }, 2);
  }

  // Lease heartbeat: each orchestrate command (except init/list-runs, which manage
  // the index themselves) refreshes this run's heartbeatAt on entry. This is the
  // lease that recover uses to detect dead runs and release their claims. One
  // command = one process, so there is no long-lived daemon to write heartbeats —
  // the command boundary IS the heartbeat.
  // Recovery must observe the persisted lease as-is. Refreshing the selected
  // run here would revive a dead run immediately before recover scans it.
  if (opts.runId && !["init", "list-runs", "recover"].includes(subcommand)) {
    const run = readRun(opts.workDir, opts.runId);
    if (run?.runId) {
      // Heartbeat is best-effort: a short lock timeout (no long backoff) so command
      // latency stays low. If the active-index lock is contended, skip this heartbeat
      // — the lease TTL is宽松 (>= 60min), so a missed beat is harmless. This keeps
      // per-command overhead from compounding in long flows (run-unattended, etc.).
      try {
        await writeActiveRun(opts.workDir, {
          runId: run.runId,
          startedAt: run.startedAt,
          heartbeatAt: new Date().toISOString(),
        }, { timeoutMs: 2000 });
      } catch {
        // lock contention — skip heartbeat, lease TTL covers it
      }
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
