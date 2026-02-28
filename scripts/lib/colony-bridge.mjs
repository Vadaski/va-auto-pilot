/**
 * ColonyBridge — va-agent-protocol Colony for task dispatch.
 *
 * Lifecycle: init() → dispatch() → shutdown()
 * Event-based completion (no polling). Auto-detects: codex, claude, gemini, kimi, glm.
 * Falls back to raw spawn if va-agent-protocol is not available.
 */

import fs from "node:fs";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { nowIso } from "./sprint-utils.mjs";

const execFileAsync = promisify(execFile);

// Dynamic import of va-agent-protocol — graceful fallback if missing
let Colony = null;
let CodexAdapter = null;
let ClaudeCodeAdapter = null;
let GeminiAdapter = null;
let KimiAdapter = null;
let GlmAdapter = null;
let noopLogger = null;

try {
  const p = await import(
    new URL("../../../va-agent-protocol/dist/index.js", import.meta.url).href
  );
  Colony = p.Colony ?? null;
  CodexAdapter = p.CodexAdapter ?? null;
  ClaudeCodeAdapter = p.ClaudeCodeAdapter ?? null;
  GeminiAdapter = p.GeminiAdapter ?? null;
  KimiAdapter = p.KimiAdapter ?? null;
  GlmAdapter = p.GlmAdapter ?? null;
  noopLogger = p.noopLogger ?? null;
} catch {
  // va-agent-protocol not available
}

/** Check whether va-agent-protocol Colony is importable. */
export function isColonyAvailable() {
  return Colony !== null;
}

async function isBinaryAvailable(bin) {
  try {
    await execFileAsync("which", [bin], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Convert a track into a va-agent-protocol TaskUnit with rich metadata.
 * @param {{ taskId: string, command?: string, title?: string, verification?: string[], notes?: string, priority?: string, dependsOn?: string[], qualityGates?: string[] }} track
 * @param {string} workDir
 */
export function trackToTaskUnit(track, workDir) {
  const unit = {
    id: track.taskId,
    objective: track.title || track.command || track.taskId,
    acceptanceCriteria: Array.isArray(track.verification)
      ? track.verification
      : ["Task completes successfully"],
    constraints: track.notes ? [track.notes] : [],
    context: { codebaseRoot: workDir },
  };
  if (track.priority) unit.priority = track.priority;
  if (Array.isArray(track.dependsOn) && track.dependsOn.length > 0) unit.dependsOn = track.dependsOn;
  if (track.qualityGates) unit.metadata = { qualityGates: track.qualityGates };
  return unit;
}

/**
 * Convert Colony evidence into the runner result format.
 * @param {string} taskId
 * @param {string} command
 * @param {number} durationMs
 * @param {string} logFile
 * @param {{ state: string, evidence?: object }} pollResult
 */
export function colonyResultToRunnerResult(taskId, command, durationMs, logFile, pollResult) {
  const state = pollResult?.state ?? "failed";
  const evidence = pollResult?.evidence ?? null;
  const isCompleted = state === "completed";
  const isTimeout = evidence?.failureDetail?.failureType === "timeout" || false;
  return {
    taskId, command,
    success: isCompleted,
    exitCode: isCompleted ? 0 : 1,
    signal: "",
    durationMs, timedOut: isTimeout, logFile,
    ...(evidence ? { evidence } : {}),
  };
}

// CLI adapter config table (GLM is API-based, handled separately)
const ADAPTER_CONFIGS = [
  { Adapter: () => CodexAdapter, bin: "codex", optKey: "codexPath" },
  { Adapter: () => ClaudeCodeAdapter, bin: "claude", optKey: "claudePath" },
  { Adapter: () => GeminiAdapter, bin: "gemini", optKey: "geminiPath" },
  { Adapter: () => KimiAdapter, bin: "kimi", optKey: "kimiPath" },
];

export class ColonyBridge {
  constructor(options = {}) {
    this.workDir = options.workDir || process.cwd();
    this.colony = null;
    this.useColony = !!Colony && options.useColony !== false;
    this.registeredAdapters = [];
    this._pending = new Map();
  }

  /** Initialise Colony and auto-detect agents. Returns true if >= 1 adapter registered. */
  async init() {
    if (!this.useColony || !Colony) {
      this.useColony = false;
      return false;
    }
    const logger = noopLogger ?? undefined;

    this.colony = new Colony({
      pollIntervalMs: 2_000, maxRetries: 1, logger,
      onCompleted: (taskId, evidence) => {
        const e = this._pending.get(taskId);
        if (e) { this._pending.delete(taskId); e.resolve({ state: "completed", evidence }); }
      },
      onFailed: (taskId, evidence) => {
        const e = this._pending.get(taskId);
        if (e) { this._pending.delete(taskId); e.resolve({ state: "failed", evidence }); }
      },
      onBlocked: (taskId, reason) => {
        const e = this._pending.get(taskId);
        if (e) {
          this._pending.delete(taskId);
          e.resolve({
            state: "failed",
            evidence: { taskId, status: "blocked", blockReason: { type: "external-resource", description: reason } },
          });
        }
      },
    });

    // Detect CLI adapters in parallel
    const detections = await Promise.all(
      ADAPTER_CONFIGS.map(async ({ Adapter, bin, optKey }) => {
        const Cls = Adapter();
        if (!Cls) return null;
        return (await isBinaryAvailable(bin)) ? { Cls, bin, optKey } : null;
      })
    );

    for (const d of detections) {
      if (!d) continue;
      try {
        const adapter = new d.Cls({
          workingDirectory: this.workDir, [d.optKey]: d.bin,
          taskTimeoutMs: 600_000, qualityGates: [], logger,
        });
        this.colony.addAgent(adapter);
        this.registeredAdapters.push(adapter.id);
      } catch { /* skip */ }
    }

    // GLM is API-based — register if keys available
    if (GlmAdapter) {
      const glmKeys = process.env.GLM_API_KEYS || process.env.ZHIPU_API_KEYS;
      if (glmKeys) {
        try {
          const apiKeys = glmKeys.split(",").map((k) => k.trim()).filter(Boolean);
          if (apiKeys.length > 0) {
            const adapter = new GlmAdapter({
              workingDirectory: this.workDir, apiKeys,
              taskTimeoutMs: 600_000, qualityGates: [], logger,
            });
            this.colony.addAgent(adapter);
            this.registeredAdapters.push(adapter.id);
          }
        } catch { /* skip */ }
      }
    }

    if (this.registeredAdapters.length === 0) {
      this.colony = null;
      this.useColony = false;
      return false;
    }

    this.colony.start();
    return true;
  }

  async dispatch(track, agentTemplate, logFile, timeoutMs) {
    if (this.colony) return this.dispatchViaColony(track, agentTemplate, logFile, timeoutMs);
    return this.dispatchViaSpawn(track, agentTemplate, logFile, timeoutMs);
  }

  async dispatchViaColony(track, agentTemplate, logFile, timeoutMs) {
    const command = track.command || agentTemplate || track.taskId;
    const taskUnit = trackToTaskUnit(track, this.workDir);
    taskUnit.timeout = timeoutMs;
    const startedAt = Date.now();

    const routeResult = this.colony.routeTask(taskUnit);
    const routeInfo = routeResult
      ? `routed to ${routeResult.agentId} (score=${routeResult.score}, reason=${routeResult.reason})`
      : "no routing preference (first-available)";
    appendLog(logFile,
      `[${nowIso()}] task=${track.taskId} [colony-dispatch]\nobjective: ${taskUnit.objective}\nrouting: ${routeInfo}\ntimeout: ${timeoutMs > 0 ? `${timeoutMs}ms` : "none"}\n---\n`
    );

    return new Promise((resolve) => {
      let timeoutHandle = null;
      const settle = (pollResult) => {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        const durationMs = Date.now() - startedAt;
        const result = colonyResultToRunnerResult(track.taskId, command, durationMs, logFile, pollResult);
        appendLog(logFile,
          `\n---\n[${nowIso()}] colony result: success=${result.success} durationMs=${durationMs}${result.timedOut ? " (TIMEOUT)" : ""}\n`
        );
        resolve(result);
      };

      this._pending.set(track.taskId, { resolve: settle });

      if (timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          if (this._pending.has(track.taskId)) {
            this._pending.delete(track.taskId);
            settle({
              state: "failed",
              evidence: {
                taskId: track.taskId, status: "failed",
                failureDetail: {
                  failureType: "timeout",
                  attempted: `Colony dispatch exceeded ${timeoutMs}ms`,
                  hypothesis: "Task timed out during colony dispatch.",
                },
              },
            });
          }
        }, timeoutMs + 5_000);
      }

      this.colony.submitTasks(taskUnit);
    });
  }

  async dispatchViaSpawn(track, agentTemplate, logFile, timeoutMs) {
    const command = track.command || agentTemplate || "";
    const startedAt = Date.now();
    appendLog(logFile,
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
          appendLog(logFile, `\n[${nowIso()}] timeout after ${timeoutMs}ms — sending SIGTERM\n`);
          child.kill("SIGTERM");
          setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* exited */ } }, 5_000);
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk) => appendLog(logFile, chunk.toString()));
      child.stderr.on("data", (chunk) => appendLog(logFile, chunk.toString()));

      child.on("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        const durationMs = Date.now() - startedAt;
        appendLog(logFile,
          `\n---\n[${nowIso()}] exit code=${code ?? -1} signal=${signal ?? "-"} durationMs=${durationMs}${timedOut ? " (TIMEOUT)" : ""}\n`
        );
        resolve({
          taskId: track.taskId, command,
          success: code === 0 && !timedOut,
          exitCode: code ?? -1, signal: signal ?? "",
          durationMs, timedOut, logFile,
        });
      });
    });
  }

  async shutdown() {
    if (this.colony) {
      try {
        for (const [taskId, entry] of this._pending) {
          entry.resolve({
            state: "failed",
            evidence: {
              taskId, status: "failed",
              failureDetail: { failureType: "unknown", attempted: "Colony shutdown", hypothesis: "Bridge shut down before task completed." },
            },
          });
        }
        this._pending.clear();
        await this.colony.shutdown();
      } catch { /* best-effort */ }
      this.colony = null;
    }
  }
}

function appendLog(logFile, message) {
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.appendFileSync(logFile, message, "utf8");
}
