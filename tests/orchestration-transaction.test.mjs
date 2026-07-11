import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  orchestrationPaths,
  recoverRunTracksTransaction,
} from "../scripts/lib/orchestration-state.mjs";

function stateHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value ?? null), "utf8").digest("hex");
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function createFixture(runId, beforeRun, beforeTracks, afterRun, afterTracks) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-orchestration-transaction-"));
  const paths = orchestrationPaths(root, runId);
  const intent = {
    schemaVersion: 1,
    kind: "run-tracks",
    transactionId: crypto.randomUUID(),
    runId,
    createdAt: "2026-07-10T00:00:00.000Z",
    beforeRunHash: stateHash(beforeRun),
    beforeTracksHash: stateHash(beforeTracks),
    afterRunHash: stateHash(afterRun),
    afterTracksHash: stateHash(afterTracks),
    beforeRun,
    beforeTracks,
    afterRun,
    afterTracks,
  };
  writeJson(paths.run, beforeRun);
  writeJson(paths.tracks, beforeTracks);
  writeJson(paths.transaction, intent);
  return { root, paths, intent };
}

test("recovers forward when tracks were published but run publication crashed", async () => {
  const runId = "run-forward-recovery";
  const beforeRun = { schemaVersion: 1, runId, phase: "plan-approved" };
  const beforeTracks = { schemaVersion: 1, runId, tracks: [] };
  const afterRun = { ...beforeRun, phase: "dispatch-queued" };
  const afterTracks = {
    schemaVersion: 1,
    runId,
    tracks: [{ taskId: "AP-001", dispatchId: "dispatch-1", state: "queued" }],
  };
  const { root, paths } = createFixture(
    runId,
    beforeRun,
    beforeTracks,
    afterRun,
    afterTracks
  );

  // Simulate updateRunAndTracksAtomic crashing after its durable tracks write
  // but before run.json and the durable intent were finalized.
  writeJson(paths.tracks, afterTracks);

  const recovered = await recoverRunTracksTransaction(root, runId);

  assert.equal(recovered.recovered, true);
  assert.equal(recovered.superseded, false);
  assert.deepEqual(readJson(paths.run), afterRun);
  assert.deepEqual(readJson(paths.tracks), afterTracks);
  assert.equal(fs.existsSync(paths.transaction), false);
});

test("merges a concurrent halted track into an incomplete dispatch without reviving it", async () => {
  const runId = "run-halt-merge";
  const beforeRun = { schemaVersion: 1, runId, phase: "plan-approved" };
  const beforeTracks = { schemaVersion: 1, runId, tracks: [] };
  const afterRun = { ...beforeRun, phase: "dispatch-queued" };
  const afterTracks = {
    schemaVersion: 1,
    runId,
    tracks: [
      { taskId: "AP-001", dispatchId: "dispatch-1", state: "queued", pid: null },
      { taskId: "AP-002", dispatchId: "dispatch-2", state: "queued", pid: null },
    ],
  };
  const { root, paths } = createFixture(
    runId,
    beforeRun,
    beforeTracks,
    afterRun,
    afterTracks
  );
  const haltedAt = "2026-07-10T00:01:00.000Z";

  // Dispatch published tracks, then halt-track won before run publication.
  writeJson(paths.tracks, {
    ...afterTracks,
    tracks: [
      {
        ...afterTracks.tracks[0],
        state: "halted",
        cancelRequestedAt: haltedAt,
        resultStatus: "cancelled",
      },
      afterTracks.tracks[1],
    ],
  });

  const recovered = await recoverRunTracksTransaction(root, runId);
  const storedTracks = readJson(paths.tracks).tracks;

  assert.equal(recovered.recovered, true);
  assert.equal(storedTracks[0].state, "halted");
  assert.equal(storedTracks[0].cancelRequestedAt, haltedAt);
  assert.equal(storedTracks[0].resultStatus, "cancelled");
  assert.equal(storedTracks[1].state, "queued");
  assert.deepEqual(readJson(paths.run), afterRun);
  assert.equal(fs.existsSync(paths.transaction), false);
});

test("replays untouched sibling tracks while preserving one concurrent halt", async () => {
  const runId = "run-multi-track-halt-merge";
  const beforeRun = { schemaVersion: 1, runId, phase: "running" };
  const beforeTracks = {
    schemaVersion: 1,
    runId,
    tracks: [
      { taskId: "AP-001", dispatchId: "dispatch-1", state: "running", pid: null },
      { taskId: "AP-002", dispatchId: "dispatch-2", state: "running", pid: null },
    ],
  };
  const afterRun = { ...beforeRun, phase: "dispatch-queued" };
  const afterTracks = {
    ...beforeTracks,
    tracks: beforeTracks.tracks.map((track) => ({ ...track, state: "queued" })),
  };
  const { root, paths } = createFixture(runId, beforeRun, beforeTracks, afterRun, afterTracks);
  const haltedAt = "2026-07-10T00:03:00.000Z";
  writeJson(paths.tracks, {
    ...beforeTracks,
    tracks: [
      {
        ...beforeTracks.tracks[0],
        state: "halted",
        cancelRequestedAt: haltedAt,
        resultStatus: "cancelled",
      },
      beforeTracks.tracks[1],
    ],
  });

  await recoverRunTracksTransaction(root, runId);
  const stored = readJson(paths.tracks).tracks;
  assert.equal(stored[0].state, "halted");
  assert.equal(stored[0].cancelRequestedAt, haltedAt);
  assert.equal(stored[1].state, "queued");
  assert.deepEqual(readJson(paths.run), afterRun);
});

test("a close intent converges changed tracks to done and empty when no worker is live", async () => {
  const runId = "run-close-recovery";
  const beforeRun = { schemaVersion: 1, runId, phase: "awaiting" };
  const beforeTracks = {
    schemaVersion: 1,
    runId,
    tracks: [{ taskId: "AP-001", dispatchId: "dispatch-1", state: "settled", pid: null }],
  };
  const afterRun = { ...beforeRun, phase: "done", closedAt: "2026-07-10T00:02:00.000Z" };
  const afterTracks = { schemaVersion: 1, runId, tracks: [] };
  const { root, paths } = createFixture(
    runId,
    beforeRun,
    beforeTracks,
    afterRun,
    afterTracks
  );

  // This state is neither side of the transaction, but it carries no durable
  // live-worker identity and therefore cannot block a committed close.
  writeJson(paths.tracks, {
    ...beforeTracks,
    tracks: [{
      ...beforeTracks.tracks[0],
      state: "halted",
      cancelRequestedAt: "2026-07-10T00:01:30.000Z",
      resultStatus: "cancelled",
    }],
  });

  const recovered = await recoverRunTracksTransaction(root, runId);

  assert.equal(recovered.recovered, true);
  assert.equal(readJson(paths.run).phase, "done");
  assert.deepEqual(readJson(paths.tracks), afterTracks);
  assert.equal(fs.existsSync(paths.transaction), false);
});

test("a corrupt transaction fails closed without changing state or deleting evidence", async () => {
  const runId = "run-corrupt-intent";
  const beforeRun = { schemaVersion: 1, runId, phase: "plan-approved" };
  const beforeTracks = { schemaVersion: 1, runId, tracks: [] };
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-orchestration-transaction-corrupt-"));
  const paths = orchestrationPaths(root, runId);
  writeJson(paths.run, beforeRun);
  writeJson(paths.tracks, beforeTracks);
  fs.writeFileSync(paths.transaction, "{not-json", "utf8");

  await assert.rejects(
    recoverRunTracksTransaction(root, runId),
    (error) => error?.code === "ORCHESTRATION_TRANSACTION_CORRUPT"
  );

  assert.deepEqual(readJson(paths.run), beforeRun);
  assert.deepEqual(readJson(paths.tracks), beforeTracks);
  assert.equal(fs.readFileSync(paths.transaction, "utf8"), "{not-json");
});

test("a valid-JSON transaction with a payload hash mismatch fails closed", async () => {
  const runId = "run-hash-mismatch";
  const beforeRun = { schemaVersion: 1, runId, phase: "plan-approved" };
  const beforeTracks = { schemaVersion: 1, runId, tracks: [] };
  const afterRun = { ...beforeRun, phase: "dispatch-queued" };
  const afterTracks = { ...beforeTracks, tracks: [{ taskId: "AP-001", state: "queued" }] };
  const { root, paths, intent } = createFixture(runId, beforeRun, beforeTracks, afterRun, afterTracks);
  writeJson(paths.transaction, {
    ...intent,
    afterRun: { ...afterRun, phase: "done" },
  });

  await assert.rejects(
    recoverRunTracksTransaction(root, runId),
    (error) => error?.code === "ORCHESTRATION_TRANSACTION_CORRUPT"
  );
  assert.deepEqual(readJson(paths.run), beforeRun);
  assert.deepEqual(readJson(paths.tracks), beforeTracks);
  assert.equal(fs.existsSync(paths.transaction), true);
});

test("a conflicting transaction fails closed and retains its durable intent", async () => {
  const runId = "run-conflicting-intent";
  const beforeRun = { schemaVersion: 1, runId, phase: "plan-approved" };
  const beforeTracks = { schemaVersion: 1, runId, tracks: [] };
  const afterRun = { ...beforeRun, phase: "dispatch-queued" };
  const afterTracks = {
    schemaVersion: 1,
    runId,
    tracks: [{ taskId: "AP-001", dispatchId: "dispatch-1", state: "queued" }],
  };
  const { root, paths, intent } = createFixture(
    runId,
    beforeRun,
    beforeTracks,
    afterRun,
    afterTracks
  );
  const newerRun = { ...beforeRun, phase: "awaiting", revision: 2 };
  const newerTracks = {
    schemaVersion: 1,
    runId,
    tracks: [{ taskId: "AP-999", dispatchId: "newer-dispatch", state: "running" }],
  };
  writeJson(paths.run, newerRun);
  writeJson(paths.tracks, newerTracks);

  await assert.rejects(
    recoverRunTracksTransaction(root, runId),
    (error) => error?.code === "ORCHESTRATION_TRANSACTION_CONFLICT"
  );

  assert.deepEqual(readJson(paths.run), newerRun);
  assert.deepEqual(readJson(paths.tracks), newerTracks);
  assert.deepEqual(readJson(paths.transaction), intent);
});
