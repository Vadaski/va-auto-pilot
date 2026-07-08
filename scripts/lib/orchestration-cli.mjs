import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DEFAULT_AGENT_TEMPLATE, parseArgv, resolveDefaults } from "./sprint-utils.mjs";
import { resolveHumanBoardPath } from "./human-board.mjs";
import { resolveActiveRunId, resolveOrchestrationDir } from "./orchestration-state.mjs";
import { resolveWorkspacePaths } from "./workspace.mjs";
import { DEFAULT_TRACK_TIMEOUT_MS, DEFAULT_MAX_PARALLEL } from "./constants.mjs";

const execFileAsync = promisify(execFile);

const SPRINT_BOARD = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
  "sprint-board.mjs"
);

export const ORCHESTRATE_BOOL_FLAGS = new Set([
  "json",
  "help",
  "dry-run",
  "no-commit",
  "no-colony",
  "strict",
  "waive-approvals",
  "waive-review",
  "reset-fail-count",
  "apply",
  "delegate-readonly",
  "with-delegates",
  "isolated",
  "isolated-tree",
  "shared-tree",
]);

export function buildOrchestrationOpts(argv, extra = {}) {
  const parsed = parseArgv(argv, ORCHESTRATE_BOOL_FLAGS);
  const workDir = process.cwd();
  const defaults = resolveDefaults(workDir);
  const explicitRunId = parsed.options["run-id"] ?? "";
  const runId = explicitRunId || (extra.resolveActiveRunId === false ? "" : resolveActiveRunId(workDir));

  // Workspace routing: resolve which backlog paths this run sees. Only activates
  // when the user explicitly selects a workspace (named, --isolated, or execution-
  // tree flags). Unspecified → "default" shared workspace → project-root defaults
  // (zero-config single-run behavior unchanged).
  const workspaceName = parsed.options["workspace"] ?? "";
  const isolatedWorkspace = parsed.flags.has("isolated") || workspaceName !== "";
  const workspace = resolveWorkspacePaths(workDir, {
    name: workspaceName || "default",
    isolated: isolatedWorkspace,
    fallback: {
      stateFile: defaults.stateFile,
      boardFile: defaults.boardFile,
      journalFile: defaults.journalFile,
      pitfallsFile: ".va-auto-pilot/pitfalls.json",
    },
  });
  const executionTree = parsed.flags.has("shared-tree")
    ? "shared"
    : parsed.flags.has("isolated-tree")
      ? "isolated"
      : workspace.type === "shared"
        ? "isolated" // 甲模式默认 isolated-tree (batch 4 enforces); shared-tree is expert opt-in
        : "isolated";

  return {
    ...extra,
    parsed,
    json: parsed.flags.has("json"),
    dryRun: parsed.flags.has("dry-run"),
    noCommit: parsed.flags.has("no-commit"),
    noColony: parsed.flags.has("no-colony"),
    strict: parsed.flags.has("strict"),
    waiveApprovals: parsed.flags.has("waive-approvals"),
    maxParallel: Number.parseInt(parsed.options["max-parallel"] ?? String(DEFAULT_MAX_PARALLEL), 10),
    runId,
    managerSurface: parsed.options["manager-surface"] ?? "unknown",
    tasks: parsed.options.tasks ?? "",
    reason: parsed.options.reason ?? "",
    worker: parsed.options.worker ?? "",
    workspace: {
      name: workspace.name,
      type: workspace.type,
      dir: workspace.dir,
      executionTree,
    },
    timeoutMs: Number.parseInt(parsed.options.timeout ?? String(DEFAULT_TRACK_TIMEOUT_MS), 10),
    pollIntervalMs: Number.parseInt(parsed.options["poll-interval"] ?? "2000", 10),
    stateFile: path.resolve(parsed.options["state-file"] ?? workspace.stateFile),
    boardFile: path.resolve(parsed.options["board-file"] ?? workspace.boardFile),
    journalFile: path.resolve(parsed.options["journal-file"] ?? workspace.journalFile),
    pitfallsFile: path.resolve(parsed.options["pitfalls-file"] ?? workspace.pitfallsFile),
    workDir: process.cwd(),
    agentTemplate: parsed.options["agent-template"] ?? DEFAULT_AGENT_TEMPLATE,
    trackTimeout: Number.parseInt(parsed.options["track-timeout"] ?? String(DEFAULT_TRACK_TIMEOUT_MS), 10),
    sprintBoardLock: Promise.resolve(),
    stateMutationLock: Promise.resolve(),
    taskBaselines: new Map(),
  };
}

function appendSprintBoardOptions(args, opts) {
  const finalArgs = [...args];
  const pushOption = (key, value) => {
    if (!value || finalArgs.includes(`--${key}`)) {
      return;
    }
    finalArgs.push(`--${key}`, value);
  };
  pushOption("state-file", opts.stateFile);
  pushOption("board-file", opts.boardFile);
  pushOption("journal-file", opts.journalFile);
  pushOption("pitfalls-file", opts.pitfallsFile);
  return finalArgs;
}

export async function sprintBoardExec(args, opts) {
  const run = async () => {
    try {
      const { stdout, stderr } = await execFileAsync(
        process.execPath,
        [SPRINT_BOARD, ...appendSprintBoardOptions(args, opts)],
        { encoding: "utf8", timeout: 120_000, cwd: opts.workDir }
      );
      return { stdout, stderr, exitCode: 0 };
    } catch (err) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? err.message,
        exitCode: typeof err.code === "number" ? err.code : 1,
      };
    }
  };
  const previous = opts.sprintBoardLock ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  opts.sprintBoardLock = next.then(() => undefined, () => undefined);
  return next;
}

export function tryParseJson(text) {
  try {
    return { parsed: true, value: JSON.parse(text) };
  } catch {
    return { parsed: false, value: null };
  }
}

export function emitResult(opts, payload, exitCode = 0) {
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stdout.write(`${payload.message ?? JSON.stringify(payload)}\n`);
  }
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
  return payload;
}

const WORKER_TEMPLATES = {
  codex: 'codex exec --full-auto -C . "Implement task {taskId}"',
  claude: 'claude -p --output-format text "Implement task {taskId} in this project"',
  kimi: 'kimi -w . --quiet -p "Implement task {taskId}"',
  spawn: DEFAULT_AGENT_TEMPLATE,
};

export function resolveWorkerAgentTemplate(worker, taskId) {
  const key = String(worker ?? "").toLowerCase();
  const template = WORKER_TEMPLATES[key] ?? DEFAULT_AGENT_TEMPLATE;
  return template.replaceAll("{taskId}", taskId);
}

export function buildWorkerOverrideCommands(workDir, readWorkerOverridesFn) {
  const map = {};
  for (const [taskId, worker] of readWorkerOverridesFn(workDir)) {
    map[taskId] = resolveWorkerAgentTemplate(worker, taskId);
  }
  return map;
}

export function fail(opts, code, message, context = {}, exitCode = 2) {
  const payload = { ok: false, error: { code, message, context } };
  if (opts.json) {
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  } else {
    process.stderr.write(`[${code}] ${message}\n`);
  }
  process.exit(exitCode);
}

/**
 * Pure helper to resolve the write roots for CLI operations given the
 * effective cwd and explicit flags. Used to make isolation testable
 * without spawning.
 * @param {{cwd?: string, stateFile?: string, journalFile?: string, runId?: string}} [input]
 */
export function resolveCliWriteRoots(input = {}) {
  const cwd = input.cwd || process.cwd();
  const stateOpt = input.stateFile;
  const journalOpt = input.journalFile;
  const runId = typeof input.runId === "string" ? input.runId : "";
  const d = resolveDefaults(cwd);
  const stateFile = path.resolve(stateOpt ?? path.resolve(cwd, d.stateFile));
  const journalFile = path.resolve(journalOpt ?? path.resolve(cwd, d.journalFile));
  const boardFile = resolveHumanBoardPath(stateFile);
  const orchDir = resolveOrchestrationDir(cwd, runId);
  return {
    cwd,
    stateFile,
    journalFile,
    boardFile,
    orchestrationDir: orchDir,
    candidateBacklog: path.join(orchDir, "candidate-backlog.json"),
  };
}
