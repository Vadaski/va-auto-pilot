/**
 * ColonyBridge — Uses va-agent-protocol Colony for task dispatch
 * instead of raw subprocess spawn.
 *
 * Falls back to raw spawn if va-agent-protocol is not available.
 *
 * Usage:
 *   const bridge = new ColonyBridge({ workDir: cwd, useColony: true });
 *   await bridge.init();
 *   const result = await bridge.dispatch(track, agentTemplate, logFile, timeoutMs);
 *
 * The result format is identical to va-parallel-runner's runTrack():
 *   { taskId, command, success, exitCode, signal, durationMs, timedOut, logFile, evidence? }
 */

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { nowIso } from "./sprint-utils.mjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Dynamic import of va-agent-protocol — graceful fallback if missing
// ---------------------------------------------------------------------------
let Colony = null;
let CodexAdapter = null;
let ClaudeCodeAdapter = null;
let GeminiAdapter = null;
let noopLogger = null;

try {
  const protocolDistPath = new URL(
    "../../../va-agent-protocol/dist/index.js",
    import.meta.url
  ).href;
  const protocol = await import(protocolDistPath);
  Colony = protocol.Colony ?? null;
  CodexAdapter = protocol.CodexAdapter ?? null;
  ClaudeCodeAdapter = protocol.ClaudeCodeAdapter ?? null;
  GeminiAdapter = protocol.GeminiAdapter ?? null;
  noopLogger = protocol.noopLogger ?? null;
} catch {
  // va-agent-protocol not available — ColonyBridge will use spawn fallback
}

/**
 * Check whether va-agent-protocol Colony is importable.
 * @returns {boolean}
 */
export function isColonyAvailable() {
  return Colony !== null;
}

/**
 * Detect whether a CLI binary is reachable on $PATH.
 * @param {string} bin
 * @returns {Promise<boolean>}
 */
async function isBinaryAvailable(bin) {
  try {
    await execFileAsync("which", [bin], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Track -> TaskUnit conversion
// ---------------------------------------------------------------------------

/**
 * Convert a va-parallel-runner track object into a va-agent-protocol TaskUnit.
 *
 * @param {{ taskId: string, command?: string, title?: string, verification?: string[], notes?: string }} track
 * @param {string} workDir
 * @returns {{ id: string, objective: string, acceptanceCriteria: string[], constraints: string[], context: object, timeout?: number }}
 */
export function trackToTaskUnit(track, workDir) {
  return {
    id: track.taskId,
    objective: track.title || track.command || track.taskId,
    acceptanceCriteria: Array.isArray(track.verification)
      ? track.verification
      : ["Task completes successfully"],
    constraints: track.notes ? [track.notes] : [],
    context: { codebaseRoot: workDir },
  };
}

// ---------------------------------------------------------------------------
// Colony result -> runner result conversion
// ---------------------------------------------------------------------------

/**
 * Convert a Colony evidence-based result into the format that
 * va-parallel-runner.mjs expects (identical shape to runTrack's resolve).
 *
 * @param {string} taskId
 * @param {string} command   - original command string (for parity)
 * @param {number} durationMs
 * @param {string} logFile
 * @param {{ state: string, evidence?: object }} pollResult
 * @returns {{ taskId, command, success, exitCode, signal, durationMs, timedOut, logFile, evidence? }}
 */
export function colonyResultToRunnerResult(
  taskId,
  command,
  durationMs,
  logFile,
  pollResult
) {
  const state = pollResult?.state ?? "failed";
  const evidence = pollResult?.evidence ?? null;
  const isCompleted = state === "completed";
  const isTimeout =
    evidence?.failureDetail?.failureType === "timeout" || false;

  return {
    taskId,
    command,
    success: isCompleted,
    exitCode: isCompleted ? 0 : 1,
    signal: "",
    durationMs,
    timedOut: isTimeout,
    logFile,
    ...(evidence ? { evidence } : {}),
  };
}

// ---------------------------------------------------------------------------
// ColonyBridge
// ---------------------------------------------------------------------------

export class ColonyBridge {
  /**
   * @param {{ workDir?: string, useColony?: boolean }} options
   */
  constructor(options = {}) {
    this.workDir = options.workDir || process.cwd();
    /** @type {object|null} */
    this.colony = null;
    /** @type {boolean} Whether to attempt Colony dispatch */
    this.useColony = !!Colony && options.useColony !== false;
    /** @type {string[]} IDs of registered adapters */
    this.registeredAdapters = [];
  }

  /**
   * Initialise Colony and auto-detect available CLI agents.
   * Returns true if at least one adapter was registered.
   * @returns {Promise<boolean>}
   */
  async init() {
    if (!this.useColony || !Colony) {
      this.useColony = false;
      return false;
    }

    const logger = noopLogger ?? undefined;
    this.colony = new Colony({
      pollIntervalMs: 2_000,
      maxRetries: 1,
      logger,
    });

    const detections = await Promise.all([
      { Adapter: CodexAdapter, bin: "codex", opts: "CodexAdapter" },
      { Adapter: ClaudeCodeAdapter, bin: "claude", opts: "ClaudeCodeAdapter" },
      { Adapter: GeminiAdapter, bin: "gemini", opts: "GeminiAdapter" },
    ].map(async ({ Adapter, bin, opts }) => {
      if (!Adapter) return null;
      const available = await isBinaryAvailable(bin);
      if (!available) return null;
      return { Adapter, bin, opts };
    }));

    for (const detection of detections) {
      if (!detection) continue;
      const { Adapter, bin } = detection;
      try {
        const adapter = new Adapter({
          workingDirectory: this.workDir,
          // Use the binary name as-is (rely on $PATH)
          ...(bin === "codex" ? { codexPath: bin } : {}),
          ...(bin === "claude" ? { claudePath: bin } : {}),
          ...(bin === "gemini" ? { geminiPath: bin } : {}),
          taskTimeoutMs: 600_000, // Match default track timeout
          qualityGates: [],       // Caller handles gates
          logger,
        });
        this.colony.addAgent(adapter);
        this.registeredAdapters.push(adapter.id);
      } catch {
        // Adapter construction failed — skip
      }
    }

    if (this.registeredAdapters.length === 0) {
      this.colony = null;
      this.useColony = false;
      return false;
    }

    return true;
  }

  /**
   * Dispatch a track. If Colony is initialised, route through Colony.
   * Otherwise fall back to raw spawn (existing va-parallel-runner behaviour).
   *
   * @param {{ taskId: string, command?: string, title?: string, verification?: string[], notes?: string }} track
   * @param {string} agentTemplate
   * @param {string} logFile
   * @param {number} timeoutMs
   * @returns {Promise<{ taskId, command, success, exitCode, signal, durationMs, timedOut, logFile, evidence? }>}
   */
  async dispatch(track, agentTemplate, logFile, timeoutMs) {
    if (this.colony) {
      return this.dispatchViaColony(track, agentTemplate, logFile, timeoutMs);
    }
    return this.dispatchViaSpawn(track, agentTemplate, logFile, timeoutMs);
  }

  // ─── Colony dispatch ────────────────────────────────────────────────────

  /**
   * @param {object} track
   * @param {string} agentTemplate
   * @param {string} logFile
   * @param {number} timeoutMs
   */
  async dispatchViaColony(track, agentTemplate, logFile, timeoutMs) {
    const command = track.command || agentTemplate || track.taskId;
    const taskUnit = trackToTaskUnit(track, this.workDir);

    // Override timeout from caller
    taskUnit.timeout = timeoutMs;

    const startedAt = Date.now();

    appendLog(
      logFile,
      `[${nowIso()}] task=${track.taskId} [colony-dispatch]\nobjective: ${taskUnit.objective}\ntimeout: ${timeoutMs > 0 ? `${timeoutMs}ms` : "none"}\n---\n`
    );

    // Submit task and wait for completion via event callbacks
    return new Promise((resolve) => {
      let settled = false;
      let timeoutHandle = null;

      const settle = (pollResult) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) clearTimeout(timeoutHandle);
        this.colony.stop();

        const durationMs = Date.now() - startedAt;
        const result = colonyResultToRunnerResult(
          track.taskId,
          command,
          durationMs,
          logFile,
          pollResult
        );

        appendLog(
          logFile,
          `\n---\n[${nowIso()}] colony result: success=${result.success} durationMs=${durationMs}${result.timedOut ? " (TIMEOUT)" : ""}\n`
        );

        resolve(result);
      };

      // Wire up Colony callbacks for this specific task
      const originalOnCompleted = this.colony.getOrchestrator?.()?.options?.onCompleted;
      const originalOnFailed = this.colony.getOrchestrator?.()?.options?.onFailed;

      // We use a simpler approach: submit, start, then poll manually
      this.colony.submitTasks(taskUnit);
      this.colony.start();

      // Set up a timeout guard
      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          settle({
            state: "failed",
            evidence: {
              taskId: track.taskId,
              status: "failed",
              failureDetail: {
                failureType: "timeout",
                attempted: `Colony dispatch exceeded ${timeoutMs}ms`,
                hypothesis: "Task timed out during colony dispatch.",
              },
            },
          });
        }, timeoutMs + 5_000); // Small grace period over track timeout
      }

      // Poll until done
      const pollInterval = setInterval(() => {
        if (settled) {
          clearInterval(pollInterval);
          return;
        }

        const status = this.colony.getStatus();
        const activeTask = status.activeTasks.find(
          (t) => t.taskId === track.taskId
        );

        // Task completed (no longer active + completed count > 0)
        if (!activeTask && status.pendingCount === 0) {
          clearInterval(pollInterval);

          if (status.completedCount > 0) {
            settle({
              state: "completed",
              evidence: {
                taskId: track.taskId,
                status: "completed",
                verification: "Task completed via Colony dispatch.",
              },
            });
          } else {
            settle({
              state: "failed",
              evidence: {
                taskId: track.taskId,
                status: "failed",
                failureDetail: {
                  failureType: "unknown",
                  attempted: "Colony dispatch",
                  hypothesis: "Task was not completed by any agent.",
                },
              },
            });
          }
        }
      }, 1_000);
    });
  }

  // ─── Spawn fallback (existing behaviour) ────────────────────────────────

  /**
   * Raw spawn — mirrors the existing runTrack logic from va-parallel-runner.mjs.
   *
   * @param {{ taskId: string, command?: string, title?: string, verification?: string[], notes?: string }} track
   * @param {string} agentTemplate
   * @param {string} logFile
   * @param {number} timeoutMs
   */
  async dispatchViaSpawn(track, agentTemplate, logFile, timeoutMs) {
    const command = track.command || agentTemplate || "";
    const startedAt = Date.now();

    appendLog(
      logFile,
      `[${nowIso()}] task=${track.taskId}\ncommand: ${command}\ntimeout: ${timeoutMs > 0 ? `${timeoutMs}ms` : "none"}\n---\n`
    );

    return new Promise((resolve) => {
      const child = spawn("bash", ["-lc", command], {
        env: { ...process.env, VA_TASK_ID: track.taskId },
      });

      let timedOut = false;
      let killTimer = null;

      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          appendLog(
            logFile,
            `\n[${nowIso()}] timeout after ${timeoutMs}ms — sending SIGTERM\n`
          );
          child.kill("SIGTERM");

          // Force-kill after 5 s if still running.
          setTimeout(() => {
            try {
              child.kill("SIGKILL");
            } catch {
              /* already exited */
            }
          }, 5_000);
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk) => {
        appendLog(logFile, chunk.toString());
      });

      child.stderr.on("data", (chunk) => {
        appendLog(logFile, chunk.toString());
      });

      child.on("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        const durationMs = Date.now() - startedAt;
        appendLog(
          logFile,
          `\n---\n[${nowIso()}] exit code=${code ?? -1} signal=${signal ?? "-"} durationMs=${durationMs}${timedOut ? " (TIMEOUT)" : ""}\n`
        );
        resolve({
          taskId: track.taskId,
          command,
          success: code === 0 && !timedOut,
          exitCode: code ?? -1,
          signal: signal ?? "",
          durationMs,
          timedOut,
          logFile,
        });
      });
    });
  }

  /**
   * Gracefully shut down the Colony (if initialised).
   */
  async shutdown() {
    if (this.colony) {
      try {
        await this.colony.shutdown();
      } catch {
        // Best-effort
      }
      this.colony = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appendLog(logFile, message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, message, "utf8");
}
