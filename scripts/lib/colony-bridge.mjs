/**
 * ColonyBridge — va-agent-protocol Colony for task dispatch.
 *
 * Lifecycle: init() → dispatch() → shutdown()
 * Event-based completion (no polling). Auto-detects: codex, claude, gemini, kimi, glm.
 * Falls back to raw spawn if va-agent-protocol is not available.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_AGENT_TEMPLATE, nowIso } from "./sprint-utils.mjs";
import { splitShellCommand } from "./shell-split.mjs";
import {
  DEFAULT_TRACK_TIMEOUT_MS,
  LARGE_TASK_FILE_THRESHOLD,
  LARGE_TASK_DIFF_LINE_THRESHOLD,
  LARGE_TASK_OBJECTIVE_LENGTH_THRESHOLD,
  LARGE_TASK_ACCEPTANCE_CRITERIA_THRESHOLD
} from "./constants.mjs";

const execFileAsync = promisify(execFile);

// Dynamic import of va-agent-protocol — an OPTIONAL Colony enhancement.
// Resolution order keeps the package standalone with zero install:
//   1. VA_AGENT_PROTOCOL_PATH env  — explicit override (file or package dir)
//   2. "va-agent-protocol"          — installed npm package (the standard path)
//   3. monorepo sibling checkout   — back-compat for the local dev layout
// Any miss falls back to raw agent spawn, so Auto-Pilot runs fine without it.
let Colony = null;
let CodexAdapter = null;
let ClaudeCodeAdapter = null;
let GeminiAdapter = null;
let KimiAdapter = null;
let GlmAdapter = null;
let noopLogger = null;

async function resolveProtocolModule() {
  const targets = [];
  if (process.env.VA_AGENT_PROTOCOL_PATH) {
    targets.push(pathToFileURL(path.resolve(process.env.VA_AGENT_PROTOCOL_PATH)).href);
  }
  targets.push("va-agent-protocol");
  targets.push(new URL("../../../va-agent-protocol/dist/index.js", import.meta.url).href);
  for (const target of targets) {
    try {
      const mod = await import(target);
      if (mod?.Colony) return mod;
    } catch {
      // try next resolution strategy
    }
  }
  return null;
}

const protocol = await resolveProtocolModule();
Colony = protocol?.Colony ?? null;
CodexAdapter = protocol?.CodexAdapter ?? null;
ClaudeCodeAdapter = protocol?.ClaudeCodeAdapter ?? null;
GeminiAdapter = protocol?.GeminiAdapter ?? null;
KimiAdapter = protocol?.KimiAdapter ?? null;
GlmAdapter = protocol?.GlmAdapter ?? null;
noopLogger = protocol?.noopLogger ?? null;

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
 * @param {{ taskId: string, command?: string, title?: string, verification?: string[], notes?: string, priority?: string, dependsOn?: string[], qualityGates?: string[], metadata?: object }} track
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
  const metadata = {};
  if (track.qualityGates) metadata.qualityGates = track.qualityGates;
  if (track.metadata) Object.assign(metadata, track.metadata);
  if (Object.keys(metadata).length > 0) unit.metadata = metadata;
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

/**
 * Detect whether a task is a Sprint-level multi-file task that should avoid Kimi.
 * Thresholds: >3 files or >200 lines of diff.
 * Uses explicit scope metadata when available, falling back to text heuristics.
 */
export function isSprintLevelMultiFileTask(taskUnit) {
  const scope = taskUnit.metadata?.scope;
  if (scope) {
    if (scope.changedFileCount > LARGE_TASK_FILE_THRESHOLD) {
      return { isLarge: true, reason: `${scope.changedFileCount} changed files` };
    }
    if (scope.estimatedDiffLines > LARGE_TASK_DIFF_LINE_THRESHOLD) {
      return { isLarge: true, reason: `${scope.estimatedDiffLines} estimated diff lines` };
    }
  }

  const text = `${taskUnit.objective ?? ""} ${(taskUnit.constraints ?? []).join(" ")}`.toLowerCase();

  // Count explicit file references by common code extensions
  const fileRefs = [...text.matchAll(/\b[\w\-/]+\.(?:js|ts|mjs|cjs|jsx|tsx|py|go|rs|java|cpp|c|h|md|yaml|yml|json|html|css|scss)\b/g)]
    .map((m) => m[0]);
  const uniqueFiles = new Set(fileRefs);
  if (uniqueFiles.size > LARGE_TASK_FILE_THRESHOLD) {
    return { isLarge: true, reason: `${uniqueFiles.size} file references` };
  }

  // Objective length as a rough proxy for complexity
  const objective = String(taskUnit.objective ?? "");
  if (objective.length > LARGE_TASK_OBJECTIVE_LENGTH_THRESHOLD) {
    return { isLarge: true, reason: `objective length > ${LARGE_TASK_OBJECTIVE_LENGTH_THRESHOLD} chars` };
  }

  // Acceptance criteria count
  const acceptanceCriteria = taskUnit.acceptanceCriteria ?? [];
  if (acceptanceCriteria.length > LARGE_TASK_ACCEPTANCE_CRITERIA_THRESHOLD) {
    return { isLarge: true, reason: `${acceptanceCriteria.length} acceptance criteria` };
  }

  return { isLarge: false, reason: "" };
}

/**
 * Detect whether a command string contains shell constructs that
 * splitShellCommand cannot represent under shell:false: compact OR spaced
 * operators (`a>b`, `c1&&c2`, `|`, `;`), variable/command expansion (`$VAR`,
 * backticks — including inside double quotes, which bash expands), redirects,
 * sequences, leading env assignments (`VAR=value cmd`), and shell
 * builtins. Scans the RAW command while tracking quote/escape state, so quoted
 * literals are not flagged but compact operators are caught — token-only
 * detection misses `echo x>file` and silently misexecutes (echo prints the
 * literal "x>file" with exit 0). Favoring bash -lc on any doubt is safe: a
 * false positive just runs a plain command under bash, which still works.
 */
// Parentheses, braces, and glob chars are intentionally excluded: they appear
// in legal argument values (e.g. `node -e process.exit(42)`, regex patterns)
// and routing those through bash would let bash reinterpret them as
// sub-shells / brace / glob expansion and corrupt the argument. Sub-shells and
// command groups still route to bash via their `;` / `&` / newline.
const SHELL_METACHARS = new Set([
  "&", "|", "<", ">", ";", "`", "$", "\n"
]);
const SHELL_BUILTINS = new Set([
  "cd", "export", "source", "eval", "exec", "set", "unset",
  "alias", "read", "pushd", "popd", "exit", "trap", "umask"
]);

export function needsShellExecution(command) {
  if (typeof command !== "string" || command.length === 0) return false;

  // Leading environment assignment: `VAR=value cmd ...`
  if (/^\s*[A-Za-z_][A-Za-z0-9_]*=/.test(command)) return true;

  // Shell builtin as the first token.
  const firstToken = command.trimStart().split(/\s+/, 1)[0] ?? "";
  if (SHELL_BUILTINS.has(firstToken)) return true;

  // Scan for shell metacharacters outside single quotes. Double quotes still
  // allow $ and ` expansion in bash, so those trigger too.
  let quote = null;
  let escape = false;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (escape) { escape = false; continue; }
    if (quote === "'") {
      if (ch === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { quote = null; continue; }
      if (ch === "$" || ch === "`") return true;
      continue;
    }
    if (ch === "\\") { escape = true; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (SHELL_METACHARS.has(ch)) return true;
  }
  return false;
}

/**
 * Expand a leading `~` or `~/` to the user's home directory, mirroring the
 * shell behavior lost by spawning directly instead of through `bash -lc`.
 * Only a standalone `~` or `~/...` token expands (shell expands tilde only at
 * the start of a word); `--flag=~` / `a~b` pass through unchanged.
 */
function expandTilde(token) {
  if (typeof token !== "string") return token;
  if (token === "~") return os.homedir();
  if (token.startsWith("~/")) return path.join(os.homedir(), token.slice(2));
  return token;
}

function quoteShellArg(value) {
  return `'${String(value).replaceAll("'", "'\"'\"'")}'`;
}

function buildClaudePromptCommand(promptText) {
  return `claude -p --output-format text ${quoteShellArg(promptText)}`;
}

export function buildDefaultAgentCommand(taskId) {
  return buildClaudePromptCommand(`Implement task ${taskId} in this project`);
}

function interpolateAgentTemplate(agentTemplate, taskId) {
  if (!agentTemplate) {
    return "";
  }
  return agentTemplate.includes("{taskId}")
    ? agentTemplate.replaceAll("{taskId}", taskId)
    : agentTemplate;
}

function stripWrappingQuotes(value) {
  if (value.length >= 2) {
    const quote = value[0];
    if ((quote === "'" || quote === "\"") && value.at(-1) === quote) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function normalizeLegacyClaudeTaskCommand(rawCommand, taskId) {
  const match = rawCommand.match(/^claude\s+--task(?:=|\s+)(.+)$/);
  if (!match) {
    return "";
  }

  const rawPrompt = stripWrappingQuotes(match[1].trim());
  if (!rawPrompt || rawPrompt === taskId) {
    return buildDefaultAgentCommand(taskId);
  }

  return buildClaudePromptCommand(rawPrompt);
}

export function resolveSpawnCommand(track, agentTemplate) {
  const rawCommand = String(track.command || interpolateAgentTemplate(agentTemplate, track.taskId) || "").trim();
  if (!rawCommand) {
    return "";
  }

  const normalizedLegacyClaudeCommand = normalizeLegacyClaudeTaskCommand(rawCommand, track.taskId);
  if (normalizedLegacyClaudeCommand) {
    return normalizedLegacyClaudeCommand;
  }

  const legacyDefaultCommand = interpolateAgentTemplate("claude --task {taskId}", track.taskId);
  const modernDefaultCommand = DEFAULT_AGENT_TEMPLATE.includes("claude")
    ? interpolateAgentTemplate(DEFAULT_AGENT_TEMPLATE, track.taskId)
    : "";
  if (rawCommand === legacyDefaultCommand || (modernDefaultCommand && rawCommand === modernDefaultCommand)) {
    return buildDefaultAgentCommand(track.taskId);
  }

  return rawCommand;
}

// CLI adapter config table (GLM is API-based, handled separately)
const ADAPTER_CONFIGS = [
  { Adapter: () => CodexAdapter, bin: "codex", optKey: "codexPath" },
  { Adapter: () => ClaudeCodeAdapter, bin: "claude", optKey: "claudePath" },
  { Adapter: () => GeminiAdapter, bin: "gemini", optKey: "geminiPath" },
  { Adapter: () => KimiAdapter, bin: "kimi", optKey: "kimiPath" },
];

export function signalProcessTree(child, signal = "SIGTERM") {
  if (!child?.pid) {
    return false;
  }
  try {
    if (process.platform === "win32") {
      return child.kill(signal);
    }
    process.kill(-child.pid, signal);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

export class ColonyBridge {
  constructor(options = {}) {
    this.workDir = options.workDir || process.cwd();
    this.colony = null;
    this.useColony = !!Colony && options.useColony !== false;
    this.registeredAdapters = [];
    this._pending = new Map();
    /** @type {Map<string, import("node:child_process").ChildProcess>} */
    this._spawnChildren = new Map();
  }

  /** Cancel a running track (spawn SIGTERM; colony best-effort). */
  cancelTrack(taskId) {
    const child = this._spawnChildren.get(taskId);
    if (child && child.pid) {
      try {
        signalProcessTree(child, "SIGTERM");
        return { cancelled: true, method: "spawn", pid: child.pid };
      } catch {
        return { cancelled: false, method: "spawn", pid: child.pid };
      }
    }
    if (this.colony?.cancelTask) {
      try {
        this.colony.cancelTask(taskId);
        return { cancelled: true, method: "colony" };
      } catch {
        return { cancelled: false, method: "colony" };
      }
    }
    return { cancelled: false, method: "none" };
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
          taskTimeoutMs: DEFAULT_TRACK_TIMEOUT_MS, qualityGates: [], logger,
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
              taskTimeoutMs: DEFAULT_TRACK_TIMEOUT_MS, qualityGates: [], logger,
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
    if (this.colony) {
      const taskUnit = trackToTaskUnit(track, this.workDir);
      const largeCheck = isSprintLevelMultiFileTask(taskUnit);
      if (largeCheck.isLarge) {
        const routeResult = this.colony.routeTask(taskUnit);
        if (routeResult && /kimi/i.test(routeResult.agentId)) {
          appendLog(logFile,
            `[${nowIso()}] task=${track.taskId} [colony-bypass]\nreason: ${largeCheck.reason}; would route to ${routeResult.agentId}\nfalling back to agentTemplate spawn\n---\n`
          );
          return this.dispatchViaSpawn(track, agentTemplate, logFile, timeoutMs);
        }
      }
      return this.dispatchViaColony(track, agentTemplate, logFile, timeoutMs);
    }
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
            this.cancelTrack(track.taskId);
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
    const command = resolveSpawnCommand(track, agentTemplate);
    const startedAt = Date.now();
    appendLog(logFile,
      `[${nowIso()}] task=${track.taskId}\ncommand: ${command}\ntimeout: ${timeoutMs > 0 ? `${timeoutMs}ms` : "none"}\n---\n`
    );

    if (!command) {
      appendLog(logFile, `\n[${nowIso()}] spawn skipped: empty command\n`);
      return {
        taskId: track.taskId,
        command,
        success: false,
        exitCode: 1,
        signal: "",
        durationMs: Date.now() - startedAt,
        timedOut: false,
        logFile,
      };
    }

    const argv = splitShellCommand(command);
    const useShell = needsShellExecution(command);
    // Shell constructs (operators, variable expansion, sub-shells, builtins like
    // `cd`) cannot be represented by splitShellCommand — route them through
    // `bash -lc` so documented shell-style agent templates keep working. Plain
    // commands spawn directly with shell:false for control and safety.
    const spawnTarget = useShell
      ? { file: "bash", args: ["-lc", command] }
      : { file: expandTilde(argv[0]), args: argv.slice(1).map(expandTilde) };

    return new Promise((resolve) => {
      const child = spawn(spawnTarget.file, spawnTarget.args, {
        cwd: this.workDir,
        shell: false,
        detached: process.platform !== "win32",
        env: {
          ...process.env,
          VA_TASK_ID: track.taskId,
          VA_TASK_NOTES: track.notes ?? ""
        },
      });
      this._spawnChildren.set(track.taskId, child);
      let timedOut = false;
      let killTimer = null;
      let forceKillTimer = null;

      if (timeoutMs > 0) {
        killTimer = setTimeout(() => {
          timedOut = true;
          appendLog(logFile, `\n[${nowIso()}] timeout after ${timeoutMs}ms — sending SIGTERM\n`);
          try { signalProcessTree(child, "SIGTERM"); } catch { /* best-effort */ }
          forceKillTimer = setTimeout(() => {
            try { signalProcessTree(child, "SIGKILL"); } catch { /* exited */ }
          }, 5_000);
        }, timeoutMs);
      }

      child.stdout.on("data", (chunk) => appendLog(logFile, chunk.toString()));
      child.stderr.on("data", (chunk) => appendLog(logFile, chunk.toString()));

      // Missing executable / spawn failure: without this listener Node rethrows
      // the 'error' event and crashes the whole loop. Resolve as a failed track
      // so the sprint can classify and recover (mirrors the old `bash -lc`
      // exit-127 path when a CLI binary is unavailable).
      child.on("error", (err) => {
        if (killTimer) clearTimeout(killTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this._spawnChildren.delete(track.taskId);
        const durationMs = Date.now() - startedAt;
        appendLog(logFile, `\n[${nowIso()}] spawn error: ${err.message}\n`);
        resolve({
          taskId: track.taskId,
          command,
          success: false,
          exitCode: 127,
          signal: "",
          durationMs,
          timedOut: false,
          logFile,
          pid: child.pid ?? null,
        });
      });

      child.on("close", (code, signal) => {
        if (killTimer) clearTimeout(killTimer);
        if (forceKillTimer) clearTimeout(forceKillTimer);
        this._spawnChildren.delete(track.taskId);
        const durationMs = Date.now() - startedAt;
        appendLog(logFile,
          `\n---\n[${nowIso()}] exit code=${code ?? -1} signal=${signal ?? "-"} durationMs=${durationMs}${timedOut ? " (TIMEOUT)" : ""}\n`
        );
        resolve({
          taskId: track.taskId, command,
          success: code === 0 && !timedOut,
          exitCode: code ?? -1, signal: signal ?? "",
          durationMs, timedOut, logFile, pid: child.pid ?? null,
        });
      });
    });
  }

  async shutdown() {
    for (const child of this._spawnChildren.values()) {
      try { signalProcessTree(child, "SIGTERM"); } catch { /* best-effort */ }
    }
    this._spawnChildren.clear();
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
