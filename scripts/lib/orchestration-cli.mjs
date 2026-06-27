import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { DEFAULT_AGENT_TEMPLATE, parseArgv, resolveDefaults } from "./sprint-utils.mjs";

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
]);

export function buildOrchestrationOpts(argv, extra = {}) {
  const parsed = parseArgv(argv, ORCHESTRATE_BOOL_FLAGS);
  const defaults = resolveDefaults();
  return {
    ...extra,
    parsed,
    json: parsed.flags.has("json"),
    dryRun: parsed.flags.has("dry-run"),
    noCommit: parsed.flags.has("no-commit"),
    noColony: parsed.flags.has("no-colony"),
    strict: parsed.flags.has("strict"),
    waiveApprovals: parsed.flags.has("waive-approvals"),
    maxParallel: Number.parseInt(parsed.options["max-parallel"] ?? "3", 10),
    runId: parsed.options["run-id"] ?? "",
    managerSurface: parsed.options["manager-surface"] ?? "unknown",
    tasks: parsed.options.tasks ?? "",
    reason: parsed.options.reason ?? "",
    worker: parsed.options.worker ?? "",
    timeoutMs: Number.parseInt(parsed.options.timeout ?? "600000", 10),
    pollIntervalMs: Number.parseInt(parsed.options["poll-interval"] ?? "2000", 10),
    stateFile: path.resolve(parsed.options["state-file"] ?? defaults.stateFile),
    boardFile: path.resolve(parsed.options["board-file"] ?? defaults.boardFile),
    journalFile: path.resolve(parsed.options["journal-file"] ?? defaults.journalFile),
    pitfallsFile: path.resolve(parsed.options["pitfalls-file"] ?? ".va-auto-pilot/pitfalls.json"),
    workDir: process.cwd(),
    agentTemplate: parsed.options["agent-template"] ?? DEFAULT_AGENT_TEMPLATE,
    trackTimeout: Number.parseInt(parsed.options["track-timeout"] ?? "600000", 10),
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
