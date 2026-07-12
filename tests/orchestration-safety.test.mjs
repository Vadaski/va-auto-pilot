import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { autoCommitTask } from "../scripts/auto-pilot-loop.mjs";
import {
  assertCleanIntegrationTree,
  buildCommitApprovalManifest,
  collectEvidenceBundleFiles,
  persistSettledWorkerTrack,
  recoverDeadRunClaims,
  selectCommitReadyTasks,
  settleWorkerTrackOutcome,
  validateCommitReadyTrack,
  validateOrchestrationActionPhase,
} from "../scripts/auto-pilot-orchestrate.mjs";
import { ColonyBridge } from "../scripts/lib/colony-bridge.mjs";
import { acquireLock, releaseLock } from "../scripts/lib/doc-store/locking.mjs";
import {
  buildCheckpoint,
  buildRecoveryPlan,
  isCheckpointStale,
  isTrackWorkerSignalSafe,
  orchestrationPaths,
  readActiveRuns,
  resolveOrchestrationDir,
  resolveWorkerHeartbeatPath,
  updateRunningTrackLiveness,
  writeActiveRun,
  writeDirectives,
  writeRun,
  writeTracks,
} from "../scripts/lib/orchestration-state.mjs";
import { taskEvidenceBundleDir } from "../scripts/lib/observability.mjs";
import { classifyCommandPermission, detectOutOfScopeFiles } from "../scripts/lib/permission-scope.mjs";
import { withPilotFileLock } from "../scripts/lib/pilot-state.mjs";
import { runPlanReviewCommand, validatePlanReviewForApprove } from "../scripts/lib/plan-review.mjs";
import { normalizeTask } from "../scripts/lib/sprint-board/core.mjs";
import { prepareTrackWorktree } from "../scripts/lib/worktree-isolation.mjs";
import { resolveWorkspacePaths, writeWorkspace } from "../scripts/lib/workspace.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_PILOT = path.join(REPO_ROOT, "scripts", "auto-pilot.mjs");
const SPRINT_BOARD = path.join(REPO_ROOT, "scripts", "sprint-board.mjs");

function runNode(cwd, script, args) {
  return spawnSync(process.execPath, [script, ...args], { cwd, encoding: "utf8" });
}

function runNodeAsync(cwd, script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("close", (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

async function waitForCondition(predicate, timeoutMs = 30_000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`condition was not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function writeState(root, tasks) {
  const stateFile = path.join(root, ".va-auto-pilot", "sprint-state.json");
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify({ version: 1, projectPrefix: "AP", updatedAt: "2026-07-09T00:00:00.000Z", tasks }, null, 2)}\n`);
  return stateFile;
}

test("run and task identifiers cannot escape their managed roots", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-id-safety-"));
  assert.throws(() => resolveOrchestrationDir(root, "../../../../escaped"), /Invalid run ID/);
  assert.throws(() => taskEvidenceBundleDir(root, "run-safe", "/tmp/escaped-task"), /Invalid task ID/);
  assert.equal(normalizeTask({ id: "历史:任务/一", title: "legacy" }).id, "历史:任务/一");
  assert.throws(() => taskEvidenceBundleDir(root, "run-safe", "AP..001"), /Invalid task ID/);
});

test("worker liveness persists for the supported legacy-root run selector", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-root-run-liveness-"));
  await writeTracks(root, {
    runId: "generated-root-run",
    tracks: [{ taskId: "AP-001", state: "running", pid: null, lastHeartbeat: null }],
  });

  const heartbeatAt = "2026-07-09T00:00:00.000Z";
  const result = await updateRunningTrackLiveness(root, "", "AP-001", {
    pid: process.pid,
    heartbeatAt,
  });
  assert.equal(result.updated, true);

  const stored = JSON.parse(fs.readFileSync(
    path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"),
    "utf8"
  ));
  assert.equal(stored.tracks[0].pid, process.pid);
  assert.equal(stored.tracks[0].lastHeartbeat, heartbeatAt);

  await writeTracks(root, {
    runId: "generated-root-run",
    tracks: [{ taskId: "AP-001", dispatchId: "new-attempt", state: "running", pid: null }],
  });
  const stale = await updateRunningTrackLiveness(root, "", "AP-001", {
    pid: process.pid,
    dispatchId: "old-attempt",
    heartbeatAt,
  });
  assert.equal(stale.updated, false);
  const afterStale = JSON.parse(fs.readFileSync(
    path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"),
    "utf8"
  ));
  assert.equal(afterStale.tracks[0].pid, null);
});

test("fresh mismatched worker heartbeat never authorizes process signalling", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-worker-signal-identity-"));
  const runId = "run-signal-identity";
  const workerToken = "11111111-1111-4111-8111-111111111111";
  const heartbeatFile = resolveWorkerHeartbeatPath(root, runId, workerToken);
  fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
  fs.writeFileSync(heartbeatFile, `${JSON.stringify({
    token: "22222222-2222-4222-8222-222222222222",
    launcherPid: process.pid,
    state: "running",
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);

  assert.equal(isTrackWorkerSignalSafe(root, runId, {
    pid: process.pid,
    workerToken,
  }), false);
});

test("halt-run retries termination for a halted track with durable live identity", async (t) => {
  if (process.platform === "win32") {
    t.skip("the regression uses POSIX process groups");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-halt-retry-"));
  const runId = "run-halt-retry";
  const workerToken = "33333333-3333-4333-8333-333333333333";
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  t.after(() => {
    try { process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
  });
  await waitForCondition(() => {
    try { process.kill(child.pid, 0); return true; } catch { return false; }
  });

  writeState(root, [{
    id: "AP-001",
    title: "halt retry",
    priority: "P1",
    state: "Backlog",
    claimedBy: runId,
    claimedAt: new Date().toISOString(),
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  await writeRun(root, {
    schemaVersion: 1,
    runId,
    phase: "halted",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, runId);
  const heartbeatFile = resolveWorkerHeartbeatPath(root, runId, workerToken);
  fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
  fs.writeFileSync(heartbeatFile, `${JSON.stringify({
    token: workerToken,
    launcherPid: child.pid,
    childPid: null,
    state: "running",
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
  await writeTracks(root, {
    schemaVersion: 1,
    runId,
    tracks: [{
      taskId: "AP-001",
      dispatchId: "dispatch-halt-retry",
      state: "halted",
      cancelRequestedAt: new Date().toISOString(),
      pid: child.pid,
      workerToken,
      heartbeatFile,
      resultStatus: "cancelled",
      resultAction: "halted",
      approvalFiles: [],
    }],
  }, runId);
  await writeDirectives(root, {
    schemaVersion: 1,
    runId,
    directives: [{ type: "halt-run", halt: true, at: new Date().toISOString() }],
  }, runId);

  const retry = await runNodeAsync(root, AUTO_PILOT, [
    "intervene", "halt-run", "--run-id", runId, "--json",
  ]);
  assert.equal(retry.status, 0, retry.stderr);
  const payload = JSON.parse(retry.stdout);
  assert.equal(payload.claimReleaseDeferred, false);
  assert.equal(payload.claimsReleased, true);
  await waitForCondition(() => {
    try { process.kill(child.pid, 0); return false; } catch { return true; }
  });
  const storedTrack = JSON.parse(fs.readFileSync(orchestrationPaths(root, runId).tracks, "utf8")).tracks[0];
  assert.equal(storedTrack.pid, null);
  assert.equal(storedTrack.workerToken, "");
  assert.equal(JSON.parse(fs.readFileSync(
    path.join(root, ".va-auto-pilot", "sprint-state.json"),
    "utf8"
  )).tasks[0].claimedBy, "");
});

test("worker settlement preserves a concurrent halt and clears active PID identity", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-halt-settlement-"));
  const runId = "run-halt-settlement";
  await writeTracks(root, {
    runId,
    tracks: [{
      taskId: "AP-001",
      dispatchId: "dispatch-1",
      state: "halted",
      cancelRequestedAt: "2026-07-09T00:00:00.000Z",
      pid: 12345,
      workerToken: "11111111-1111-4111-8111-111111111111",
      approvalFiles: [],
    }],
  }, runId);

  const persisted = await persistSettledWorkerTrack({ workDir: root, runId }, {
    taskId: "AP-001",
    dispatchId: "dispatch-1",
    state: "settled",
    pid: null,
    workerToken: "",
    heartbeatFile: "",
    lastWorker: { pid: 12345, dispatchId: "dispatch-1" },
    resultStatus: "succeeded",
    resultAction: "awaiting-commit-approval",
    approvalFiles: ["AP-001.txt"],
    lastHeartbeat: "2026-07-09T00:00:01.000Z",
  });

  assert.equal(persisted.state, "halted");
  assert.equal(persisted.pid, null);
  assert.equal(persisted.workerToken, "");
  assert.equal(persisted.resultStatus, "cancelled");
  assert.deepEqual(persisted.approvalFiles, []);
  assert.equal(persisted.lastWorker.pid, 12345);
});

test("permission heuristics cannot allow destructive variants before opt-in", () => {
  const policy = {
    fileScopes: [{ path: "src/**", access: "read" }],
    commands: {
      allow: ["rm ", "git "],
      deny: [],
      destructiveRequiresOptIn: true,
      destructiveAllow: [],
    },
  };
  assert.equal(classifyCommandPermission("rm -r -f dist", policy).action, "requires-opt-in");
  assert.equal(classifyCommandPermission("git -C . reset --hard HEAD", policy).action, "requires-opt-in");
  assert.equal(classifyCommandPermission("node -e 'fs.rmSync(\"dist\", {recursive:true})'", policy).action, "requires-opt-in");
  assert.deepEqual(detectOutOfScopeFiles(["src/index.js"], policy), ["src/index.js"]);
});

test("plan review requires one unambiguous final PASS marker", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-empty-plan-review-"));
  const reviewer = path.join(root, "empty-review.mjs");
  const runReviewer = async (source) => {
    fs.writeFileSync(reviewer, source, "utf8");
    return runPlanReviewCommand({
      workDir: root,
      candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
      runId: "run-review",
      reviewCommand: `${process.execPath} ${reviewer}`,
    });
  };

  const empty = await runReviewer("// intentionally empty reviewer output\n");
  assert.equal(empty.exitCode, 0);
  assert.equal(empty.hasStructuredOutput, false);
  assert.equal(empty.passed, false);

  const promptEcho = await runReviewer("process.stdout.write(process.env.VA_PLAN_REVIEW_PROMPT ?? '');\n");
  assert.equal(promptEcho.passed, false);

  const warningOnly = await runReviewer("console.log('WARNING: needs follow-up');\n");
  assert.equal(warningOnly.passed, false);

  const conflicting = await runReviewer("console.log('PLAN REVIEW STATUS: PASS\\nPLAN REVIEW STATUS: FAIL');\n");
  assert.equal(conflicting.status, null);
  assert.equal(conflicting.passed, false);

  const passed = await runReviewer("console.log('WARNING: non-blocking\\nPLAN REVIEW STATUS: PASS');\n");
  assert.equal(passed.status, "PASS");
  assert.equal(passed.passed, true);

  const stdoutPassWithDiagnostics = await runReviewer([
    "console.log('PLAN REVIEW STATUS: PASS');",
    "console.error('tokens used\\n9,195');",
    "",
  ].join("\n"));
  assert.equal(stdoutPassWithDiagnostics.status, "PASS");
  assert.equal(stdoutPassWithDiagnostics.passed, true);

  const conflictingStreams = await runReviewer([
    "console.log('PLAN REVIEW STATUS: PASS');",
    "console.error('PLAN REVIEW STATUS: FAIL\\ntokens used: 9,195');",
    "",
  ].join("\n"));
  assert.equal(conflictingStreams.status, null);
  assert.equal(conflictingStreams.passed, false);

  const conflictingCarriageReturn = await runReviewer([
    "console.log('PLAN REVIEW STATUS: PASS');",
    "process.stderr.write('PLAN REVIEW STATUS: FAIL\\rdiagnostic');",
    "",
  ].join("\n"));
  assert.equal(conflictingCarriageReturn.status, null);
  assert.equal(conflictingCarriageReturn.passed, false);

  assert.equal(validatePlanReviewForApprove({
    review: { ...passed, status: undefined },
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    runId: "run-review",
  }).ok, false);
});

test("corrupt workspace metadata falls back without recursive stack overflow", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-workspace-corrupt-"));
  const workspaceDir = path.join(root, ".va-auto-pilot", "workspaces", "feature-a");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(path.join(workspaceDir, "workspace.json"), "{not-json", "utf8");

  const workspace = resolveWorkspacePaths(root, { name: "feature-a", isolated: true });
  assert.equal(workspace.type, "isolated");
  assert.equal(workspace.existed, false);
  assert.equal(workspace.stateFile, path.join(workspaceDir, "sprint-state.json"));
});

test("workspace names cannot alias or escape the managed workspace root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-workspace-path-"));
  assert.throws(() => resolveWorkspacePaths(root, { name: "..", isolated: true }), /Invalid workspace name/);
  assert.throws(() => resolveWorkspacePaths(root, { name: ".", isolated: true }), /Invalid workspace name/);
  assert.throws(() => resolveWorkspacePaths(root, { name: "a..b", isolated: true }), /Invalid workspace name/);
  const safe = resolveWorkspacePaths(root, { name: "feature-a", isolated: true });
  assert.ok(safe.dir.startsWith(`${path.join(root, ".va-auto-pilot", "workspaces")}${path.sep}`));
});

test("explicit shared workspace gets a scoped run without erasing active siblings", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-active-preserve-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--run-id", "run-a", "--json"]);
  assert.equal(first.status, 0, first.stderr);

  const second = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--workspace", "default", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const secondRun = JSON.parse(second.stdout).run;
  assert.equal(secondRun.workspace.type, "shared");
  assert.notEqual(secondRun.runId, "run-a");
  assert.deepEqual(
    readActiveRuns(root).map((entry) => entry.runId).sort(),
    ["run-a", secondRun.runId].sort()
  );
  assert.equal(fs.existsSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json")), false);
});

test("a zero-config root run is promoted before a scoped sibling is created", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-root-run-promotion-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstRun = JSON.parse(first.stdout).run;

  const ambiguous = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.stderr, /INIT_AMBIGUOUS/);

  const second = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--workspace", "default", "--json"]);
  assert.equal(second.status, 0, second.stderr);
  const secondRun = JSON.parse(second.stdout).run;
  assert.ok(fs.existsSync(path.join(
    root,
    ".va-auto-pilot",
    "orchestration",
    "runs",
    firstRun.runId,
    "run.json"
  )));
  assert.deepEqual(
    readActiveRuns(root).map((entry) => entry.runId).sort(),
    [firstRun.runId, secondRun.runId].sort()
  );
});

test("legacy-root promotion cannot snapshot a live root executor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-root-promotion-busy-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstRun = JSON.parse(first.stdout).run;
  const lockTarget = `${orchestrationPaths(root).run}.executor`;

  await withPilotFileLock(lockTarget, async () => {
    const blocked = runNode(root, AUTO_PILOT, [
      "orchestrate", "init", "--workspace", "default", "--json",
    ]);
    assert.notEqual(blocked.status, 0);
    assert.equal(fs.existsSync(path.join(
      root,
      ".va-auto-pilot",
      "orchestration",
      "runs",
      firstRun.runId,
      "run.json"
    )), false);
  });

  const promoted = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--workspace", "default", "--json",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  const tombstone = JSON.parse(fs.readFileSync(orchestrationPaths(root).run, "utf8"));
  assert.equal(tombstone.phase, "migrated");
  assert.equal(tombstone.migratedTo, firstRun.runId);
});

test("legacy-root promotion rejects an orphan worker whose launcher is still alive", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-root-promotion-worker-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstRun = JSON.parse(first.stdout).run;
  await writeTracks(root, {
    runId: firstRun.runId,
    tracks: [{ taskId: "AP-001", state: "running", pid: process.pid, lastHeartbeat: new Date().toISOString() }],
  });

  const blocked = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--workspace", "default", "--json",
  ]);
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /LEGACY_RUN_BUSY/);
  assert.equal(fs.existsSync(path.join(
    root,
    ".va-auto-pilot",
    "orchestration",
    "runs",
    firstRun.runId,
    "run.json"
  )), false);

  await writeTracks(root, { runId: firstRun.runId, tracks: [] });
  const promoted = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--workspace", "default", "--json",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
});

test("legacy-root promotion repairs a partial scoped copy before tombstoning root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-root-promotion-partial-"));
  const first = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(first.status, 0, first.stderr);
  const firstRun = JSON.parse(first.stdout).run;
  const scoped = orchestrationPaths(root, firstRun.runId);
  fs.mkdirSync(scoped.dir, { recursive: true });
  fs.writeFileSync(scoped.run, JSON.stringify({ runId: firstRun.runId, phase: "partial" }));

  const promoted = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--workspace", "default", "--json",
  ]);
  assert.equal(promoted.status, 0, promoted.stderr);
  assert.equal(JSON.parse(fs.readFileSync(scoped.run, "utf8")).phase, firstRun.phase);
  assert.equal(fs.existsSync(scoped.tracks), true);
  assert.equal(fs.existsSync(path.join(scoped.dir, "legacy-promotion-complete.json")), true);
  assert.equal(JSON.parse(fs.readFileSync(orchestrationPaths(root).run, "utf8")).phase, "migrated");
});

test("run-scoped commands rebind to the workspace persisted by init", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-workspace-rebind-"));
  const init = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--workspace", "feature-a", "--isolated", "--run-id", "run-feature", "--json",
  ]);
  assert.equal(init.status, 0, init.stderr);

  const stateFile = path.join(root, ".va-auto-pilot", "workspaces", "feature-a", "sprint-state.json");
  fs.writeFileSync(stateFile, `${JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    tasks: [{ id: "AP-001", title: "workspace task", priority: "P1", state: "Backlog", dependsOn: [] }],
  }, null, 2)}\n`);

  const plan = runNode(root, AUTO_PILOT, ["orchestrate", "plan", "--run-id", "run-feature", "--json"]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).candidatePlan.primaryTaskId, "AP-001");
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.tasks[0].claimedBy, "run-feature");
});

test("a plan losing publication to halt compensates its late task claim", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-plan-halt-claim-race-"));
  const runId = "run-plan-halt-race";
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "late plan claim",
    priority: "P1",
    state: "Backlog",
    dependsOn: [],
  }]);
  const init = runNode(root, AUTO_PILOT, [
    "orchestrate", "init", "--run-id", runId, "--json",
  ]);
  assert.equal(init.status, 0, init.stderr);
  const paths = orchestrationPaths(root, runId);
  const activePath = orchestrationPaths(root).active;
  const initialHeartbeat = JSON.parse(fs.readFileSync(activePath, "utf8")).runs
    .find((entry) => entry.runId === runId)?.heartbeatAt;
  let planCompletion;
  let stateLock = await acquireLock(`${path.resolve(stateFile)}.lock`);

  try {
    planCompletion = runNodeAsync(root, AUTO_PILOT, [
      "orchestrate", "plan", "--run-id", runId, "--json",
    ]);
    await waitForCondition(() => {
      const active = JSON.parse(fs.readFileSync(activePath, "utf8"));
      return active.runs.find((entry) => entry.runId === runId)?.heartbeatAt !== initialHeartbeat;
    });
    await withPilotFileLock(paths.run, async () => {
      await releaseLock(stateLock);
      stateLock = null;
      await waitForCondition(() => {
        const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
        return state.tasks[0].claimedBy === runId;
      });
      const current = JSON.parse(fs.readFileSync(paths.run, "utf8"));
      fs.writeFileSync(paths.run, `${JSON.stringify({
        ...current,
        phase: "halted",
        updatedAt: new Date().toISOString(),
      }, null, 2)}\n`);
      await writeDirectives(root, {
        schemaVersion: 1,
        runId,
        directives: [{ type: "halt-run", halt: true, at: new Date().toISOString() }],
      }, runId);
    });
  } finally {
    if (stateLock) await releaseLock(stateLock);
  }

  const result = await planCompletion;
  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.equal(JSON.parse(result.stderr).error.code, "RUN_STATE_CHANGED");
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).tasks[0].claimedBy, "");
});

test("dead-run recovery releases claims from each run's persisted workspace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-recover-workspaces-"));
  const rootState = writeState(root, [{
    id: "AP-001",
    title: "shared claim",
    priority: "P1",
    state: "Backlog",
    claimedBy: "run-shared",
    claimExpiresAt: "2020-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  const isolatedDir = path.join(root, ".va-auto-pilot", "workspaces", "feature-a");
  const isolatedState = path.join(isolatedDir, "sprint-state.json");
  fs.mkdirSync(isolatedDir, { recursive: true });
  fs.writeFileSync(isolatedState, `${JSON.stringify({
    version: 1,
    projectPrefix: "AP",
    tasks: [{
      id: "AP-002",
      title: "isolated claim",
      priority: "P1",
      state: "Backlog",
      claimedBy: "run-isolated",
      claimExpiresAt: "2020-01-01T00:00:00.000Z",
      dependsOn: [],
    }],
  }, null, 2)}\n`);
  await writeWorkspace(root, {
    name: "feature-a",
    type: "isolated",
    stateFile: isolatedState,
    boardFile: path.join(isolatedDir, "sprint.md"),
    journalFile: path.join(isolatedDir, "run-journal.md"),
    pitfallsFile: path.join(isolatedDir, "pitfalls.json"),
    executionTree: "isolated",
  });

  for (const [runId, workspace] of [
    ["run-shared", { name: "default", type: "shared", executionTree: "isolated" }],
    ["run-isolated", { name: "feature-a", type: "isolated", executionTree: "isolated" }],
  ]) {
    await writeRun(root, { runId, workspace, phase: "plan-approved" }, runId);
    await writeTracks(root, { runId, tracks: [] }, runId);
    await writeActiveRun(root, {
      runId,
      startedAt: "2020-01-01T00:00:00.000Z",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
    });
  }

  const recovery = await recoverDeadRunClaims({
    workDir: root,
    stateFile: rootState,
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, "docs", "todo", "run-journal.md"),
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    trackTimeout: 1_000,
    sprintBoardLock: Promise.resolve(),
  });

  assert.deepEqual(recovery.released.map((entry) => entry.runId).sort(), ["run-isolated", "run-shared"]);
  assert.equal(JSON.parse(fs.readFileSync(rootState, "utf8")).tasks[0].claimedBy, "");
  assert.equal(JSON.parse(fs.readFileSync(isolatedState, "utf8")).tasks[0].claimedBy, "");
});

test("recover immediately finalizes a terminal run shutdown tail without waiting for claim TTL", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-terminal-recover-"));
  const runId = "run-terminal-crash";
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "terminal claim",
    priority: "P0",
    state: "Backlog",
    claimedBy: runId,
    claimedAt: new Date().toISOString(),
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  await writeRun(root, {
    schemaVersion: 1,
    runId,
    phase: "done",
    locks: { executorPid: null },
    workspace: {
      name: "default",
      type: "shared",
      dir: root,
      executionTree: "shared",
      stateFile,
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    },
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, runId);
  await writeTracks(root, { schemaVersion: 1, runId, tracks: [] }, runId);
  await writeActiveRun(root, {
    runId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });
  const paths = orchestrationPaths(root, runId);
  fs.writeFileSync(paths.checkpoint, `${JSON.stringify({ approvedPlanId: "stale-plan" })}\n`);
  fs.writeFileSync(paths.planReview, `${JSON.stringify({ status: "PASS" })}\n`);

  const recovered = runNode(root, AUTO_PILOT, [
    "orchestrate", "recover", "--apply", "--run-id", runId, "--json",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const payload = JSON.parse(recovered.stdout);
  assert.equal(payload.terminalFinalization.changed, true);
  assert.deepEqual(payload.terminalFinalization.releasedTaskIds, ["AP-001"]);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).tasks[0].claimedBy, "");
  assert.equal(readActiveRuns(root).some((entry) => entry.runId === runId), false);
  assert.equal(fs.existsSync(paths.checkpoint), false);
  assert.equal(fs.existsSync(paths.planReview), false);

  const retry = runNode(root, AUTO_PILOT, [
    "orchestrate", "recover", "--apply", "--run-id", runId, "--json",
  ]);
  assert.equal(retry.status, 0, retry.stderr);
  assert.equal(JSON.parse(retry.stdout).terminalFinalization.changed, false);

  const rejectedPlan = runNode(root, AUTO_PILOT, [
    "orchestrate", "plan", "--run-id", runId, "--json",
  ]);
  assert.notEqual(rejectedPlan.status, 0);
  assert.equal(readActiveRuns(root).some((entry) => entry.runId === runId), false);

  const init = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(init.status, 0, init.stderr);
});

test("dead-run scan removes a fresh terminal active entry even when it has no claims", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-terminal-no-claims-"));
  const runId = "run-terminal-no-claims";
  const stateFile = writeState(root, []);
  await writeRun(root, {
    schemaVersion: 1,
    runId,
    phase: "done",
    locks: { executorPid: null },
    workspace: {
      name: "default",
      type: "shared",
      dir: root,
      executionTree: "shared",
      stateFile,
    },
  }, runId);
  await writeTracks(root, { schemaVersion: 1, runId, tracks: [] }, runId);
  await writeActiveRun(root, {
    runId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });

  const result = await recoverDeadRunClaims({
    workDir: root,
    stateFile,
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, "docs", "todo", "run-journal.md"),
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    trackTimeout: 1_000,
    sprintBoardLock: Promise.resolve(),
  });

  assert.deepEqual(result.released, []);
  assert.deepEqual(result.finalized, [{ runId, changed: true, activeRemoved: true }]);
  assert.equal(readActiveRuns(root).some((entry) => entry.runId === runId), false);
});

test("recover does not finalize halted runs with a fresh lease", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-halted-not-done-"));
  const runId = "run-halted-not-done";
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "halted claim",
    priority: "P0",
    state: "Backlog",
    claimedBy: runId,
    claimedAt: new Date().toISOString(),
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  await writeRun(root, {
    schemaVersion: 1,
    runId,
    phase: "halted",
    locks: { executorPid: null },
    workspace: { name: "default", type: "shared", executionTree: "shared", stateFile },
  }, runId);
  await writeTracks(root, { schemaVersion: 1, runId, tracks: [] }, runId);
  await writeActiveRun(root, {
    runId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });

  const recovered = runNode(root, AUTO_PILOT, [
    "orchestrate", "recover", "--apply", "--run-id", runId, "--json",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.equal(JSON.parse(recovered.stdout).terminalFinalization, null);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).tasks[0].claimedBy, runId);
  assert.equal(readActiveRuns(root).some((entry) => entry.runId === runId), true);
});

test("recent running-track evidence blocks done-run finalization on every recover path", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-done-running-track-"));
  const runId = "run-done-running-track";
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "running claim",
    priority: "P0",
    state: "Backlog",
    claimedBy: runId,
    claimedAt: new Date().toISOString(),
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  await writeRun(root, {
    schemaVersion: 1,
    runId,
    phase: "done",
    locks: { executorPid: null },
    workspace: { name: "default", type: "shared", executionTree: "shared", stateFile },
  }, runId);
  await writeTracks(root, {
    schemaVersion: 1,
    runId,
    tracks: [{
      taskId: "AP-001",
      dispatchId: "dispatch-recent",
      state: "running",
      pid: null,
      workerToken: "",
      lastHeartbeat: new Date().toISOString(),
    }],
  }, runId);
  await writeActiveRun(root, {
    runId,
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  });

  const recovered = runNode(root, AUTO_PILOT, [
    "orchestrate", "recover", "--apply", "--run-id", runId,
    "--track-timeout", "600000", "--json",
  ]);
  assert.notEqual(recovered.status, 0);
  assert.match(recovered.stderr, /LIVE_WORKERS/);
  assert.equal(JSON.parse(fs.readFileSync(stateFile, "utf8")).tasks[0].claimedBy, runId);
  assert.equal(readActiveRuns(root).some((entry) => entry.runId === runId), true);

  const scanned = await recoverDeadRunClaims({
    workDir: root,
    stateFile,
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, "docs", "todo", "run-journal.md"),
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    trackTimeout: 600_000,
    sprintBoardLock: Promise.resolve(),
  });
  assert.deepEqual(scanned.released, []);
  assert.deepEqual(scanned.finalized, []);
  assert.equal(readActiveRuns(root).some((entry) => entry.runId === runId), true);
});

test("run-specific planning never returns work actively claimed by another run", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-foreign-claim-"));
  const stateFile = writeState(root, [
    {
      id: "AP-001",
      title: "foreign work",
      priority: "P0",
      state: "In Progress",
      claimedBy: "run-a",
      claimExpiresAt: "2099-01-01T00:00:00.000Z",
      dependsOn: [],
    },
    { id: "AP-002", title: "available", priority: "P1", state: "Backlog", dependsOn: [] },
  ]);

  const plan = runNode(root, SPRINT_BOARD, [
    "plan", "--claim-run-id", "run-b", "--max-parallel", "1", "--json", "--state-file", stateFile,
  ]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.equal(JSON.parse(plan.stdout).primaryTaskId, "AP-002");
});

test("dispatch rejects replay outside the approved phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-dispatch-phase-"));
  writeState(root, [{ id: "AP-001", title: "task", priority: "P1", state: "Backlog", dependsOn: [] }]);
  const commands = [
    ["orchestrate", "init", "--run-id", "run-phase", "--json"],
    ["orchestrate", "plan", "--run-id", "run-phase", "--json"],
    ["orchestrate", "review-plan", "--run-id", "run-phase", "--dry-run", "--json"],
    ["orchestrate", "approve-plan", "--run-id", "run-phase", "--json"],
    ["orchestrate", "dispatch", "--run-id", "run-phase", "--dry-run", "--json"],
  ];
  for (const args of commands) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }

  const replay = runNode(root, AUTO_PILOT, [
    "orchestrate", "dispatch", "--run-id", "run-phase", "--dry-run", "--json",
  ]);
  assert.notEqual(replay.status, 0);
  assert.equal(JSON.parse(replay.stderr).error.code, "INVALID_PHASE");
});

test("plan governance actions reject execution and commit phases", () => {
  const blockedPhases = [
    "dispatch-queued",
    "running",
    "awaiting-commit-approval",
    "commit-approved",
    "committed",
  ];
  for (const action of ["plan", "review-plan", "approve-plan"]) {
    for (const phase of blockedPhases) {
      assert.equal(
        validateOrchestrationActionPhase(action, phase).ok,
        false,
        `${action} unexpectedly allowed ${phase}`
      );
    }
  }

  assert.equal(validateOrchestrationActionPhase("plan", "initialized").ok, true);
  assert.equal(validateOrchestrationActionPhase("plan", "cycle-closed").ok, true);
  assert.equal(validateOrchestrationActionPhase("plan", "dry-run-preview").ok, true);
  assert.equal(validateOrchestrationActionPhase("review-plan", "awaiting-plan-approval").ok, true);
  assert.equal(validateOrchestrationActionPhase("review-plan", "plan-reviewed").ok, true);
  assert.equal(validateOrchestrationActionPhase("approve-plan", "plan-reviewed").ok, true);
});

test("plan governance phase checks are enforced by each CLI action", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-plan-action-phase-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "task",
    priority: "P1",
    state: "Backlog",
    dependsOn: [],
  }]);
  const runId = "run-governance-phase";
  for (const args of [
    ["orchestrate", "init", "--run-id", runId, "--json", "--state-file", stateFile],
    ["orchestrate", "plan", "--run-id", runId, "--json", "--state-file", stateFile],
    ["orchestrate", "review-plan", "--run-id", runId, "--dry-run", "--json", "--state-file", stateFile],
    ["orchestrate", "approve-plan", "--run-id", runId, "--json", "--state-file", stateFile],
    ["orchestrate", "dispatch", "--run-id", runId, "--dry-run", "--json", "--state-file", stateFile],
  ]) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }

  for (const action of ["plan", "review-plan", "approve-plan"]) {
    const result = runNode(root, AUTO_PILOT, [
      "orchestrate", action, "--run-id", runId, "--dry-run", "--json", "--state-file", stateFile,
    ]);
    assert.equal(result.status, 2, `${action}\n${result.stderr}`);
    assert.equal(JSON.parse(result.stderr).error.code, "INVALID_PHASE");
  }
});

test("journal cannot close a cycle before the commit phase completes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-journal-phase-"));
  const init = runNode(root, AUTO_PILOT, ["orchestrate", "init", "--json"]);
  assert.equal(init.status, 0, init.stderr);

  const journal = runNode(root, AUTO_PILOT, ["orchestrate", "journal", "--json"]);
  assert.notEqual(journal.status, 0);
  assert.match(journal.stderr, /INVALID_PHASE/);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  assert.equal(run.phase, "initialized");
});

test("a failed re-review revokes an already approved plan", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-plan-rereview-"));
  writeState(root, [{ id: "AP-001", title: "review me", priority: "P1", state: "Backlog", dependsOn: [] }]);
  const board = path.join(root, "docs", "todo", "human-board.md");
  fs.mkdirSync(path.dirname(board), { recursive: true });
  fs.writeFileSync(board, "# Human Board\n\n## Instructions\n\n");
  const reviewer = path.join(root, "reviewer.mjs");
  fs.writeFileSync(reviewer, "console.log('PLAN REVIEW STATUS: PASS')\n");
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "config.yaml"), [
    "version: 1",
    "qualityGate:",
    "  planReviewCommand: node reviewer.mjs",
    "",
  ].join("\n"));

  for (const args of [
    ["orchestrate", "init", "--json"],
    ["orchestrate", "plan", "--json"],
    ["orchestrate", "review-plan", "--json"],
    ["orchestrate", "approve-plan", "--json"],
  ]) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, result.stderr);
  }

  fs.writeFileSync(reviewer, [
    "import fs from 'node:fs';",
    "const oldReviewStillExists = fs.existsSync('.va-auto-pilot/orchestration/plan-review.json');",
    "console.log(oldReviewStillExists ? 'PLAN REVIEW STATUS: PASS' : 'PLAN REVIEW STATUS: FAIL');",
    "",
  ].join("\n"));
  const rereview = runNode(root, AUTO_PILOT, ["orchestrate", "review-plan", "--json"]);
  assert.notEqual(rereview.status, 0);
  const run = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  const review = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "plan-review.json"), "utf8"));
  assert.equal(run.phase, "awaiting-plan-approval");
  assert.equal(run.approvedPlanId, null);
  assert.equal(review.status, "FAIL");
  assert.equal(fs.existsSync(path.join(root, ".va-auto-pilot", "orchestration", "checkpoint.json")), false);
  const dispatch = runNode(root, AUTO_PILOT, ["orchestrate", "dispatch", "--dry-run", "--json"]);
  assert.notEqual(dispatch.status, 0);
});

test("recovery preserves commit continuation phases after sprint tasks are Done", () => {
  const expectedCommand = new Map([
    ["awaiting-commit-approval", "Approve commit"],
    ["commit-approved", "Commit"],
    ["committed", "Journal"],
  ]);

  for (const phase of expectedCommand.keys()) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `va-recovery-${phase}-`));
    writeState(root, [{ id: "AP-001", title: "finished worker", priority: "P1", state: "Done", dependsOn: [] }]);
    const orchestrationDir = path.join(root, ".va-auto-pilot", "orchestration");
    fs.mkdirSync(orchestrationDir, { recursive: true });
    fs.writeFileSync(path.join(orchestrationDir, "run.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-commit-recovery",
      phase,
      candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [], dependencyGraph: { "AP-001": [] } },
      locks: { executorPid: null },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(orchestrationDir, "tracks.json"), `${JSON.stringify({
      runId: "run-commit-recovery",
      tracks: [],
    }, null, 2)}\n`);

    const recovered = runNode(root, AUTO_PILOT, ["orchestrate", "recover", "--apply", "--json"]);
    assert.equal(recovered.status, 0, `${phase}\n${recovered.stderr}`);
    const payload = JSON.parse(recovered.stdout);
    const persistedRun = JSON.parse(fs.readFileSync(path.join(orchestrationDir, "run.json"), "utf8"));
    assert.equal(persistedRun.phase, phase);
    assert.equal(payload.plan.mutations.some((mutation) => mutation.type === "close-run"), false);
    assert.equal(payload.plan.nextCommands[0]?.label, expectedCommand.get(phase));
  }
});

test("recovery invalidates missing, corrupt, or unbound execution approval", () => {
  for (const checkpointCase of ["missing", "corrupt", "missing-approval"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `va-recovery-${checkpointCase}-`));
    const stateFile = writeState(root, [{
      id: "AP-001",
      title: "recover approval",
      priority: "P1",
      state: "In Progress",
      claimedBy: "run-recover-approval",
      claimExpiresAt: "2099-01-01T00:00:00.000Z",
      dependsOn: [],
    }]);
    const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [], dependencyGraph: { "AP-001": [] } };
    const orchestrationDir = path.join(root, ".va-auto-pilot", "orchestration");
    fs.mkdirSync(orchestrationDir, { recursive: true });
    fs.writeFileSync(path.join(orchestrationDir, "run.json"), `${JSON.stringify({
      schemaVersion: 1,
      runId: "run-recover-approval",
      phase: "dispatch-queued",
      approvedPlanId: checkpointCase === "missing-approval" ? null : "plan-recover-approval",
      candidatePlan,
      locks: { executorPid: null },
      workspace: { name: "default", type: "shared", executionTree: "shared", stateFile },
    }, null, 2)}\n`);
    fs.writeFileSync(path.join(orchestrationDir, "tracks.json"), `${JSON.stringify({
      runId: "run-recover-approval",
      tracks: [{ taskId: "AP-001", state: "queued", pid: null }],
    }, null, 2)}\n`);

    if (checkpointCase === "corrupt") {
      fs.writeFileSync(path.join(orchestrationDir, "checkpoint.json"), "{not-json", "utf8");
    } else if (checkpointCase === "missing-approval") {
      const checkpoint = buildCheckpoint({
        stateFile,
        workDir: root,
        runId: "run-recover-approval",
        approvedPlanId: "plan-recover-approval",
        candidatePlan,
        workspace: { name: "default", type: "shared", executionTree: "shared" },
      });
      fs.writeFileSync(path.join(orchestrationDir, "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);
    }

    const rejectedBeforeRecovery = runNode(root, AUTO_PILOT, ["orchestrate", "await-workers", "--dry-run", "--json"]);
    assert.notEqual(rejectedBeforeRecovery.status, 0);
    assert.equal(
      JSON.parse(rejectedBeforeRecovery.stderr).error.code,
      checkpointCase === "missing-approval" ? "APPROVAL_REQUIRED" : "STALE_CONTEXT"
    );

    const recovered = runNode(root, AUTO_PILOT, ["orchestrate", "recover", "--apply", "--json"]);
    assert.equal(recovered.status, 0, `${checkpointCase}\n${recovered.stderr}`);
    const persistedRun = JSON.parse(fs.readFileSync(path.join(orchestrationDir, "run.json"), "utf8"));
    assert.equal(persistedRun.phase, "awaiting-plan-approval");
    assert.equal(persistedRun.approvedPlanId, null);
    assert.equal(fs.existsSync(path.join(orchestrationDir, "checkpoint.json")), false);

    const awaitWorkers = runNode(root, AUTO_PILOT, ["orchestrate", "await-workers", "--dry-run", "--json"]);
    assert.notEqual(awaitWorkers.status, 0);
    assert.equal(JSON.parse(awaitWorkers.stderr).error.code, "INVALID_PHASE");
  }
});

test("recovery requeues a stale pending worker into an awaitable phase", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-recovery-requeue-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "resume worker",
    priority: "P1",
    state: "In Progress",
    claimedBy: "run-recover",
    claimExpiresAt: "2099-01-01T00:00:00.000Z",
    dependsOn: [],
  }]);
  const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [], dependencyGraph: { "AP-001": [] } };
  const run = {
    schemaVersion: 1,
    runId: "run-recover",
    phase: "running",
    approvedPlanId: "plan-recover",
    candidatePlan,
    locks: { executorPid: 999_999_999 },
    workspace: { name: "default", type: "shared", executionTree: "shared", stateFile },
  };
  fs.mkdirSync(path.join(root, ".va-auto-pilot", "orchestration"), { recursive: true });
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), `${JSON.stringify(run, null, 2)}\n`);
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"), `${JSON.stringify({
    runId: "run-recover",
    tracks: [{
      taskId: "AP-001",
      state: "running",
      pid: 999_999_999,
      startedAt: "2020-01-01T00:00:00.000Z",
      lastHeartbeat: "2020-01-01T00:00:00.000Z",
    }],
  }, null, 2)}\n`);
  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId: "run-recover",
    approvedPlanId: "plan-recover",
    candidatePlan,
    workspace: { name: "default", type: "shared", executionTree: "shared" },
  });
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "orchestration", "checkpoint.json"), `${JSON.stringify(checkpoint, null, 2)}\n`);

  const recovered = runNode(root, AUTO_PILOT, [
    "orchestrate", "recover", "--apply", "--track-timeout", "1", "--json",
  ]);
  assert.equal(recovered.status, 0, recovered.stderr);
  const recoveredRun = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "run.json"), "utf8"));
  const tracks = JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"), "utf8"));
  assert.equal(recoveredRun.phase, "dispatch-queued");
  assert.equal(tracks.tracks[0].state, "queued");
  assert.equal(tracks.tracks[0].pid, null);
});

test("recover --apply cannot race an active await-workers executor", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-recover-executor-lock-"));
  const runId = "run-recover-busy";
  writeState(root, []);
  fs.mkdirSync(path.join(root, "docs", "todo"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "todo", "human-board.md"), "# Human Board\n\n## Instructions\n\n");
  fs.writeFileSync(path.join(root, "docs", "todo", "run-journal.md"), "# Run Journal\n\n");
  await writeRun(root, {
    schemaVersion: 1,
    runId,
    phase: "running",
    locks: { executorPid: process.pid },
    workspace: { name: "default", type: "shared", executionTree: "shared" },
  }, runId);
  await writeTracks(root, { runId, tracks: [] }, runId);

  const lockTarget = `${orchestrationPaths(root, runId).run}.executor`;
  await withPilotFileLock(lockTarget, async () => {
    const result = runNode(root, AUTO_PILOT, [
      "orchestrate", "recover", "--run-id", runId, "--apply", "--json",
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /RECOVERY_BUSY/);
  });
});

test("await-workers persists a live child pid before settlement and recovery preserves its claim", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fixture's quality-gate commands use POSIX shell utilities");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-live-worker-persistence-"));
  const runId = "run-live-worker";
  const readyFile = path.join(os.tmpdir(), `va-worker-ready-${process.pid}-${Date.now()}`);
  const releaseFile = `${readyFile}.release`;
  const worker = path.join(root, "worker.mjs");
  fs.mkdirSync(path.join(root, ".va-auto-pilot"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "todo"), { recursive: true });
  fs.writeFileSync(path.join(root, ".gitignore"), [
    ".va-auto-pilot/orchestration/",
    ".va-auto-pilot/parallel-runs/",
    ".va/worktrees/",
    "",
  ].join("\n"));
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "config.yaml"), [
    "version: 1",
    "projectPrefix: AP",
    "sprint:",
    "  stateFile: .va-auto-pilot/sprint-state.json",
    "  boardFile: docs/todo/sprint.md",
    "  runJournalFile: docs/todo/run-journal.md",
    "qualityGate:",
    "  buildCommand: test -f AP-001.txt",
    "  reviewCommand: /bin/echo REVIEW_STATUS_PASS",
    "  acceptanceTestCommand: test -f AP-001.txt",
    "  planReviewCommand: \"/bin/echo 'PLAN REVIEW STATUS: PASS'\"",
    "",
  ].join("\n"));
  writeState(root, [{
    id: "AP-001",
    title: "persist live worker pid",
    priority: "P1",
    state: "Backlog",
    owner: "",
    source: "live-worker-regression",
    createdAt: "2026-07-09",
    failCount: 0,
    verification: "AP-001.txt exists",
    notes: "worker waits until the recovery assertions finish",
    permissionPolicy: {
      schemaVersion: 1,
      fileScopes: [{ path: "AP-001.txt", access: "read-write", reason: "worker artifact" }],
      commands: { allow: [], deny: [], destructiveRequiresOptIn: true, destructiveAllow: [] },
      network: { mode: "none", allowlist: [] },
      review: { warnOnOutOfScopeDiff: true },
    },
    review: {},
    testing: {},
    dependsOn: [],
  }]);
  fs.writeFileSync(path.join(root, "docs", "todo", "human-board.md"), "# Human Board\n\n## Instructions\n\n");
  fs.writeFileSync(path.join(root, "docs", "todo", "run-journal.md"), "# Run Journal\n\n");
  fs.writeFileSync(worker, [
    "import fs from 'node:fs';",
    `const ready = ${JSON.stringify(readyFile)};`,
    `const release = ${JSON.stringify(releaseFile)};`,
    "fs.writeFileSync(ready, String(process.pid));",
    "while (!fs.existsSync(release)) await new Promise((resolve) => setTimeout(resolve, 20));",
    "fs.writeFileSync('AP-001.txt', 'done\\n');",
    "",
  ].join("\n"));

  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(runNode(root, SPRINT_BOARD, ["render"]).status, 0);
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  assert.equal(git(["add", "."]).status, 0);
  assert.equal(git(["commit", "-qm", "seed"]).status, 0);

  for (const args of [
    ["orchestrate", "init", "--run-id", runId, "--shared-tree", "--json"],
    ["orchestrate", "plan", "--run-id", runId, "--json"],
    ["orchestrate", "review-plan", "--run-id", runId, "--json"],
    ["orchestrate", "approve-plan", "--run-id", runId, "--json"],
    ["orchestrate", "dispatch", "--run-id", runId, "--json"],
  ]) {
    const result = runNode(root, AUTO_PILOT, args);
    assert.equal(result.status, 0, `${args.join(" ")}\n${result.stderr}`);
  }

  const awaitProcess = spawn(process.execPath, [
    AUTO_PILOT,
    "orchestrate", "await-workers",
    "--run-id", runId,
    "--no-colony",
    "--agent-template", `node ${worker}`,
    "--track-timeout", "60000",
    "--json",
  ], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  let awaitStdout = "";
  let awaitStderr = "";
  awaitProcess.stdout.on("data", (chunk) => { awaitStdout += chunk.toString(); });
  awaitProcess.stderr.on("data", (chunk) => { awaitStderr += chunk.toString(); });
  const awaitCompletion = new Promise((resolve) => {
    awaitProcess.on("close", (code, signal) => resolve({ code, signal }));
  });

  try {
    const runFile = path.join(root, ".va-auto-pilot", "orchestration", "runs", runId, "run.json");
    const tracksFile = path.join(root, ".va-auto-pilot", "orchestration", "runs", runId, "tracks.json");
    await waitForCondition(() => {
      if (!fs.existsSync(readyFile) || !fs.existsSync(tracksFile)) return false;
      const tracksDoc = JSON.parse(fs.readFileSync(tracksFile, "utf8"));
      return Number.isInteger(tracksDoc.tracks?.[0]?.pid) && tracksDoc.tracks[0].pid > 0;
    });

    const liveRun = JSON.parse(fs.readFileSync(runFile, "utf8"));
    const liveTracks = JSON.parse(fs.readFileSync(tracksFile, "utf8"));
    const persistedPid = liveTracks.tracks[0].pid;
    assert.doesNotThrow(() => process.kill(persistedPid, 0));

    const orphanRecovery = buildRecoveryPlan({
      run: { ...liveRun, locks: { executorPid: 999_999_999 } },
      tracksDoc: liveTracks,
      state: JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "sprint-state.json"), "utf8")),
      checkpointStatus: { stale: false, reason: "" },
      nowMs: Date.now() + 120_000,
      trackTimeoutMs: 1,
    });
    assert.equal(orphanRecovery.mutations.some((mutation) => mutation.type === "requeue-track"), false);

    const prePidTracks = JSON.parse(JSON.stringify(liveTracks));
    prePidTracks.tracks[0].pid = null;
    prePidTracks.tracks[0].lastHeartbeat = "2020-01-01T00:00:00.000Z";
    const executorOwnedRecovery = buildRecoveryPlan({
      run: liveRun,
      tracksDoc: prePidTracks,
      state: JSON.parse(fs.readFileSync(path.join(root, ".va-auto-pilot", "sprint-state.json"), "utf8")),
      checkpointStatus: { stale: false, reason: "" },
      nowMs: Date.now() + 120_000,
      trackTimeoutMs: 1,
    });
    assert.equal(executorOwnedRecovery.mutations.some((mutation) => mutation.type === "requeue-track"), false);

    await writeActiveRun(root, {
      runId,
      startedAt: "2020-01-01T00:00:00.000Z",
      heartbeatAt: "2020-01-01T00:00:00.000Z",
    });
    const claimRecovery = await recoverDeadRunClaims({
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      trackTimeout: 1,
      sprintBoardLock: Promise.resolve(),
    });
    assert.deepEqual(claimRecovery.released, []);

    const halt = runNode(root, AUTO_PILOT, [
      "intervene", "halt-track", "--run-id", runId, "--task", "AP-001", "--json",
    ]);
    assert.equal(halt.status, 0, halt.stderr);
    assert.equal(JSON.parse(halt.stdout).cancelled, true);
  } finally {
    fs.writeFileSync(releaseFile, "release\n");
  }

  let completionTimer;
  const completion = await Promise.race([
    awaitCompletion,
    new Promise((_, reject) => {
      completionTimer = setTimeout(() => reject(new Error("await-workers did not finish")), 60_000);
    }),
  ]);
  clearTimeout(completionTimer);
  assert.equal(completion.code, 0, `${awaitStdout}\n${awaitStderr}`);
  const finalTracks = JSON.parse(fs.readFileSync(
    path.join(root, ".va-auto-pilot", "orchestration", "runs", runId, "tracks.json"),
    "utf8"
  ));
  assert.equal(finalTracks.tracks[0].state, "halted");
  assert.equal(finalTracks.tracks[0].pid, null);
  assert.equal(finalTracks.tracks[0].workerToken, "");
  assert.equal(fs.existsSync(path.join(root, "AP-001.txt")), false);
  fs.rmSync(readyFile, { force: true });
  fs.rmSync(releaseFile, { force: true });
});

test("worker launcher never executes the agent when its manager dies before PID persistence", async (t) => {
  if (process.platform === "win32") {
    t.skip("the regression uses SIGKILL to simulate a hard manager crash");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-worker-barrier-crash-"));
  const callbackFile = path.join(root, "callback.json");
  const ranFile = path.join(root, "agent-ran.txt");
  const agentFile = path.join(root, "agent.mjs");
  const managerFile = path.join(root, "manager.mjs");
  fs.writeFileSync(agentFile, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(ranFile)}, 'ran\\n');`,
    "await new Promise((resolve) => setTimeout(resolve, 30_000));",
    "",
  ].join("\n"));
  fs.writeFileSync(managerFile, [
    "import fs from 'node:fs';",
    `import { ColonyBridge } from ${JSON.stringify(pathToFileURL(path.join(REPO_ROOT, "scripts", "lib", "colony-bridge.mjs")).href)};`,
    `const bridge = new ColonyBridge({ workDir: ${JSON.stringify(root)}, useColony: false, lifecycleDir: ${JSON.stringify(path.join(root, "lifecycle"))}, onProcessStarted: async (event) => {`,
    `  fs.writeFileSync(${JSON.stringify(callbackFile)}, JSON.stringify(event));`,
    "  await new Promise(() => {});",
    "} });",
    `await bridge.dispatch({ taskId: 'AP-001', dispatchId: 'dispatch-crash', title: 'barrier', notes: '' }, ${JSON.stringify(`node ${agentFile}`)}, ${JSON.stringify(path.join(root, "worker.log"))}, 60_000);`,
    "",
  ].join("\n"));

  const manager = spawn(process.execPath, [managerFile], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  const managerClosed = new Promise((resolve) => manager.once("close", resolve));
  let launcherPid = null;
  try {
    await waitForCondition(() => fs.existsSync(callbackFile), 30_000);
    launcherPid = JSON.parse(fs.readFileSync(callbackFile, "utf8")).pid;
    assert.doesNotThrow(() => process.kill(launcherPid, 0));
    process.kill(manager.pid, "SIGKILL");
    await managerClosed;
    await waitForCondition(() => {
      try {
        process.kill(launcherPid, 0);
        return false;
      } catch {
        return true;
      }
    }, 15_000);
    assert.equal(fs.existsSync(ranFile), false);
  } finally {
    try { process.kill(manager.pid, "SIGKILL"); } catch { /* exited */ }
    if (launcherPid) {
      try { process.kill(-launcherPid, "SIGKILL"); } catch { /* exited */ }
    }
  }
});

test("halt-track never signals a PID retained on a terminal legacy track", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fixture cleans up a POSIX detached process group");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-terminal-pid-halt-"));
  fs.mkdirSync(path.join(root, ".va-auto-pilot"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs", "todo"), { recursive: true });
  writeState(root, []);
  fs.writeFileSync(path.join(root, "docs", "todo", "human-board.md"), "# Human Board\n\n## Instructions\n\n");
  fs.writeFileSync(path.join(root, "docs", "todo", "run-journal.md"), "# Run Journal\n\n");
  const sleeper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    cwd: root,
    detached: true,
    stdio: "ignore",
  });
  try {
    await writeRun(root, {
      schemaVersion: 1,
      runId: "run-terminal-pid",
      phase: "running",
      locks: { executorPid: null },
      workspace: { name: "default", type: "shared", executionTree: "shared" },
    });
    await writeTracks(root, {
      runId: "run-terminal-pid",
      tracks: [{ taskId: "AP-001", state: "settled", pid: sleeper.pid, dispatchId: "old-dispatch" }],
    });
    const result = runNode(root, AUTO_PILOT, ["intervene", "halt-track", "--task", "AP-001", "--json"]);
    assert.equal(result.status, 0, result.stderr);
    assert.doesNotThrow(() => process.kill(sleeper.pid, 0));
    const tracks = JSON.parse(fs.readFileSync(
      path.join(root, ".va-auto-pilot", "orchestration", "tracks.json"),
      "utf8"
    ));
    assert.equal(tracks.tracks[0].state, "settled");
  } finally {
    try { process.kill(-sleeper.pid, "SIGKILL"); } catch { /* exited */ }
  }
});

test("rejected or mismatched worker tracks cannot enter a commit manifest", () => {
  const task = { id: "AP-001", title: "done despite worktree failure", state: "Done" };
  const failedTrack = {
    taskId: task.id,
    state: "running",
    approvalFiles: ["unsafe.txt"],
    worktree: {
      enabled: true,
      resultCommit: "stale-commit",
      commitResult: { files: ["unsafe.txt"] },
    },
  };
  const result = settleWorkerTrackOutcome(
    failedTrack,
    { status: "rejected", reason: new Error("worktree commit manifest mismatch") },
    task,
    "2026-07-09T00:00:00.000Z"
  );

  assert.equal(result.action, "track-error");
  assert.equal(failedTrack.state, "failed");
  assert.equal(failedTrack.resultStatus, "failed");
  assert.match(failedTrack.error, /manifest mismatch/);
  assert.deepEqual(failedTrack.approvalFiles, []);
  assert.equal(failedTrack.worktree.resultCommit, undefined);
  assert.equal(validateCommitReadyTrack(failedTrack).ok, false);
  assert.deepEqual(
    selectCommitReadyTasks(
      { tasks: [task] },
      { primaryTaskId: task.id, parallelTracks: [] },
      { tracks: [failedTrack] }
    ),
    []
  );
  assert.throws(
    () => buildCommitApprovalManifest([task], { tracks: [failedTrack] }, { workDir: process.cwd() }),
    /cannot build commit approval manifest/
  );
});

test("isolated commit readiness requires a result commit and exact file manifest", () => {
  const base = {
    taskId: "AP-001",
    state: "settled",
    resultStatus: "succeeded",
    sprintState: "Done",
    approvalFiles: ["src/a.mjs", "src/b.mjs"],
  };
  assert.match(
    validateCommitReadyTrack({ ...base, worktree: { enabled: true, commitResult: { files: base.approvalFiles } } }).reason,
    /no result commit/
  );
  assert.match(
    validateCommitReadyTrack({
      ...base,
      worktree: { enabled: true, resultCommit: "abc123", commitResult: { files: ["src/a.mjs"] } },
    }).reason,
    /manifest mismatch/
  );

  const readyTrack = {
    ...base,
    worktree: {
      enabled: true,
      resultCommit: "abc123",
      commitResult: { files: ["src/b.mjs", "src/a.mjs"] },
    },
  };
  assert.equal(validateCommitReadyTrack(readyTrack).ok, true);
  assert.deepEqual(
    selectCommitReadyTasks(
      { tasks: [{ id: "AP-001", state: "Done" }] },
      { primaryTaskId: "AP-001", parallelTracks: [] },
      { tracks: [readyTrack] }
    ).map((task) => task.id),
    ["AP-001"]
  );
});

test("commit approval binds every task evidence bundle file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-approval-"));
  const bundle = path.join(root, ".va-auto-pilot", "evidence", "run-a", "AP-001");
  fs.mkdirSync(path.join(bundle, "redacted"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "manifest.json"), "{\"state\":\"completed\"}\n");
  fs.writeFileSync(path.join(bundle, "events.jsonl"), "{\"event\":1}\n");
  fs.writeFileSync(path.join(bundle, "redacted", "manifest.json"), "{\"redacted\":true}\n");
  const relativeManifest = ".va-auto-pilot/evidence/run-a/AP-001/manifest.json";
  const evidenceFiles = collectEvidenceBundleFiles(root, relativeManifest);
  assert.deepEqual(evidenceFiles, [
    ".va-auto-pilot/evidence/run-a/AP-001/events.jsonl",
    ".va-auto-pilot/evidence/run-a/AP-001/manifest.json",
    ".va-auto-pilot/evidence/run-a/AP-001/redacted/manifest.json",
  ]);

  const task = { id: "AP-001", state: "Done" };
  const track = {
    taskId: task.id,
    state: "settled",
    resultStatus: "succeeded",
    sprintState: "Done",
    approvalFiles: [],
    evidenceBundle: relativeManifest,
    evidenceFiles,
  };
  const approved = buildCommitApprovalManifest([task], { tracks: [track] }, { workDir: root });
  assert.deepEqual(Object.keys(approved.manifest.tasks[0].evidenceFileHashes).sort(), evidenceFiles);

  fs.writeFileSync(path.join(bundle, "events.jsonl"), "{\"event\":2}\n");
  const changed = buildCommitApprovalManifest([task], { tracks: [track] }, { workDir: root });
  assert.notEqual(changed.hash, approved.hash);
});

test("commit evidence collection rejects a symlinked bundle parent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-parent-link-"));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "va-evidence-parent-outside-"));
  const evidenceRoot = path.join(root, ".va-auto-pilot", "evidence");
  fs.mkdirSync(evidenceRoot, { recursive: true });
  fs.writeFileSync(path.join(outside, "manifest.json"), "{}\n");
  fs.symlinkSync(outside, path.join(evidenceRoot, "run-linked"), "dir");

  assert.throws(
    () => collectEvidenceBundleFiles(root, ".va-auto-pilot/evidence/run-linked/manifest.json"),
    /real directory/
  );
});

test("checkpoint detects task policy, candidate plan, and runtime config changes", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-checkpoint-complete-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "safe task",
    priority: "P1",
    state: "Backlog",
    permissionPolicy: { filesystem: { allow: ["src/**"] } },
    dependsOn: [],
  }]);
  const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [] };
  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    approvedPlanId: "plan-1",
    candidatePlan,
  });

  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.tasks[0].title = "Delete production data";
  state.tasks[0].permissionPolicy = { filesystem: { allow: ["*"] } };
  fs.writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`);
  assert.match(isCheckpointStale(checkpoint, {
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    candidatePlan,
    approvedPlanId: "plan-1",
  }).reason, /sprint-state changed/);

  const currentCheckpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    approvedPlanId: "plan-1",
    candidatePlan,
  });
  assert.match(isCheckpointStale(currentCheckpoint, {
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    candidatePlan: { primaryTaskId: "AP-999", parallelTracks: [] },
    approvedPlanId: "plan-1",
  }).reason, /candidate plan changed/);

  fs.writeFileSync(path.join(root, ".va-auto-pilot", "config.yaml"), "qualityGate:\n  buildCommand: 'true'\n");
  assert.match(isCheckpointStale(currentCheckpoint, {
    stateFile,
    workDir: root,
    runId: "run-checkpoint",
    candidatePlan,
    approvedPlanId: "plan-1",
  }).reason, /runtime config changed/);
});

test("checkpoint becomes stale when a set-worker directive changes after approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-checkpoint-worker-selection-"));
  const stateFile = writeState(root, [{
    id: "AP-001",
    title: "safe task",
    priority: "P1",
    state: "Backlog",
    dependsOn: [],
  }]);
  const runId = "run-worker-selection";
  const candidatePlan = { primaryTaskId: "AP-001", parallelTracks: [] };
  const checkpoint = buildCheckpoint({
    stateFile,
    workDir: root,
    runId,
    approvedPlanId: "plan-worker-selection",
    candidatePlan,
  });

  assert.equal(isCheckpointStale(checkpoint, {
    stateFile,
    workDir: root,
    runId,
    candidatePlan,
    approvedPlanId: "plan-worker-selection",
  }).stale, false);

  await writeDirectives(root, {
    schemaVersion: 1,
    directives: [{ type: "set-worker", taskId: "AP-001", worker: "codex" }],
  }, runId);

  const stale = isCheckpointStale(checkpoint, {
    stateFile,
    workDir: root,
    runId,
    candidatePlan,
    approvedPlanId: "plan-worker-selection",
  });
  assert.equal(stale.stale, true);
  assert.equal(stale.reason, "worker selection changed since approve-plan");
});

test("stale-lock recovery preserves mutual exclusion under contention", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-lock-contention-"));
  const resource = path.join(root, "state.json");
  fs.writeFileSync(`${resource}.lock`, JSON.stringify({ pid: 999_999_999, acquiredAt: "2020-01-01T00:00:00.000Z" }));
  let active = 0;
  let maxActive = 0;

  await Promise.all(Array.from({ length: 16 }, () => withPilotFileLock(resource, async () => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
  }, { timeoutMs: 10_000 })));
  assert.equal(maxActive, 1);
});

test("lock release never unlinks a replacement owned by another process", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-lock-owner-"));
  const lockPath = path.join(root, "resource.lock");
  const held = await acquireLock(lockPath);
  const originalPath = `${lockPath}.original`;
  fs.renameSync(lockPath, originalPath);
  fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, ownerToken: "replacement" }));

  await releaseLock(held);
  assert.equal(fs.existsSync(lockPath), true);
  fs.rmSync(originalPath, { force: true });
});

test("dirty integration tree is rejected without altering staged user data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-integration-clean-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "user.txt"), "base\n");
  assert.equal(git(["add", "user.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "user.txt"), "user staged\n");
  assert.equal(git(["add", "user.txt"]).status, 0);

  await assert.rejects(() => assertCleanIntegrationTree({ workDir: root }), /dirty integration tree/);
  assert.equal(fs.readFileSync(path.join(root, "user.txt"), "utf8"), "user staged\n");
  assert.match(git(["diff", "--cached", "--", "user.txt"]).stdout, /user staged/);
});

test("integration clean check allows only the registered task worktree paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-integration-worktrees-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);

  const runtimePath = path.join(root, ".va", "worktrees", "run-a", "AP-001");
  fs.mkdirSync(runtimePath, { recursive: true });
  fs.writeFileSync(path.join(runtimePath, "runtime.txt"), "runtime\n");
  await assert.doesNotReject(() => assertCleanIntegrationTree(
    { workDir: root },
    { runtimeWorktreePaths: [runtimePath] }
  ));

  fs.writeFileSync(path.join(root, "unapproved.txt"), "user\n");
  await assert.rejects(
    () => assertCleanIntegrationTree({ workDir: root }, { runtimeWorktreePaths: [runtimePath] }),
    /unapproved\.txt/
  );
});

test("spawn timeout terminates the whole process group", async () => {
  if (process.platform === "win32") {
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-process-tree-"));
  const survivor = path.join(root, "survivor.txt");
  const logFile = path.join(root, "worker.log");
  const command = "sh -c '(sleep 0.3; printf survived > survivor.txt) & wait'";
  const bridge = new ColonyBridge({ workDir: root, useColony: false });
  const result = await bridge.dispatch(
    { taskId: "AP-TIMEOUT", command },
    command,
    logFile,
    80
  );
  assert.equal(result.timedOut, true);
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fs.existsSync(survivor), false);
  await bridge.shutdown();
});

test("task worktree reuse fails closed when a crashed worker left changes", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-worktree-reuse-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  const config = { enabled: true, rootDir: ".va/worktrees", branchPrefix: "va-track", cleanup: "keep" };
  const first = await prepareTrackWorktree({ workDir: root, runId: "run-a", taskId: "AP-001", config });
  fs.writeFileSync(path.join(first.path, "stale.txt"), "left by crashed worker\n");

  await assert.rejects(
    () => prepareTrackWorktree({ workDir: root, runId: "run-a", taskId: "AP-001", config }),
    /refusing to reuse dirty task worktree/
  );
});

test("auto-commit refuses files added after approval", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-manifest-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "approved\n");
  fs.writeFileSync(path.join(root, "unrelated-secret.txt"), "must not commit\n");
  fs.mkdirSync(path.join(root, ".va-auto-pilot", "evidence", "other-run"), { recursive: true });
  fs.writeFileSync(path.join(root, ".va-auto-pilot", "evidence", "other-run", "unapproved.json"), "{}\n");

  const task = { id: "AP-001", title: "Approved change", source: "test" };
  const opts = {
    workDir: root,
    stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
    boardFile: path.join(root, "docs", "todo", "sprint.md"),
    journalFile: path.join(root, "docs", "todo", "run-journal.md"),
    pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
    taskBaselines: new Map(),
    approvedCommitFiles: ["approved.txt"],
    dryRun: false,
    noCommit: false,
    deferCommit: true,
  };
  await assert.rejects(
    () => autoCommitTask(task, opts),
    (error) => /outside the approved manifest/.test(error.message)
      && error.message.includes("unrelated-secret.txt")
      && error.message.includes("unapproved.json")
  );
  assert.equal(git(["log", "--oneline"]).stdout.trim().split(/\r?\n/).length, 1);
  assert.equal(fs.readFileSync(path.join(root, "unrelated-secret.txt"), "utf8"), "must not commit\n");
});

test("per-task commit leaves other approved task files uncommitted", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-multi-approved-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");
  const runtimeDir = path.join(root, ".va", "worktrees", "run-a", "AP-001");
  fs.mkdirSync(runtimeDir, { recursive: true });
  fs.writeFileSync(path.join(runtimeDir, "runtime.txt"), "runtime\n");

  const result = await autoCommitTask(
    { id: "AP-001", title: "Task A", source: "test" },
    {
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map(),
      approvedCommitFiles: ["task-a.txt"],
      allowedUncommittedFiles: ["task-b.txt"],
      allowedUncommittedPrefixes: [".va/worktrees/run-a/AP-001"],
      dryRun: false,
      noCommit: false,
      deferCommit: true,
    }
  );

  assert.equal(result.committed, true);
  assert.deepEqual(git(["show", "--pretty=", "--name-only", "HEAD"]).stdout.trim().split(/\r?\n/), ["task-a.txt"]);
  assert.match(git(["status", "--short"]).stdout, /\?\? task-b\.txt/);
  assert.match(git(["status", "--short"]).stdout, /\?\? \.va\//);
  assert.equal(fs.readFileSync(path.join(runtimeDir, "runtime.txt"), "utf8"), "runtime\n");
});

test("staged content is rechecked against its approval hash", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-staged-approval-hash-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "changed after approval\n");

  await assert.rejects(() => autoCommitTask(
    { id: "AP-001", title: "Hash-bound", source: "test" },
    {
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map(),
      approvedCommitFiles: ["approved.txt"],
      approvedCommitFileHashes: { "approved.txt": "not-the-approved-hash" },
      dryRun: false,
      noCommit: false,
    }
  ), (error) => error.code === "APPROVED_FILE_HASH_MISMATCH");
  assert.equal(git(["log", "--oneline"]).stdout.trim().split(/\r?\n/).length, 1);
});

test("commit uses the verified index snapshot even when a hook rewrites the working file", async () => {
  if (process.platform === "win32") return;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-commit-index-snapshot-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "v1\n");
  assert.equal(git(["add", "approved.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  fs.writeFileSync(path.join(root, "approved.txt"), "v2\n");
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nprintf 'v3\\n' > approved.txt\n", { mode: 0o755 });

  const result = await autoCommitTask(
    { id: "AP-001", title: "Snapshot-bound", source: "test" },
    {
      workDir: root,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map(),
      approvedCommitFiles: ["approved.txt"],
      dryRun: false,
      noCommit: false,
    }
  );

  assert.equal(result.committed, true);
  assert.equal(git(["show", "HEAD:approved.txt"]).stdout, "v2\n");
  assert.equal(fs.readFileSync(path.join(root, "approved.txt"), "utf8"), "v3\n");
});
