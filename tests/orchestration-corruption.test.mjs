import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isTrackWorkerAlive,
  orchestrationPaths,
  resolveWorkerHeartbeatPath,
  writeRun,
  writeTracks,
} from "../scripts/lib/orchestration-state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const AUTO_PILOT = path.join(REPO_ROOT, "scripts", "auto-pilot.mjs");

function runAutoPilot(cwd, args) {
  return spawnSync(process.execPath, [AUTO_PILOT, ...args], { cwd, encoding: "utf8" });
}

function baseRun(runId, phase = "plan-approved") {
  return {
    schemaVersion: 1,
    runId,
    phase,
    approvedPlanId: "plan-1",
    candidatePlan: { primaryTaskId: "AP-001", parallelTracks: [] },
    workspace: { name: "default", type: "shared", executionTree: "shared" },
    locks: { executorPid: null },
    startedAt: "2026-07-10T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
  };
}

test("close and init fail closed when tracks.json is corrupt", async () => {
  for (const action of ["close", "init"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `va-corrupt-tracks-${action}-`));
    const runId = `run-corrupt-${action}`;
    const run = baseRun(runId, action === "close" ? "cycle-closed" : "done");
    await writeRun(root, run, runId);
    const paths = orchestrationPaths(root, runId);
    fs.writeFileSync(paths.tracks, "{not-json", "utf8");

    const args = action === "close"
      ? ["orchestrate", "close", "--run-id", runId, "--json"]
      : ["orchestrate", "init", "--run-id", runId, "--json"];
    const result = runAutoPilot(root, args);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /ORCHESTRATION_STATE_CORRUPT/);
    assert.equal(fs.readFileSync(paths.tracks, "utf8"), "{not-json");
    assert.deepEqual(JSON.parse(fs.readFileSync(paths.run, "utf8")), run);
  }
});

test("dispatch fails closed when directives.json is corrupt", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-corrupt-directives-"));
  const runId = "run-corrupt-directives";
  const run = baseRun(runId);
  await writeRun(root, run, runId);
  await writeTracks(root, { schemaVersion: 1, runId, tracks: [] }, runId);
  const paths = orchestrationPaths(root, runId);
  fs.writeFileSync(paths.directives, "{not-json", "utf8");

  const result = runAutoPilot(root, ["orchestrate", "dispatch", "--run-id", runId, "--json"]);
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /ORCHESTRATION_STATE_CORRUPT/);
  assert.equal(fs.readFileSync(paths.directives, "utf8"), "{not-json");
  assert.deepEqual(JSON.parse(fs.readFileSync(paths.tracks, "utf8")), {
    schemaVersion: 1,
    runId,
    tracks: [],
  });
});

test("an ambiguous post-GO launch remains live even after the launcher PID disappears", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-ambiguous-launch-"));
  const runId = "run-ambiguous-launch";
  const token = "11111111-1111-4111-8111-111111111111";
  const pid = 999_999_991;
  const heartbeatFile = resolveWorkerHeartbeatPath(root, runId, token);
  fs.mkdirSync(path.dirname(heartbeatFile), { recursive: true });
  fs.writeFileSync(heartbeatFile, `${JSON.stringify({
    schemaVersion: 1,
    token,
    launcherPid: pid,
    childPid: null,
    state: "launching",
    updatedAt: new Date().toISOString(),
  })}\n`);

  assert.equal(isTrackWorkerAlive(root, runId, { pid, workerToken: token }), true);
});
