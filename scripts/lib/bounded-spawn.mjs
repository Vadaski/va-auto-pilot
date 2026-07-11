import { spawn, spawnSync } from "node:child_process";

const DEFAULT_OUTPUT_LIMIT = 2_000_000;

function signalProcessTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === "win32") {
    const args = ["/PID", String(child.pid), "/T"];
    if (signal === "SIGKILL") args.push("/F");
    const result = spawnSync("taskkill.exe", args, { stdio: "ignore" });
    if (result.error) throw result.error;
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

/**
 * Run a command with a true wall-clock upper bound. The final watchdog settles
 * even when a detached descendant escapes the original process group while
 * retaining stdout/stderr, a case where ChildProcess `close` never arrives.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   timeoutMs?: number,
 *   terminateGraceMs?: number,
 *   settleGraceMs?: number,
 *   maxOutputChars?: number,
 * }} [options]
 * @returns {Promise<{
 *   status: number | null,
 *   signal: NodeJS.Signals | null,
 *   stdout: string,
 *   stderr: string,
 *   timedOut: boolean,
 * }>}
 */
export async function spawnBounded(command, args, options = {}) {
  const timeoutMs = Math.max(1, Number(options.timeoutMs ?? 30_000));
  const terminateGraceMs = Math.max(0, Number(options.terminateGraceMs ?? 2_000));
  const settleGraceMs = Math.max(0, Number(options.settleGraceMs ?? 250));
  const maxOutputChars = Math.max(1, Number(options.maxOutputChars ?? DEFAULT_OUTPUT_LIMIT));

  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let timeoutTimer = null;
    let forceTimer = null;
    let settleTimer = null;
    const append = (current, chunk) => `${current}${String(chunk)}`.slice(-maxOutputChars);
    const clearTimers = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forceTimer) clearTimeout(forceTimer);
      if (settleTimer) clearTimeout(settleTimer);
    };
    const finish = (status = child?.exitCode ?? null, signal = child?.signalCode ?? null) => {
      if (settled) return;
      settled = true;
      clearTimers();
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      if (timedOut) child?.unref();
      resolve({ status, signal, stdout, stderr, timedOut });
    };
    const safeSignal = (signal) => {
      try {
        signalProcessTree(child, signal);
      } catch (error) {
        stderr = append(stderr, `\n[bounded-spawn] ${signal} failed: ${error?.message ?? String(error)}\n`);
      }
    };

    try {
      child = spawn(command, args, {
        cwd: options.cwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      stderr = append(stderr, error?.message ?? String(error));
      finish(null, null);
      return;
    }

    child.stdout.on("data", (chunk) => { stdout = append(stdout, chunk); });
    child.stderr.on("data", (chunk) => { stderr = append(stderr, chunk); });
    child.on("error", (error) => {
      stderr = append(stderr, `\n${error.message}`);
      finish(null, null);
    });
    child.on("close", (code, signal) => {
      if (timedOut) safeSignal("SIGKILL");
      finish(code, signal);
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      safeSignal(process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      forceTimer = setTimeout(() => {
        safeSignal("SIGKILL");
        // `close` waits for inherited stdio. Destroy our pipe ends and settle
        // after the kill grace even if an escaped descendant still owns them.
        settleTimer = setTimeout(() => finish(), settleGraceMs);
      }, terminateGraceMs);
    }, timeoutMs);
  });
}
