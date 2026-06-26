import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

import { readHumanBoardInstructions, resolveHumanBoardPath } from "./human-board.mjs";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./pilot-state.mjs";
import { observabilityPaths, OBSERVABILITY_SCHEMA_VERSION } from "./observability.mjs";

export const ORCHESTRATION_SCHEMA_VERSION = 1;

/** Phases where plan/dispatch/await must not run without a fresh init. */
export const TERMINAL_RUN_PHASES = new Set(["done", "error", "halted"]);

export function resolveOrchestrationDir(workDir = process.cwd()) {
  return path.resolve(workDir, ".va-auto-pilot", "orchestration");
}

export function orchestrationPaths(workDir = process.cwd()) {
  const dir = resolveOrchestrationDir(workDir);
  return {
    dir,
    run: path.join(dir, "run.json"),
    tracks: path.join(dir, "tracks.json"),
    checkpoint: path.join(dir, "checkpoint.json"),
    snapshot: path.join(dir, "snapshot.json"),
    directives: path.join(dir, "directives.json"),
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

export function readRun(workDir) {
  const { run } = orchestrationPaths(workDir);
  return readJsonFile(run, null);
}

export function readTracks(workDir) {
  const { tracks } = orchestrationPaths(workDir);
  return readJsonFile(tracks, { tracks: [] });
}

export function readCheckpoint(workDir) {
  const { checkpoint } = orchestrationPaths(workDir);
  return readJsonFile(checkpoint, null);
}

export function readDirectives(workDir) {
  const { directives } = orchestrationPaths(workDir);
  return readJsonFile(directives, { schemaVersion: ORCHESTRATION_SCHEMA_VERSION, directives: [] });
}

function ensureOrchestrationDir(workDir) {
  fs.mkdirSync(resolveOrchestrationDir(workDir), { recursive: true });
}

export async function writeRun(workDir, value) {
  ensureOrchestrationDir(workDir);
  const { run } = orchestrationPaths(workDir);
  await withPilotFileLock(run, async () => {
    writeJsonFileAtomicSync(run, value);
  });
}

export async function writeTracks(workDir, value) {
  ensureOrchestrationDir(workDir);
  const { tracks } = orchestrationPaths(workDir);
  await withPilotFileLock(tracks, async () => {
    writeJsonFileAtomicSync(tracks, value);
  });
}

export async function writeCheckpoint(workDir, value) {
  ensureOrchestrationDir(workDir);
  const { checkpoint } = orchestrationPaths(workDir);
  await withPilotFileLock(checkpoint, async () => {
    writeJsonFileAtomicSync(checkpoint, value);
  });
}

export async function writeDirectives(workDir, value) {
  ensureOrchestrationDir(workDir);
  const { directives } = orchestrationPaths(workDir);
  await withPilotFileLock(directives, async () => {
    writeJsonFileAtomicSync(directives, value);
  });
}

export async function writeSnapshot(workDir, value) {
  ensureOrchestrationDir(workDir);
  const { snapshot } = orchestrationPaths(workDir);
  await withPilotFileLock(snapshot, async () => {
    writeJsonFileAtomicSync(snapshot, value);
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
    return { stale: true, reason: "human-board changed since approve-plan" };
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
export function readWorkerOverrides(workDir) {
  const doc = readDirectives(workDir);
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

export function clearCheckpoint(workDir) {
  const { checkpoint } = orchestrationPaths(workDir);
  if (fs.existsSync(checkpoint)) {
    fs.unlinkSync(checkpoint);
  }
}
