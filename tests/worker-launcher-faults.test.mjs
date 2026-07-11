import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { isTrackWorkerAlive } from "../scripts/lib/orchestration-state.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LAUNCHER = path.join(REPO_ROOT, "scripts", "lib", "worker-launcher.mjs");

async function waitFor(predicate, timeoutMs = 10_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started >= timeoutMs) throw new Error(`condition timed out after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function waitReady(child, token) {
  return new Promise((resolve, reject) => {
    const onMessage = (message) => {
      if (message?.type !== "ready" || message.token !== token) return;
      cleanup();
      resolve();
    };
    const onClose = (code, signal) => {
      cleanup();
      reject(new Error(`launcher exited before READY: ${code}/${signal}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("close", onClose);
    };
    child.on("message", onMessage);
    child.on("close", onClose);
  });
}

function sendGo(child, token, target, deadlineAt = null) {
  return new Promise((resolve, reject) => {
    child.send({ type: "go", token, target, deadlineAt }, (error) => (
      error ? reject(error) : resolve()
    ));
  });
}

test("post-GO pre-child-heartbeat crash remains fail-closed", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fault injection asserts POSIX process-group liveness");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-launch-window-"));
  const runId = "run-launch-window";
  const token = crypto.randomUUID();
  const heartbeatFile = path.join(root, ".va-auto-pilot", "orchestration", "runs", runId, "workers", `${token}.json`);
  const marker = path.join(root, "target-spawned.pid");
  const launcher = spawn(process.execPath, [
    LAUNCHER,
    "--token", token,
    "--heartbeat", heartbeatFile,
    "--post-spawn-marker", marker,
    "--post-spawn-delay-ms", "5000",
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  let targetPid = 0;
  try {
    await waitReady(launcher, token);
    await sendGo(launcher, token, {
      file: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
    });
    await waitFor(() => fs.existsSync(marker));
    targetPid = Number(fs.readFileSync(marker, "utf8"));
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
    assert.equal(heartbeat.state, "launching");
    assert.equal(heartbeat.childPid, null);

    const closed = new Promise((resolve) => launcher.once("close", resolve));
    process.kill(-launcher.pid, "SIGKILL");
    await closed;
    assert.doesNotThrow(() => process.kill(-targetPid, 0));
    assert.equal(isTrackWorkerAlive(root, runId, {
      pid: launcher.pid,
      workerToken: token,
    }), true);
  } finally {
    if (targetPid > 0) {
      try { process.kill(-targetPid, "SIGKILL"); } catch { /* already gone */ }
    }
    try { process.kill(-launcher.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});

test("launcher enforces its deadline after manager IPC disconnect", async (t) => {
  if (process.platform === "win32") {
    t.skip("the fixture asserts POSIX process-group cleanup");
    return;
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-launch-deadline-"));
  const token = crypto.randomUUID();
  const heartbeatFile = path.join(root, "workers", `${token}.json`);
  const launcher = spawn(process.execPath, [
    LAUNCHER,
    "--token", token,
    "--heartbeat", heartbeatFile,
  ], {
    cwd: root,
    detached: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  try {
    await waitReady(launcher, token);
    const launcherExit = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("launcher did not enforce deadline")), 10_000);
      // A parent-initiated IPC disconnect intentionally suppresses Node's
      // ChildProcess `close` event; `exit` is the authoritative process event.
      launcher.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await sendGo(launcher, token, {
      file: process.execPath,
      args: ["-e", "setTimeout(() => {}, 30000)"],
    }, Date.now() + 300);
    launcher.disconnect();
    await launcherExit;
    const heartbeat = JSON.parse(fs.readFileSync(heartbeatFile, "utf8"));
    assert.equal(heartbeat.state, "terminal");
    assert.equal(heartbeat.timedOut, true);
    assert.equal(heartbeat.deadlineAt > 0, true);
    assert.throws(() => process.kill(-launcher.pid, 0));
    assert.throws(() => process.kill(-heartbeat.childPid, 0));
  } finally {
    try { process.kill(-launcher.pid, "SIGKILL"); } catch { /* already gone */ }
  }
});
