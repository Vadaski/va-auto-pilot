import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { readHumanBoardInstructions, resolveHumanBoardPath } from "./human-board.mjs";
import {
  removeFileDurableSync,
  withPilotFileLock,
  writeJsonFileAtomicSync,
  writeJsonFileDurableAtomicSync,
} from "./pilot-state.mjs";
import { observabilityPaths, OBSERVABILITY_SCHEMA_VERSION } from "./observability.mjs";
import { DEFAULT_TRACK_TIMEOUT_MS } from "./constants.mjs";
import { assertSafeRunId, assertSafeTaskId } from "./identifiers.mjs";

export const ORCHESTRATION_SCHEMA_VERSION = 1;
export const GOVERNANCE_SCHEMA_VERSION = 1;

export { assertSafeRunId } from "./identifiers.mjs";

/** Phases where plan/dispatch/await must not run without a fresh init. */
export const TERMINAL_RUN_PHASES = new Set(["done", "error", "halted", "migrated"]);

export function resolveOrchestrationDir(workDir = process.cwd(), runId = "") {
  const rootDir = path.resolve(workDir, ".va-auto-pilot", "orchestration");
  if (!runId) {
    return rootDir;
  }
  return path.join(rootDir, "runs", assertSafeRunId(runId));
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
    transaction: path.join(dir, "state-transaction.json"),
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

function stateCorrupt(filePath, cause) {
  const error = /** @type {Error & { code: string, cause?: unknown }} */ (new Error(
    `orchestration state is unreadable or invalid: ${filePath}`
  ));
  error.code = "ORCHESTRATION_STATE_CORRUPT";
  error.cause = cause;
  return error;
}

function readJsonFileStrict(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected a JSON object");
    }
    return parsed;
  } catch (cause) {
    throw stateCorrupt(filePath, cause);
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
  const raw = readJsonFileStrict(active, null);
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
  throw stateCorrupt(active, new Error("active index must contain runs[] or a legacy runId"));
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
  return readJsonFileStrict(run, null);
}

export function readTracks(workDir, runId = "") {
  const { tracks } = orchestrationPaths(workDir, runId);
  const value = readJsonFileStrict(tracks, { tracks: [] });
  if (!Array.isArray(value.tracks)) throw stateCorrupt(tracks, new Error("tracks must be an array"));
  return value;
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
  const value = readJsonFileStrict(directives, { schemaVersion: ORCHESTRATION_SCHEMA_VERSION, directives: [] });
  if (!Array.isArray(value.directives)) throw stateCorrupt(directives, new Error("directives must be an array"));
  return value;
}

function ensureOrchestrationDir(workDir, runId = "") {
  fs.mkdirSync(resolveOrchestrationDir(workDir, runId), { recursive: true });
}

function ensureOrchestrationRootDir(workDir) {
  fs.mkdirSync(resolveOrchestrationDir(workDir), { recursive: true });
}

export async function writeActiveRun(workDir, value, lockOptions = {}) {
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
  }, lockOptions);
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

export function resolveWorkerLifecycleDir(workDir, runId = "") {
  return path.join(resolveOrchestrationDir(workDir, runId), "workers");
}

export function resolveWorkerHeartbeatPath(workDir, runId, workerToken) {
  if (!/^[0-9a-f-]{36}$/u.test(String(workerToken ?? ""))) {
    throw new Error(`invalid worker token: ${String(workerToken ?? "")}`);
  }
  return path.join(resolveWorkerLifecycleDir(workDir, runId), `${workerToken}.json`);
}

export function readTrackWorkerHeartbeat(workDir, runId, track) {
  if (!track?.workerToken) return null;
  return readJsonFileStrict(resolveWorkerHeartbeatPath(workDir, runId, track.workerToken), null);
}

export function isTrackWorkerAlive(workDir, runId, track) {
  const pid = Number(track?.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  if (!track?.workerToken) {
    return isProcessTreeAlive(pid) || isProcessAlive(pid); // backward-compatible pre-token runtime state
  }
  const heartbeat = readTrackWorkerHeartbeat(workDir, runId, track);
  const durablePidAlive = isProcessTreeAlive(pid) || isProcessAlive(pid);
  if (!heartbeat) return durablePidAlive;
  if (heartbeat.token !== track.workerToken
      || Number(heartbeat.launcherPid) !== pid
      || !["ready", "launching", "running", "stopping", "terminal"].includes(heartbeat.state)) {
    return durablePidAlive;
  }
  const launcherTreeAlive = isProcessTreeAlive(pid);
  const childPid = Number(heartbeat.childPid);
  const childAlive = Number.isInteger(childPid)
    && childPid > 0
    && (process.platform === "win32" ? isProcessAlive(childPid) : isProcessTreeAlive(childPid));
  // A live process tree with the matching durable token is authoritative even
  // when the launcher itself died and can no longer refresh the heartbeat.
  // False-blocking on a reused process group is safer than duplicate dispatch.
  if (heartbeat.state === "terminal") return childAlive;
  // No process observation can distinguish "died before spawn" from "spawned
  // and died before persisting childPid". Preserve the identity fail-closed.
  if (heartbeat.state === "launching" && !(Number.isInteger(childPid) && childPid > 0)) return true;
  return launcherTreeAlive || childAlive;
}

/**
 * Durable process identity, rather than the advisory track state, decides
 * whether destructive orchestration operations are safe. A halt can leave a
 * track in `halted` while retaining PID/token evidence when that identity is
 * too stale to signal safely; callers must still treat that worker as live.
 */
export function findLiveTrackedWorker(workDir, runId = "", tracksDoc = undefined) {
  const tracks = Array.isArray(tracksDoc?.tracks)
    ? tracksDoc.tracks
    : readTracks(workDir, runId).tracks ?? [];
  return tracks.find((track) => isTrackWorkerAlive(workDir, runId, track)) ?? null;
}

export function isTrackWorkerSignalSafe(workDir, runId, track, maxHeartbeatAgeMs = 30_000) {
  if (!isTrackWorkerAlive(workDir, runId, track)) return false;
  if (!track?.workerToken) return isProcessAlive(Number(track?.pid));
  const heartbeat = readTrackWorkerHeartbeat(workDir, runId, track);
  const pid = Number(track?.pid);
  const updatedMs = Date.parse(heartbeat?.updatedAt ?? "");
  return heartbeat?.token === track.workerToken
    && Number(heartbeat.launcherPid) === pid
    && ["ready", "launching", "running", "stopping"].includes(heartbeat.state)
    && (isProcessTreeAlive(pid) || isProcessAlive(pid))
    && Number.isFinite(updatedMs)
    && Date.now() - updatedMs <= maxHeartbeatAgeMs;
}

export async function updateRunAtomic(workDir, runId, update) {
  if (runId) assertSafeRunId(runId);
  ensureOrchestrationDir(workDir, runId);
  const { run } = orchestrationPaths(workDir, runId);
  return withPilotFileLock(run, async () => {
    const current = readJsonFileStrict(run, null);
    const next = await update(current);
    if (next !== undefined && next !== null) {
      writeJsonFileAtomicSync(run, next);
      return next;
    }
    return current;
  });
}

export async function updateTrackAtomic(workDir, runId, taskId, update) {
  if (runId) assertSafeRunId(runId);
  assertSafeTaskId(taskId);
  ensureOrchestrationDir(workDir, runId);
  const { tracks } = orchestrationPaths(workDir, runId);
  return withPilotFileLock(tracks, async () => {
    const tracksDoc = readJsonFileStrict(tracks, { schemaVersion: ORCHESTRATION_SCHEMA_VERSION, runId, tracks: [] });
    if (!Array.isArray(tracksDoc.tracks)) throw stateCorrupt(tracks, new Error("tracks must be an array"));
    const index = (tracksDoc.tracks ?? []).findIndex((item) => item?.taskId === taskId);
    if (index < 0) {
      return { updated: false, state: "missing", track: null, tracksDoc };
    }
    const current = tracksDoc.tracks[index];
    const next = await update(current, tracksDoc);
    if (next === undefined || next === null) {
      return { updated: false, state: current.state, track: current, tracksDoc };
    }
    tracksDoc.tracks[index] = next;
    writeJsonFileAtomicSync(tracks, tracksDoc);
    return { updated: true, state: next.state, track: next, tracksDoc };
  });
}

function stateHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex");
}

function readTransactionStrict(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || value.schemaVersion !== 1 || value.kind !== "run-tracks") {
      throw new Error("unsupported transaction record");
    }
    for (const key of ["beforeRunHash", "beforeTracksHash", "afterRunHash", "afterTracksHash"]) {
      if (!/^[a-f0-9]{64}$/u.test(String(value[key] ?? ""))) {
        throw new Error(`invalid ${key}`);
      }
    }
    if (!("beforeRun" in value) || !("beforeTracks" in value) || !value.afterRun || !value.afterTracks
        || stateHash(value.beforeRun) !== value.beforeRunHash
        || stateHash(value.beforeTracks) !== value.beforeTracksHash
        || stateHash(value.afterRun) !== value.afterRunHash
        || stateHash(value.afterTracks) !== value.afterTracksHash) {
      throw new Error("transaction payload hash mismatch");
    }
    return value;
  } catch (cause) {
    const error = /** @type {Error & { code: string, cause?: unknown }} */ (new Error(
      `orchestration transaction is unreadable: ${filePath}`
    ));
    error.code = "ORCHESTRATION_TRANSACTION_CORRUPT";
    error.cause = cause;
    throw error;
  }
}

function recoverRunTracksTransactionLocked(workDir, runId, paths) {
  if (!fs.existsSync(paths.transaction)) return { recovered: false, superseded: false };
  const intent = readTransactionStrict(paths.transaction);
  if (intent.runId !== runId) {
    const error = /** @type {Error & { code: string }} */ (new Error(
      `orchestration transaction belongs to ${intent.runId || "legacy-root"}, not ${runId || "legacy-root"}`
    ));
    error.code = "ORCHESTRATION_TRANSACTION_CONFLICT";
    throw error;
  }
  const currentRun = readJsonFileStrict(paths.run, null);
  const currentTracks = readJsonFileStrict(paths.tracks, { tracks: [] });
  if (!Array.isArray(currentTracks.tracks)) throw stateCorrupt(paths.tracks, new Error("tracks must be an array"));
  const runHash = stateHash(currentRun);
  const tracksHash = stateHash(currentTracks);
  const runKnown = [intent.beforeRunHash, intent.afterRunHash].includes(runHash);
  let tracksKnown = [intent.beforeTracksHash, intent.afterTracksHash].includes(tracksHash);
  let recoveredTracks = intent.afterTracks;

  // halt-track can win immediately after a writer crash: it intentionally
  // changes only one matching dispatch while run.json remains at a known side
  // of the transaction. Preserve those authoritative cancellations and replay
  // the rest of the committed intent instead of wedging forever.
  if (!tracksKnown) {
    const beforeByTask = new Map((intent.beforeTracks?.tracks ?? []).map((track) => [track.taskId, track]));
    const afterByTask = new Map((intent.afterTracks?.tracks ?? []).map((track) => [track.taskId, track]));
    const current = currentTracks.tracks ?? [];
    const currentIds = current.map((track) => track.taskId).sort();
    const afterIds = [...afterByTask.keys()].sort();
    if (JSON.stringify(currentIds) === JSON.stringify(afterIds)) {
      let mergeable = true;
      const merged = current.map((track) => {
        const before = beforeByTask.get(track.taskId);
        const after = afterByTask.get(track.taskId);
        if (!after) {
          mergeable = false;
          return track;
        }
        if (stateHash(track) === stateHash(before) || stateHash(track) === stateHash(after)) {
          return after;
        }
        const dispatchMatches = !track.dispatchId
          || track.dispatchId === before?.dispatchId
          || track.dispatchId === after?.dispatchId;
        if (track.state === "halted" && track.cancelRequestedAt && dispatchMatches) {
          return track;
        }
        mergeable = false;
        return track;
      });
      if (mergeable) {
        tracksKnown = true;
        recoveredTracks = { ...intent.afterTracks, tracks: merged };
      }
    }
  }

  // A durable close intent is the commit point. If a concurrent halt-track
  // changed the pre-close document after the crash, replaying the empty terminal
  // track set is safe only when no durable worker identity is live.
  if (!tracksKnown
      && runKnown
      && intent.afterRun?.phase === "done"
      && (intent.afterTracks?.tracks ?? []).length === 0
      && !findLiveTrackedWorker(workDir, runId, currentTracks)) {
    tracksKnown = true;
    recoveredTracks = intent.afterTracks;
  }

  // A halt that won after the writer crashed must never be overwritten by
  // replaying an older dispatch/close intent. Its terminal run state supersedes
  // the incomplete transaction; track-level halt settlement remains authoritative.
  if (!runKnown && isTerminalRunPhase(currentRun?.phase)) {
    removeFileDurableSync(paths.transaction);
    return { recovered: false, superseded: true, run: currentRun, tracksDoc: currentTracks };
  }
  if (!runKnown || !tracksKnown) {
    const error = /** @type {Error & { code: string }} */ (new Error(
      `orchestration transaction conflicts with newer run/track state: ${paths.transaction}`
    ));
    error.code = "ORCHESTRATION_TRANSACTION_CONFLICT";
    throw error;
  }

  writeJsonFileDurableAtomicSync(paths.tracks, recoveredTracks);
  writeJsonFileDurableAtomicSync(paths.run, intent.afterRun);
  removeFileDurableSync(paths.transaction);
  return { recovered: true, superseded: false, run: intent.afterRun, tracksDoc: recoveredTracks };
}

/**
 * Replay a crash-interrupted run/tracks publication. The durable intent is
 * written before either state file and removed only after both directory-sync.
 */
export async function recoverRunTracksTransaction(workDir, runId = "") {
  if (runId) assertSafeRunId(runId);
  ensureOrchestrationDir(workDir, runId);
  const paths = orchestrationPaths(workDir, runId);
  return withPilotFileLock(paths.transaction, () => (
    withPilotFileLock(paths.run, () => (
      withPilotFileLock(paths.tracks, () => recoverRunTracksTransactionLocked(workDir, runId, paths))
    ))
  ));
}

/**
 * Publish run.json and tracks.json as one recoverable logical transaction.
 * The callback executes while both state locks are held and may return null to
 * reject a stale compare-and-swap without changing either file.
 */
export async function updateRunAndTracksAtomic(workDir, runId, update) {
  if (runId) assertSafeRunId(runId);
  ensureOrchestrationDir(workDir, runId);
  const paths = orchestrationPaths(workDir, runId);
  return withPilotFileLock(paths.transaction, () => (
    withPilotFileLock(paths.run, () => (
      withPilotFileLock(paths.tracks, async () => {
        recoverRunTracksTransactionLocked(workDir, runId, paths);
        const currentRun = readJsonFileStrict(paths.run, null);
        const currentTracks = readJsonFileStrict(paths.tracks, {
          schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
          runId: currentRun?.runId ?? runId,
          tracks: [],
        });
        if (!Array.isArray(currentTracks.tracks)) throw stateCorrupt(paths.tracks, new Error("tracks must be an array"));
        const next = await update(currentRun, currentTracks);
        if (!next?.run || !next?.tracksDoc) {
          return { updated: false, run: currentRun, tracksDoc: currentTracks };
        }
        const intent = {
          schemaVersion: 1,
          kind: "run-tracks",
          transactionId: crypto.randomUUID(),
          runId,
          createdAt: new Date().toISOString(),
          beforeRunHash: stateHash(currentRun),
          beforeTracksHash: stateHash(currentTracks),
          afterRunHash: stateHash(next.run),
          afterTracksHash: stateHash(next.tracksDoc),
          beforeRun: currentRun,
          beforeTracks: currentTracks,
          afterRun: next.run,
          afterTracks: next.tracksDoc,
        };
        writeJsonFileDurableAtomicSync(paths.transaction, intent);
        writeJsonFileDurableAtomicSync(paths.tracks, next.tracksDoc);
        writeJsonFileDurableAtomicSync(paths.run, next.run);
        removeFileDurableSync(paths.transaction);
        return { updated: true, run: next.run, tracksDoc: next.tracksDoc };
      })
    ))
  ));
}

export async function appendDirectiveAtomic(workDir, runId, directive) {
  if (runId) assertSafeRunId(runId);
  ensureOrchestrationDir(workDir, runId);
  const { directives } = orchestrationPaths(workDir, runId);
  return withPilotFileLock(directives, async () => {
    const current = readJsonFileStrict(directives, {
      schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
      runId,
      directives: [],
    });
    if (!Array.isArray(current.directives)) throw stateCorrupt(directives, new Error("directives must be an array"));
    current.directives = [...current.directives, directive];
    writeJsonFileAtomicSync(directives, current);
    return current;
  });
}

/**
 * Persist spawn liveness without overwriting concurrent track transitions.
 * The state check and targeted update happen under the tracks-file lock, so a
 * concurrent halt/recovery cannot be silently reverted by an older in-memory
 * tracks document.
 */
export async function updateRunningTrackLiveness(workDir, runId, taskId, value = {}) {
  // Empty runId is the supported legacy-root selector. Non-empty selectors
  // address run-scoped state and must still pass the strict path boundary.
  if (runId) {
    assertSafeRunId(runId);
  }
  assertSafeTaskId(taskId);
  const pid = Number(value.pid);
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new Error(`worker process pid must be a positive integer: ${String(value.pid ?? "")}`);
  }
  const workerToken = String(value.workerToken ?? "");
  if (workerToken) resolveWorkerHeartbeatPath(workDir, runId, workerToken);
  return updateTrackAtomic(workDir, runId, taskId, (track) => {
    if (track.state !== "running") return null;
    if (value.dispatchId && track.dispatchId && value.dispatchId !== track.dispatchId) return null;
    const heartbeatAt = value.heartbeatAt ?? new Date().toISOString();
    return {
      ...track,
      pid,
      dispatchId: value.dispatchId || track.dispatchId || "",
      workerToken,
      heartbeatFile: workerToken ? resolveWorkerHeartbeatPath(workDir, runId, workerToken) : "",
      lastHeartbeat: heartbeatAt,
    };
  }).then((result) => ({
    ...result,
    pid: result.track?.pid ?? null,
    lastHeartbeat: result.track?.lastHeartbeat ?? null,
  }));
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
    version: state.version ?? null,
    projectPrefix: state.projectPrefix ?? "",
    updatedAt: state.updatedAt ?? "",
    tasks: (state.tasks ?? []).map((task) => ({
      id: task.id,
      title: task.title ?? "",
      priority: task.priority ?? "",
      state: task.state,
      owner: task.owner ?? "",
      source: task.source ?? "",
      createdAt: task.createdAt ?? "",
      startedAt: task.startedAt ?? "",
      completedAt: task.completedAt ?? "",
      lastFailedAt: task.lastFailedAt ?? "",
      failCount: task.failCount ?? 0,
      reason: task.reason ?? "",
      verification: task.verification ?? "",
      notes: task.notes ?? "",
      claimedBy: task.claimedBy ?? "",
      claimedAt: task.claimedAt ?? "",
      claimExpiresAt: task.claimExpiresAt ?? "",
      previousClaimedBy: task.previousClaimedBy ?? "",
      reclaimedAt: task.reclaimedAt ?? "",
      permissionPolicy: task.permissionPolicy ?? null,
      review: task.review ?? null,
      testing: task.testing ?? null,
      dependsOn: task.dependsOn ?? [],
      failureDetail: task.failureDetail ?? null,
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
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: workDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function normalizeCheckpointWorkspace(workspace) {
  if (!workspace || typeof workspace !== "object") {
    return null;
  }
  return {
    name: String(workspace.name ?? "default"),
    type: workspace.type === "isolated" ? "isolated" : "shared",
    executionTree: workspace.executionTree === "shared" ? "shared" : "isolated",
  };
}

/**
 * Which inputs invalidate the checkpoint. Bound to the **execution tree** recorded
 * at approval time (not workspace.type): an isolated execution tree builds worktrees
 * from repo HEAD, so HEAD drift after approve-plan means the worker would run against
 * unreviewed code — git-head must invalidate. A shared execution tree shares one
 * checkout where HEAD is expected to move, so git-head drift is not a violation.
 */
function checkpointInvalidatesOn(workspace) {
  return workspace?.executionTree === "shared"
    ? ["sprint-state", "human-board", "runtime-config"]
    : ["sprint-state", "human-board", "runtime-config", "git-head"];
}

function computeRuntimeConfigHash(workDir) {
  const configFile = path.resolve(workDir, ".va-auto-pilot", "config.yaml");
  return fs.existsSync(configFile)
    ? crypto.createHash("sha256").update(fs.readFileSync(configFile)).digest("hex")
    : hashString("<missing-runtime-config>");
}

export function buildCheckpoint({ stateFile, workDir, approvedPlanId, candidatePlan, workspace = undefined, runId = "" }) {
  const obsPaths = observabilityPaths(workDir);
  const checkpointWorkspace = normalizeCheckpointWorkspace(workspace);
  return {
    schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
    approvedPlanId,
    candidatePlan,
    candidatePlanHash: hashString(JSON.stringify(candidatePlan ?? null)),
    workerSelectionHash: hashString(JSON.stringify([...readWorkerOverrides(workDir, runId).entries()].sort())),
    runtimeConfigHash: computeRuntimeConfigHash(workDir),
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
      invalidatesOn: checkpointInvalidatesOn(checkpointWorkspace),
      stalePolicy: "block-dispatch-and-require-approve-plan",
      resumePhase: "plan-approved",
      approvalMode: null,
      approvalPolicy: null,
      ...(checkpointWorkspace ? { workspace: checkpointWorkspace } : {}),
    },
    observability: {
      schemaVersion: OBSERVABILITY_SCHEMA_VERSION,
      eventLogPath: obsPaths.eventsLog,
      evidenceBundleDir: obsPaths.bundlesDir,
      redactedShareableDir: obsPaths.redactedShareableDir,
    },
  };
}

/**
 * Whether git-HEAD drift should invalidate this checkpoint.
 *
 * This decision is bound to the **approval-time** execution tree recorded in the
 * checkpoint (checkpoint.governance.workspace), NOT the current command's flags.
 * The approval contract is: "the approver reviewed code at this HEAD, for this
 * execution-tree mode." Letting the current --shared-tree/--isolated-tree flag
 * override that would let a caller bypass re-approval after HEAD moved — dispatching
 * workers against code the approver never saw. So we read only the checkpoint's
 * recorded workspace. (For legacy checkpoints with no recorded workspace we fall
 * back to enforcing HEAD, the historically safest default.)
 */
function shouldEnforceGitHead(checkpoint) {
  const approvedWorkspace = normalizeCheckpointWorkspace(checkpoint?.governance?.workspace);
  if (!approvedWorkspace) {
    return true; // legacy checkpoint without workspace metadata — enforce HEAD (safe default)
  }
  // shared execution tree: HEAD is expected to move (sibling commits), so drift is
  // not an approval violation. isolated tree: HEAD drift means the reviewed code
  // base changed — must re-approve.
  return approvedWorkspace.executionTree !== "shared";
}

// `workspace` is accepted from callers for API symmetry but intentionally unused:
// HEAD enforcement reads only the approval-time execution tree recorded in the
// checkpoint (see shouldEnforceGitHead), so the current command's flags cannot
// override the approval contract.
export function isCheckpointStale(checkpoint, {
  stateFile,
  workDir,
  workspace: _workspace = undefined,
  runId = "",
  candidatePlan = undefined,
  approvedPlanId = undefined,
}) {
  if (!checkpoint) {
    return { stale: true, reason: "no checkpoint" };
  }
  if (checkpoint.sprintStateHash !== computeSprintStateHash(stateFile)) {
    return { stale: true, reason: "sprint-state changed since approve-plan" };
  }
  if (checkpoint.humanBoardHash !== computeHumanBoardHash(stateFile)) {
    return { stale: true, reason: "human intent changed since approve-plan" };
  }
  if (approvedPlanId !== undefined && checkpoint.approvedPlanId !== approvedPlanId) {
    return { stale: true, reason: "approved plan identity changed since approve-plan" };
  }
  if (candidatePlan !== undefined) {
    const currentPlanHash = hashString(JSON.stringify(candidatePlan ?? null));
    const approvedPlanHash = checkpoint.candidatePlanHash
      ?? hashString(JSON.stringify(checkpoint.candidatePlan ?? null));
    if (currentPlanHash !== approvedPlanHash) {
      return { stale: true, reason: "candidate plan changed since approve-plan" };
    }
  }
  if (!checkpoint.workerSelectionHash) {
    return { stale: true, reason: "checkpoint is missing worker selection binding" };
  }
  const currentWorkerHash = hashString(JSON.stringify([...readWorkerOverrides(workDir, runId).entries()].sort()));
  if (currentWorkerHash !== checkpoint.workerSelectionHash) {
    return { stale: true, reason: "worker selection changed since approve-plan" };
  }
  if (!checkpoint.runtimeConfigHash || checkpoint.runtimeConfigHash !== computeRuntimeConfigHash(workDir)) {
    return { stale: true, reason: "runtime config changed since approve-plan" };
  }
  if (shouldEnforceGitHead(checkpoint)) {
    const head = computeGitHead(workDir);
    if (checkpoint.gitHead && head && checkpoint.gitHead !== head) {
      return { stale: true, reason: "git HEAD changed since approve-plan" };
    }
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

export function isProcessTreeAlive(pid) {
  if (!pid || pid <= 0) return false;
  if (process.platform === "win32") return isProcessAlive(pid);
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
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
 *   workDir?: string,
 *   runSelector?: string,
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

  const executorAlive = Boolean(run.locks?.executorPid && isProcessAlive(run.locks.executorPid));
  const liveTrackedWorker = input.workDir
    ? findLiveTrackedWorker(input.workDir, input.runSelector ?? "", input.tracksDoc)
    : tracks.find((track) => Boolean(track?.pid && isProcessAlive(track.pid))) ?? null;
  const hasLiveOrphanWorker = Boolean(liveTrackedWorker && !executorAlive);
  if (run.locks?.executorPid && !executorAlive) {
    issues.push({ code: "DEAD_EXECUTOR_LOCK", severity: "warning", message: `Executor pid ${run.locks.executorPid} is not alive.` });
    mutations.push({ type: "clear-executor-lock" });
  }

  if (input.checkpointStatus?.stale && ["plan-approved", "dispatch-queued", "running"].includes(run.phase)) {
    issues.push({ code: "STALE_CHECKPOINT", severity: "critical", message: input.checkpointStatus.reason || "checkpoint is stale" });
    if (executorAlive || liveTrackedWorker) {
      nextCommands.push(command(
        "Inspect live execution",
        ["node", "scripts/auto-pilot.mjs", "observe", "--json"],
        "Checkpoint context changed while a durable worker identity is still live; await or halt it before replanning."
      ));
    } else {
      mutations.push({ type: "return-to-plan-approval", reason: input.checkpointStatus.reason || "checkpoint is stale" });
      nextCommands.push(command("Review plan", ["node", "scripts/auto-pilot.mjs", "orchestrate", "review-plan"], "Plan context changed; review before approving again."));
    }
  }

  for (const track of tracks) {
    if (track?.state !== "running") {
      continue;
    }
    // The live await-workers executor owns every running track in this run.
    // Let it settle or cancel them instead of racing recovery against active
    // dispatch before an individual child PID has reached durable state.
    if (executorAlive) {
      continue;
    }
    // A live worker process is authoritative liveness evidence. Recovery must
    // never requeue it merely because the manager stopped refreshing the
    // heartbeat; doing so would allow a sibling run to dispatch the same task
    // while the original worker is still changing its worktree.
    const heartbeatMs = Date.parse(track.lastHeartbeat || track.startedAt || "");
    const heartbeatAgeMs = Number.isFinite(heartbeatMs) ? nowMs - heartbeatMs : null;
    const pidAlive = input.workDir
      ? isTrackWorkerAlive(input.workDir, input.runSelector ?? "", track)
      : Boolean(track.pid && isProcessAlive(track.pid));
    const pidDead = track.pid ? !pidAlive : false;
    const heartbeatExpired = !pidAlive && heartbeatAgeMs !== null && heartbeatAgeMs > trackTimeoutMs;
    const sprintTask = taskById.get(track.taskId);
    if (pidDead || heartbeatExpired || ["Done", "Failed"].includes(sprintTask?.state)) {
      const reason = pidDead
        ? `worker pid ${track.pid} is not alive`
        : heartbeatExpired
          ? `worker heartbeat expired after ${heartbeatAgeMs}ms`
          : `sprint task is already ${sprintTask?.state}`;
      issues.push({ code: "STALE_RUNNING_TRACK", severity: "warning", taskId: track.taskId, message: reason });
      mutations.push(
        !["Done", "Failed"].includes(sprintTask?.state) && (pidDead || heartbeatExpired)
          ? {
            type: "requeue-track",
            taskId: track.taskId,
            expectedDispatchId: track.dispatchId ?? "",
            resultAction: "recovered-stale-track",
            reason,
          }
          : {
            type: "settle-track",
            taskId: track.taskId,
            expectedDispatchId: track.dispatchId ?? "",
            resultAction: "recovered-stale-track",
            reason,
          }
      );
    }
  }

  // A task reaches Done before its approved changes are committed and before the
  // cycle journal is closed. Only cycle-closed proves those two boundaries have
  // completed; commit approval/commit phases must remain resumable in place.
  if (pendingTasks === 0 && run.phase === "cycle-closed") {
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
        nextCommands.push(command("Await workers", ["node", "scripts/auto-pilot.mjs", "orchestrate", "await-workers"], "Queued or running tracks need synchronization."));
        break;
      case "running":
        nextCommands.push(hasLiveOrphanWorker || executorAlive
          ? command("Observe workers", ["node", "scripts/auto-pilot.mjs", "observe", "--json"], "A worker or executor is still live; observe or halt it before recovery.")
          : command("Recover workers", ["node", "scripts/auto-pilot.mjs", "orchestrate", "recover", "--apply"], "The executor is gone; recover stale tracks before awaiting again."));
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
