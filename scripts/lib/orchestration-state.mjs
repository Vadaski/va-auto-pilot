import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { readHumanBoardInstructions, resolveHumanBoardPath } from "./human-board.mjs";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./pilot-state.mjs";
import { observabilityPaths, OBSERVABILITY_SCHEMA_VERSION } from "./observability.mjs";
import { DEFAULT_TRACK_TIMEOUT_MS } from "./constants.mjs";

export const ORCHESTRATION_SCHEMA_VERSION = 1;
export const GOVERNANCE_SCHEMA_VERSION = 1;

/** Phases where plan/dispatch/await must not run without a fresh init. */
export const TERMINAL_RUN_PHASES = new Set(["done", "error", "halted"]);

export function resolveOrchestrationDir(workDir = process.cwd(), runId = "") {
  const rootDir = path.resolve(workDir, ".va-auto-pilot", "orchestration");
  if (!runId) {
    return rootDir;
  }
  return path.join(rootDir, "runs", String(runId));
}

export function orchestrationPaths(workDir = process.cwd(), runId = "") {
  const rootDir = resolveOrchestrationDir(workDir);
  const dir = resolveOrchestrationDir(workDir, runId);
  return {
    rootDir,
    dir,
    runsDir: path.join(rootDir, "runs"),
    active: path.join(rootDir, "active.json"),
    run: path.join(dir, "run.json"),
    tracks: path.join(dir, "tracks.json"),
    checkpoint: path.join(dir, "checkpoint.json"),
    snapshot: path.join(dir, "snapshot.json"),
    directives: path.join(dir, "directives.json"),
    candidateBacklog: path.join(dir, "candidate-backlog.json"),
    candidatePlan: path.join(dir, "candidate-plan.json"),
    planReview: path.join(dir, "plan-review.json"),
  };
}

function readJsonFile(filePath, fallback) {
  if (!fs.existsSync(filePath)) {
    return fallback;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * active.json is a run *index table* (list), not a single-run pointer.
 * Shape: { schemaVersion: 1, runs: [{ runId, startedAt, heartbeatAt }] }
 * Newest entry wins for "default active run" resolution. Closing a run
 * removes only its entry — other live runs stay reachable (bug: close used
 * to delete the whole file, orphaning sibling runs).
 * Legacy single-object shape ({ runId, ... }) is tolerated on read for
 * backward compatibility with state written before this change.
 */
const ACTIVE_SCHEMA_VERSION = 1;

function readActiveIndex(workDir) {
  const { active } = orchestrationPaths(workDir);
  const raw = readJsonFile(active, null);
  if (!raw) {
    return { schemaVersion: ACTIVE_SCHEMA_VERSION, runs: [] };
  }
  // Tolerate legacy single-object shape.
  if (Array.isArray(raw?.runs)) {
    return { schemaVersion: ACTIVE_SCHEMA_VERSION, ...raw, runs: raw.runs };
  }
  if (raw?.runId) {
    return {
      schemaVersion: ACTIVE_SCHEMA_VERSION,
      runs: [{ runId: raw.runId, startedAt: raw.startedAt ?? "", heartbeatAt: raw.heartbeatAt ?? raw.startedAt ?? "" }],
    };
  }
  return { schemaVersion: ACTIVE_SCHEMA_VERSION, runs: [] };
}

export function readActiveRun(workDir = process.cwd()) {
  const index = readActiveIndex(workDir);
  if (index.runs.length === 0) {
    return null;
  }
  // Newest heartbeat wins.
  const latest = index.runs.reduce((best, entry) =>
    String(entry?.heartbeatAt ?? "") > String(best?.heartbeatAt ?? "") ? entry : best
  );
  return latest ?? null;
}

export function readActiveRuns(workDir = process.cwd()) {
  return readActiveIndex(workDir).runs.filter((entry) => entry && typeof entry.runId === "string");
}

export function resolveActiveRunId(workDir = process.cwd()) {
  const runId = readActiveRun(workDir)?.runId;
  return typeof runId === "string" ? runId : "";
}

export function readRun(workDir, runId = "") {
  const { run } = orchestrationPaths(workDir, runId);
  return readJsonFile(run, null);
}

export function readTracks(workDir, runId = "") {
  const { tracks } = orchestrationPaths(workDir, runId);
  return readJsonFile(tracks, { tracks: [] });
}

export function readCheckpoint(workDir, runId = "") {
  const { checkpoint } = orchestrationPaths(workDir, runId);
  return readJsonFile(checkpoint, null);
}

export function readCandidateBacklog(workDir, runId = "") {
  const { candidateBacklog } = orchestrationPaths(workDir, runId);
  return readJsonFile(candidateBacklog, null);
}

export function readDirectives(workDir, runId = "") {
  const { directives } = orchestrationPaths(workDir, runId);
  return readJsonFile(directives, { schemaVersion: ORCHESTRATION_SCHEMA_VERSION, directives: [] });
}

function ensureOrchestrationDir(workDir, runId = "") {
  fs.mkdirSync(resolveOrchestrationDir(workDir, runId), { recursive: true });
}

function ensureOrchestrationRootDir(workDir) {
  fs.mkdirSync(resolveOrchestrationDir(workDir), { recursive: true });
}

export async function writeActiveRun(workDir, value) {
  ensureOrchestrationRootDir(workDir);
  const { active } = orchestrationPaths(workDir);
  const entry = {
    runId: String(value?.runId ?? ""),
    startedAt: value?.startedAt ?? "",
    heartbeatAt: value?.heartbeatAt ?? value?.startedAt ?? "",
  };
  if (!entry.runId) {
    return false;
  }
  await withPilotFileLock(active, async () => {
    const index = readActiveIndex(workDir);
    const others = index.runs.filter((item) => item?.runId !== entry.runId);
    index.runs = [...others, entry];
    writeJsonFileAtomicSync(active, index);
  });
  return true;
}

export async function clearActiveRun(workDir, runId = "") {
  const { active } = orchestrationPaths(workDir);
  if (!fs.existsSync(active)) {
    return false;
  }
  // Serialize read-check-write under the same lock writeActiveRun uses,
  // so concurrent close(run-a) + init(run-b) cannot orphan run-b's entry.
  let removed = false;
  await withPilotFileLock(active, async () => {
    const index = readActiveIndex(workDir);
    const before = index.runs.length;
    index.runs = runId
      ? index.runs.filter((item) => item?.runId !== runId)
      : [];
    removed = index.runs.length < before;
    if (index.runs.length === 0) {
      if (fs.existsSync(active)) {
        fs.unlinkSync(active);
      }
    } else {
      writeJsonFileAtomicSync(active, index);
    }
  });
  return removed;
}

export async function writeRun(workDir, value, runId = "") {
  ensureOrchestrationDir(workDir, runId);
  const { run } = orchestrationPaths(workDir, runId);
  await withPilotFileLock(run, async () => {
    writeJsonFileAtomicSync(run, value);
  });
}

export async function writeTracks(workDir, value, runId = "") {
  ensureOrchestrationDir(workDir, runId);
  const { tracks } = orchestrationPaths(workDir, runId);
  await withPilotFileLock(tracks, async () => {
    writeJsonFileAtomicSync(tracks, value);
  });
}

export async function writeCheckpoint(workDir, value, runId = "") {
  ensureOrchestrationDir(workDir, runId);
  const { checkpoint } = orchestrationPaths(workDir, runId);
  await withPilotFileLock(checkpoint, async () => {
    writeJsonFileAtomicSync(checkpoint, value);
  });
}

export async function writeDirectives(workDir, value, runId = "") {
  ensureOrchestrationDir(workDir, runId);
  const { directives } = orchestrationPaths(workDir, runId);
  await withPilotFileLock(directives, async () => {
    writeJsonFileAtomicSync(directives, value);
  });
}

export async function writeSnapshot(workDir, value, runId = "") {
  ensureOrchestrationDir(workDir, runId);
  const { snapshot } = orchestrationPaths(workDir, runId);
  await withPilotFileLock(snapshot, async () => {
    writeJsonFileAtomicSync(snapshot, value);
  });
}

export async function writeCandidateBacklog(workDir, value, runId = "") {
  ensureOrchestrationDir(workDir, runId);
  const { candidateBacklog } = orchestrationPaths(workDir, runId);
  await withPilotFileLock(candidateBacklog, async () => {
    writeJsonFileAtomicSync(candidateBacklog, value);
  });
}

export function readSprintStateFile(stateFile) {
  const resolved = path.resolve(stateFile);
  if (!fs.existsSync(resolved)) {
    return { tasks: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(resolved, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : { tasks: [] };
  } catch {
    return { tasks: [] };
  }
}

export function hashString(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

export function computeSprintStateHash(stateFile) {
  const state = readSprintStateFile(stateFile);
  const normalized = {
    updatedAt: state.updatedAt ?? "",
    tasks: (state.tasks ?? []).map((task) => ({
      id: task.id,
      state: task.state,
      failCount: task.failCount ?? 0,
      dependsOn: task.dependsOn ?? [],
    })),
  };
  return hashString(JSON.stringify(normalized));
}

export function computeHumanBoardHash(stateFile) {
  const boardPath = resolveHumanBoardPath(stateFile);
  const instructions = readHumanBoardInstructions(boardPath);
  return hashString(JSON.stringify(instructions));
}

export function computeGitHead(workDir) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: workDir, encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

export function buildCheckpoint({ stateFile, workDir, approvedPlanId, candidatePlan }) {
  const obsPaths = observabilityPaths(workDir);
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    approvedPlanId,
    candidatePlan,
    sprintStateHash: computeSprintStateHash(stateFile),
    humanBoardHash: computeHumanBoardHash(stateFile),
    gitHead: computeGitHead(workDir),
    createdAt: new Date().toISOString(),
    governance: {
      schemaVersion: GOVERNANCE_SCHEMA_VERSION,
      checkpointId: approvedPlanId,
      decisionPoint: "plan.approved",
      approvalScope: ["plan", "dispatch"],
      requiredBefore: "dispatch",
      invalidatesOn: ["sprint-state", "human-board", "git-head"],
      stalePolicy: "block-dispatch-and-require-approve-plan",
      resumePhase: "plan-approved",
    },
    observability: {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      eventLogPath: obsPaths.eventsLog,
      evidenceBundleDir: obsPaths.bundlesDir,
      redactedShareableDir: obsPaths.redactedShareableDir,
    },
  };
}

export function isCheckpointStale(checkpoint, { stateFile, workDir }) {
  if (!checkpoint) {
    return { stale: true, reason: "no checkpoint" };
  }
  if (checkpoint.sprintStateHash !== computeSprintStateHash(stateFile)) {
    return { stale: true, reason: "sprint-state changed since approve-plan" };
  }
  if (checkpoint.humanBoardHash !== computeHumanBoardHash(stateFile)) {
    return { stale: true, reason: "human intent changed since approve-plan" };
  }
  const head = computeGitHead(workDir);
  if (checkpoint.gitHead && head && checkpoint.gitHead !== head) {
    return { stale: true, reason: "git HEAD changed since approve-plan" };
  }
  return { stale: false, reason: "" };
}

export function hasHaltDirective(directivesDoc) {
  const list = Array.isArray(directivesDoc?.directives) ? directivesDoc.directives : [];
  return list.some((item) => item?.type === "halt-run" || item?.halt === true);
}

export function createRunId() {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `run-${stamp}-${crypto.randomUUID().slice(0, 8)}`;
}

export function createPlanId() {
  return `plan-${crypto.randomUUID().slice(0, 12)}`;
}

/** @returns {Map<string, string>} taskId → worker id */
export function readWorkerOverrides(workDir, runId = "") {
  const doc = readDirectives(workDir, runId);
  const list = Array.isArray(doc.directives) ? doc.directives : [];
  const overrides = new Map();
  for (const item of list) {
    if (item?.type === "set-worker" && item.taskId && item.worker) {
      overrides.set(String(item.taskId), String(item.worker));
    }
  }
  return overrides;
}

export function isProcessAlive(pid) {
  if (!pid || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function assertActiveRun(run, runId) {
  if (!run) {
    const error = /** @type {Error & { code: string }} */ (
      new Error("No active orchestration run. Run: auto-pilot orchestrate init")
    );
    error.code = "NO_ACTIVE_RUN";
    throw error;
  }
  if (runId && run.runId !== runId) {
    const error = /** @type {Error & { code: string }} */ (
      new Error(`Run ID mismatch: expected ${runId}, active ${run.runId}`)
    );
    error.code = "RUN_ID_MISMATCH";
    throw error;
  }
}

export function isTerminalRunPhase(phase) {
  return TERMINAL_RUN_PHASES.has(phase);
}

function command(label, argv, reason) {
  return { label, argv, reason };
}

/**
 * Build a deterministic recovery plan for an interrupted orchestrated run.
 *
 * @param {{
 *   run?: any,
 *   tracksDoc?: { tracks?: any[] },
 *   state?: { tasks?: any[] },
 *   checkpointStatus?: { stale: boolean, reason: string },
 *   halt?: boolean,
 *   nowMs?: number,
 *   trackTimeoutMs?: number,
 * }} input
 */
export function buildRecoveryPlan(input = {}) {
  const run = input.run ?? null;
  const tracks = Array.isArray(input.tracksDoc?.tracks) ? input.tracksDoc.tracks : [];
  const tasks = Array.isArray(input.state?.tasks) ? input.state.tasks : [];
  const pendingTasks = tasks.filter((task) => task?.state !== "Done").length;
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  const nowMs = Number.isFinite(input.nowMs) ? input.nowMs : Date.now();
  const trackTimeoutMs = Number.isFinite(input.trackTimeoutMs) ? input.trackTimeoutMs : DEFAULT_TRACK_TIMEOUT_MS;
  const issues = [];
  const mutations = [];
  const nextCommands = [];

  if (!run) {
    issues.push({ code: "NO_ACTIVE_RUN", severity: pendingTasks > 0 ? "warning" : "info", message: "No active orchestration run exists." });
    nextCommands.push(command("Start run", ["node", "scripts/auto-pilot.mjs", "orchestrate", "init"], "Create an orchestration run before planning."));
    return { ok: true, status: pendingTasks > 0 ? "recoverable" : "idle", issues, mutations, nextCommands };
  }

  if (isTerminalRunPhase(run.phase)) {
    issues.push({ code: "RUN_TERMINAL", severity: "info", message: `Run phase is ${run.phase}.` });
    nextCommands.push(command("Start run", ["node", "scripts/auto-pilot.mjs", "orchestrate", "init"], "Terminal runs do not resume in place."));
    return { ok: true, status: "idle", issues, mutations, nextCommands };
  }

  if (input.halt) {
    issues.push({ code: "HALT_DIRECTIVE", severity: "warning", message: "A halt-run directive is active." });
    nextCommands.push(command("Inspect halt", ["node", "scripts/auto-pilot.mjs", "observe", "--json"], "Clear or supersede the halt directive before continuing."));
  }

  if (run.locks?.executorPid && !isProcessAlive(run.locks.executorPid)) {
    issues.push({ code: "DEAD_EXECUTOR_LOCK", severity: "warning", message: `Executor pid ${run.locks.executorPid} is not alive.` });
    mutations.push({ type: "clear-executor-lock" });
  }

  if (input.checkpointStatus?.stale && ["plan-approved", "dispatch-queued", "running"].includes(run.phase)) {
    issues.push({ code: "STALE_CHECKPOINT", severity: "critical", message: input.checkpointStatus.reason || "checkpoint is stale" });
    mutations.push({ type: "return-to-plan-approval", reason: input.checkpointStatus.reason || "checkpoint is stale" });
    nextCommands.push(command("Review plan", ["node", "scripts/auto-pilot.mjs", "orchestrate", "review-plan"], "Plan context changed; review before approving again."));
  }

  for (const track of tracks) {
    if (track?.state !== "running") {
      continue;
    }
    const startedMs = Date.parse(track.startedAt || track.lastHeartbeat || "");
    const heartbeatAgeMs = Number.isFinite(startedMs) ? nowMs - startedMs : null;
    const pidDead = track.pid ? !isProcessAlive(track.pid) : false;
    const heartbeatExpired = heartbeatAgeMs !== null && heartbeatAgeMs > trackTimeoutMs;
    const sprintTask = taskById.get(track.taskId);
    if (pidDead || heartbeatExpired || ["Done", "Failed"].includes(sprintTask?.state)) {
      const reason = pidDead
        ? `worker pid ${track.pid} is not alive`
        : heartbeatExpired
          ? `worker heartbeat expired after ${heartbeatAgeMs}ms`
          : `sprint task is already ${sprintTask?.state}`;
      issues.push({ code: "STALE_RUNNING_TRACK", severity: "warning", taskId: track.taskId, message: reason });
      mutations.push({ type: "settle-track", taskId: track.taskId, resultAction: "recovered-stale-track", reason });
    }
  }

  if (pendingTasks === 0 && run.phase !== "done") {
    issues.push({ code: "STALE_RUN_NO_PENDING_TASKS", severity: "warning", message: `Run phase is ${run.phase}, but sprint has no pending tasks.` });
    mutations.push({ type: "close-run" });
    nextCommands.push(command("Close run", ["node", "scripts/auto-pilot.mjs", "orchestrate", "recover", "--apply"], "Close stale run state."));
  }

  if (nextCommands.length === 0) {
    switch (run.phase) {
      case "initialized":
      case "cycle-closed":
        nextCommands.push(command("Plan", ["node", "scripts/auto-pilot.mjs", "orchestrate", "plan"], "Run is ready to plan."));
        break;
      case "awaiting-plan-approval":
        nextCommands.push(command("Review plan", ["node", "scripts/auto-pilot.mjs", "orchestrate", "review-plan"], "Plan needs review before approval."));
        break;
      case "plan-reviewed":
        nextCommands.push(command("Approve plan", ["node", "scripts/auto-pilot.mjs", "orchestrate", "approve-plan"], "Reviewed plan is ready for approval."));
        break;
      case "plan-approved":
        nextCommands.push(command("Dispatch", ["node", "scripts/auto-pilot.mjs", "orchestrate", "dispatch"], "Approved plan is ready to dispatch."));
        break;
      case "dispatch-queued":
      case "running":
        nextCommands.push(command("Await workers", ["node", "scripts/auto-pilot.mjs", "orchestrate", "await-workers"], "Queued or running tracks need synchronization."));
        break;
      case "awaiting-commit-approval":
        nextCommands.push(command("Approve commit", ["node", "scripts/auto-pilot.mjs", "orchestrate", "approve-commit", "--tasks", "<ids>"], "Completed tasks need commit approval."));
        break;
      case "commit-approved":
        nextCommands.push(command("Commit", ["node", "scripts/auto-pilot.mjs", "orchestrate", "commit"], "Commit approval has been granted."));
        break;
      case "committed":
        nextCommands.push(command("Journal", ["node", "scripts/auto-pilot.mjs", "orchestrate", "journal"], "Record cycle boundary and close the cycle."));
        break;
      default:
        nextCommands.push(command("Observe", ["node", "scripts/auto-pilot.mjs", "observe", "--json"], "Inspect current orchestration state."));
        break;
    }
  }

  const hasCritical = issues.some((issue) => issue.severity === "critical");
  return {
    ok: !hasCritical,
    status: mutations.length > 0 ? "recoverable" : "ready",
    issues,
    mutations,
    nextCommands,
  };
}

export function clearCheckpoint(workDir, runId = "") {
  const { checkpoint } = orchestrationPaths(workDir, runId);
  if (fs.existsSync(checkpoint)) {
    fs.unlinkSync(checkpoint);
  }
}
