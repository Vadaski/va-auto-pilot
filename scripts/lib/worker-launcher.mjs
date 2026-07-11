import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const READY_TIMEOUT_MS = 180_000;
const HEARTBEAT_INTERVAL_MS = 2_000;
const FORCE_KILL_GRACE_MS = 4_000;

function parseOptions(argv) {
  const read = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? String(argv[index + 1] ?? "") : "";
  };
  const delay = Number.parseInt(read("post-spawn-delay-ms") || "0", 10);
  return {
    token: read("token"),
    heartbeatFile: path.resolve(read("heartbeat")),
    postSpawnMarker: read("post-spawn-marker") ? path.resolve(read("post-spawn-marker")) : "",
    postSpawnDelayMs: Number.isFinite(delay) ? Math.max(0, Math.min(delay, 10_000)) : 0,
  };
}

function writeHeartbeat(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(value)}\n`, "utf8");
  fs.renameSync(temp, filePath);
}

function terminateTargetTree(child, force = false) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (force) args.push("/F");
    execFile("taskkill.exe", args, () => {});
    return;
  }
  try {
    process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const { token, heartbeatFile, postSpawnMarker, postSpawnDelayMs } = parseOptions(argv);
  if (!/^[0-9a-f-]{36}$/u.test(token) || !heartbeatFile) {
    throw new Error("worker launcher requires a valid --token and --heartbeat path");
  }

  let target = null;
  let released = false;
  let finished = false;
  let state = "ready";
  let deadlineAt = null;
  let deadlineTimer = null;
  let forceTimer = null;
  let timedOut = false;
  const heartbeat = () => writeHeartbeat(heartbeatFile, {
    schemaVersion: 1,
    token,
    launcherPid: process.pid,
    childPid: state === "launching" ? null : target?.pid ?? null,
    state,
    deadlineAt,
    timedOut,
    updatedAt: new Date().toISOString(),
  });
  heartbeat();
  const heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
  const readyTimer = setTimeout(() => {
    if (!released) process.exitCode = 124;
    if (!released && process.connected) process.disconnect();
  }, READY_TIMEOUT_MS);

  const finish = (code, signal = "") => {
    if (finished) return;
    finished = true;
    state = "terminal";
    clearInterval(heartbeatTimer);
    clearTimeout(readyTimer);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (forceTimer) clearTimeout(forceTimer);
    heartbeat();
    process.exitCode = timedOut ? 124 : (Number.isInteger(code) ? code : (signal ? 1 : 127));
    if (process.connected) process.disconnect();
  };

  const requestStop = () => {
    if (!target?.pid) {
      finish(143, "SIGTERM");
      return;
    }
    state = "stopping";
    heartbeat();
    terminateTargetTree(target, false);
    if (!forceTimer) {
      forceTimer = setTimeout(() => terminateTargetTree(target, true), FORCE_KILL_GRACE_MS);
    }
  };

  process.on("SIGTERM", requestStop);
  process.on("SIGINT", requestStop);
  process.on("disconnect", () => {
    // Before GO, loss of the manager is a hard barrier: no user command runs.
    // After GO, supervise the target to completion so recovery cannot overlap it.
    if (!released) finish(125, "IPC_DISCONNECT");
  });

  process.on("message", async (message) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) return;
    const payload = /** @type {any} */ (message);
    if (released || payload.type !== "go" || payload.token !== token) return;
    const file = String(payload.target?.file ?? "");
    const args = Array.isArray(payload.target?.args) ? payload.target.args.map(String) : [];
    const requestedDeadline = Number(payload.deadlineAt);
    if (!file) {
      finish(127);
      return;
    }
    released = true;
    clearTimeout(readyTimer);
    // Persist the ambiguous launch window before spawning. If the launcher is
    // SIGKILLed after the command starts but before childPid is durable,
    // recovery treats `launching` as unknown/live and never dispatches a
    // duplicate worker.
    state = "launching";
    deadlineAt = Number.isFinite(requestedDeadline) && requestedDeadline > 0
      ? requestedDeadline
      : null;
    heartbeat();
    target = spawn(file, args, {
      cwd: process.cwd(),
      env: process.env,
      shell: false,
      // Give the command its own durable process group. The launcher records
      // childPid in the heartbeat so manager/recovery can address both groups.
      detached: process.platform !== "win32",
      // The launcher stdout/stderr themselves are durable log descriptors.
      // Keeping target pipes makes `close` wait for descendants that inherited
      // them, while remaining independent from manager process lifetime.
      stdio: ["ignore", "pipe", "pipe"],
    });
    target.stdout.pipe(process.stdout);
    target.stderr.pipe(process.stderr);
    target.once("error", (error) => {
      process.stderr.write(`[worker-launcher] spawn error: ${error.message}\n`);
      finish(127);
    });
    target.once("close", (code, signal) => {
      // A command that daemonized after closing stdout/stderr must not outlive
      // its settled track and keep changing the repository.
      terminateTargetTree(target, true);
      finish(code, signal ?? "");
    });
    if (postSpawnMarker) {
      fs.mkdirSync(path.dirname(postSpawnMarker), { recursive: true });
      fs.writeFileSync(postSpawnMarker, String(target.pid ?? ""), "utf8");
    }
    if (postSpawnDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, postSpawnDelayMs));
    }
    if (finished) return;
    if (target.pid) state = "running";
    heartbeat();
    if (deadlineAt) {
      deadlineTimer = setTimeout(() => {
        timedOut = true;
        requestStop();
      }, Math.max(0, deadlineAt - Date.now()));
    }
  });

  if (typeof process.send !== "function") {
    finish(125, "IPC_UNAVAILABLE");
    return;
  }
  process.send({ type: "ready", token, pid: process.pid });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`[worker-launcher] ${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
