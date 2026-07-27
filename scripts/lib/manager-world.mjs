import path from "node:path";
import { execFileSync } from "node:child_process";

import { validateArchitecturePlanBinding } from "./plan-review.mjs";
import { isTerminalRunPhase, readActiveRuns, readRun } from "./orchestration-state.mjs";

const RUNTIME_PREFIXES = [
  ".va-auto-pilot/orchestration/",
  ".va-auto-pilot/evidence/",
  ".va-auto-pilot/parallel-runs/",
  ".va/worktrees/",
];

/**
 * Normalize a git porcelain path relative to the repo root.
 * @param {string} line
 */
export function porcelainPath(line) {
  return String(line ?? "").slice(3).replace(/^"|"$/g, "").trim();
}

/**
 * Classify dirty files the way isolated commit cares about them.
 * @param {string[]} porcelainLines
 * @param {{
 *   workDir: string,
 *   allowedControlFiles?: string[],
 *   runtimeWorktreePaths?: string[],
 * }} opts
 */
export function classifyIntegrationDirty(porcelainLines, opts) {
  const workDir = opts.workDir;
  const allowedControl = new Set(
    (opts.allowedControlFiles ?? [])
      .filter(Boolean)
      .map((file) => toRepoPath(file, workDir))
      .filter(Boolean)
  );
  const worktreePrefixes = (opts.runtimeWorktreePaths ?? [])
    .map((file) => toRepoPath(file, workDir))
    .filter(Boolean)
    .map((file) => `${file.replace(/\/+$/, "")}/`);

  const commitBlocking = [];
  const allowedRuntime = [];

  for (const line of porcelainLines ?? []) {
    if (!line) continue;
    const file = porcelainPath(line);
    if (!file) continue;
    const runtime = RUNTIME_PREFIXES.some((prefix) => file.startsWith(prefix))
      || worktreePrefixes.some((prefix) => file.startsWith(prefix))
      || allowedControl.has(file);
    if (runtime) {
      allowedRuntime.push(file);
    } else {
      commitBlocking.push(file);
    }
  }

  return {
    cleanForCommit: commitBlocking.length === 0,
    commitBlocking: commitBlocking.slice(0, 20),
    commitBlockingCount: commitBlocking.length,
    allowedRuntime: allowedRuntime.slice(0, 20),
    allowedRuntimeCount: allowedRuntime.length,
  };
}

/**
 * @param {string} filePath
 * @param {string} repoRoot
 */
function toRepoPath(filePath, repoRoot) {
  const relativePath = path.relative(repoRoot, path.resolve(filePath));
  if (!relativePath || relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return "";
  }
  return relativePath.replace(/\\/g, "/");
}

/**
 * @param {string} workDir
 */
export function readIntegrationDirty(workDir, opts = {}) {
  let porcelainLines = [];
  let available = true;
  try {
    const stdout = execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], {
      cwd: workDir,
      encoding: "utf8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    porcelainLines = stdout.split(/\r?\n/).filter(Boolean);
  } catch {
    available = false;
  }
  return {
    available,
    ...classifyIntegrationDirty(porcelainLines, { workDir, ...opts }),
  };
}

/**
 * @param {object|null|undefined} candidatePlan
 * @param {string} workDir
 */
export function buildBindingSummary(candidatePlan, workDir) {
  const binding = candidatePlan?.architecturePlanBinding;
  if (!binding) {
    return {
      present: false,
      path: null,
      sha256: null,
      ok: null,
      code: null,
      message: "no architecturePlanBinding on candidate plan",
    };
  }
  const check = validateArchitecturePlanBinding(candidatePlan, workDir);
  if (check.ok === false) {
    return {
      present: true,
      path: binding.path ?? null,
      sha256: binding.sha256 ?? null,
      bytes: binding.bytes ?? null,
      materializeIntoWorktree: binding.materializeIntoWorktree === true,
      ok: false,
      code: check.code ?? "BINDING_INVALID",
      message: check.message ?? "binding invalid",
      actualSha256: null,
    };
  }
  return {
    present: true,
    path: binding.path ?? null,
    sha256: binding.sha256 ?? null,
    bytes: binding.bytes ?? null,
    materializeIntoWorktree: binding.materializeIntoWorktree === true,
    ok: true,
    code: null,
    message: "architecture plan bytes match binding",
    actualSha256: check.actualSha256 ?? binding.sha256,
  };
}

/**
 * @param {{ tasks?: any[] }} state
 * @param {string} [selectedRunId]
 */
export function buildClaimsSummary(state, selectedRunId = "") {
  const now = Date.now();
  const claims = [];
  for (const task of state?.tasks ?? []) {
    const claimedBy = String(task?.claimedBy ?? "").trim();
    if (!claimedBy) continue;
    const expiresAt = String(task?.claimExpiresAt ?? "").trim();
    const expired = Boolean(expiresAt) && Number.isFinite(Date.parse(expiresAt)) && Date.parse(expiresAt) <= now;
    claims.push({
      taskId: task.id,
      state: task.state ?? null,
      claimedBy,
      claimExpiresAt: expiresAt || null,
      expired,
      ownedBySelectedRun: Boolean(selectedRunId) && claimedBy === selectedRunId,
    });
  }
  return {
    count: claims.length,
    expiredCount: claims.filter((item) => item.expired).length,
    selectedRunCount: claims.filter((item) => item.ownedBySelectedRun).length,
    items: claims.slice(0, 20),
  };
}

/**
 * Active-index runs that are easy for a Manager to mistake for the working line.
 * @param {{
 *   workDir: string,
 *   selectedRunId?: string,
 *   selectedWorkspaceName?: string,
 *   activeEntries?: Array<{ runId: string, heartbeatAt?: string, startedAt?: string }>,
 *   readRunFn?: typeof readRun,
 * }} input
 */
export function buildDistractionRuns(input) {
  const workDir = input.workDir;
  const selectedRunId = input.selectedRunId ?? "";
  const selectedWorkspace = input.selectedWorkspaceName ?? "";
  const read = input.readRunFn ?? readRun;
  const entries = Array.isArray(input.activeEntries) ? input.activeEntries : readActiveRuns(workDir);
  const distractions = [];

  for (const entry of entries) {
    const runId = String(entry?.runId ?? "").trim();
    if (!runId || runId === selectedRunId) continue;
    const run = read(workDir, runId);
    if (!run) {
      distractions.push({
        runId,
        phase: null,
        workspace: null,
        reason: "active-index entry has no readable run.json",
        kind: "orphaned-active-entry",
      });
      continue;
    }
    const phase = run.phase ?? null;
    const workspaceName = run.workspace?.name ?? "default";
    const terminal = isTerminalRunPhase(phase);
    const halted = phase === "halted" || Boolean(run.directives?.halt);
    const differentWorkspace = Boolean(selectedWorkspace) && workspaceName !== selectedWorkspace;
    let kind = "other-active-run";
    let reason = "another run is still listed as active";
    // Prefer halted over generic terminal so Managers see the more specific hazard.
    if (halted) {
      kind = "halted";
      reason = "run is halted and should not be treated as the working line";
    } else if (terminal) {
      kind = "terminal-still-active";
      reason = `run phase is terminal (${phase}) but still present in the active-run index`;
    } else if (differentWorkspace) {
      kind = "different-workspace";
      reason = `run belongs to workspace "${workspaceName}", not selected "${selectedWorkspace}"`;
    }
    if (terminal || halted || differentWorkspace || kind === "other-active-run") {
      distractions.push({
        runId,
        phase,
        workspace: workspaceName,
        workspaceType: run.workspace?.type ?? null,
        kind,
        reason,
        heartbeatAt: entry.heartbeatAt ?? null,
      });
    }
  }

  return distractions;
}

/**
 * Build the Manager-facing world model. Paths stay free; this only tells the truth.
 * @param {{
 *   workDir: string,
 *   run?: any,
 *   opts?: { stateFile?: string, boardFile?: string, journalFile?: string, pitfallsFile?: string },
 *   state?: { tasks?: any[] },
 *   checkpointStatus?: any,
 *   legalNextActions?: any[],
 *   activeEntries?: any[],
 *   integrationDirty?: any,
 * }} input
 */
export function buildManagerWorld(input) {
  const workDir = input.workDir;
  const run = input.run ?? null;
  const opts = input.opts ?? {};
  const selectedRunId = run?.runId ?? null;
  const workspace = run?.workspace
    ? {
      name: run.workspace.name ?? "default",
      type: run.workspace.type ?? null,
      executionTree: run.workspace.executionTree ?? null,
      stateFile: run.workspace.stateFile ?? opts.stateFile ?? null,
    }
    : {
      name: "default",
      type: null,
      executionTree: null,
      stateFile: opts.stateFile ?? null,
    };

  const integrationDirty = input.integrationDirty ?? readIntegrationDirty(workDir, {
    allowedControlFiles: [
      opts.stateFile,
      opts.boardFile,
      opts.journalFile,
      opts.pitfallsFile,
    ].filter(Boolean),
  });

  const distractionRuns = buildDistractionRuns({
    workDir,
    selectedRunId: selectedRunId ?? "",
    selectedWorkspaceName: workspace.name ?? "",
    activeEntries: input.activeEntries,
  });

  const legalNextActions = Array.isArray(input.legalNextActions) ? input.legalNextActions : [];
  const selectionWarning = distractionRuns.some((item) => item.kind === "terminal-still-active" || item.kind === "halted")
    ? "Active-run index contains terminal/halted runs; do not assume the selected run is the only or intended working line."
    : distractionRuns.some((item) => item.kind === "different-workspace")
      ? "Other active runs belong to a different workspace than the selected run."
      : null;

  return {
    schemaVersion: 1,
    audience: "session-manager-agent",
    principle: "honest world model; hard invariants; tactical path left to the manager agent",
    selectedRun: {
      runId: selectedRunId,
      phase: run?.phase ?? "idle",
      approvedPlanId: run?.approvedPlanId ?? null,
      managerSurface: run?.manager?.surface ?? null,
      terminal: isTerminalRunPhase(run?.phase),
    },
    workspace,
    claims: buildClaimsSummary(input.state ?? { tasks: [] }, selectedRunId ?? ""),
    binding: buildBindingSummary(run?.candidatePlan, workDir),
    integrationDirty,
    checkpointStale: {
      exists: input.checkpointStatus?.exists === true,
      stale: input.checkpointStatus?.stale === true,
      reason: input.checkpointStatus?.reason ?? "",
      humanReason: input.checkpointStatus?.humanReason ?? "",
      blocksDispatch: input.checkpointStatus?.blocksDispatch === true,
      requiresReapproval: input.checkpointStatus?.requiresReapproval === true,
    },
    distractionRuns,
    selectionWarning,
    legalNextActions,
  };
}

/**
 * Prefer actions that correct a misleading active-run selection.
 * @param {any[]} actions
 * @param {any} managerWorld
 */
export function prioritizeManagerWorldActions(actions, managerWorld) {
  const next = Array.isArray(actions) ? [...actions] : [];
  if (!managerWorld?.distractionRuns?.length) {
    return next;
  }
  const tip = "choose the intended workspace/run explicitly; do not follow a halted or terminal distraction run";
  if (!next.includes(tip)) {
    next.unshift(tip);
  }
  return next;
}

/**
 * @param {any[]} commands
 * @param {any} managerWorld
 */
export function prioritizeManagerWorldCommands(commands, managerWorld) {
  const next = Array.isArray(commands) ? [...commands] : [];
  if (!managerWorld?.distractionRuns?.length) {
    return next;
  }
  const workspace = managerWorld.workspace?.name;
  const tip = {
    label: "List runs before acting",
    argv: ["node", "scripts/auto-pilot.mjs", "orchestrate", "list-runs", "--json"],
    reason: "Distraction runs are active; confirm the intended working line before plan/dispatch.",
  };
  const initTip = workspace && workspace !== "default"
    ? {
      label: "Init intended workspace run",
      argv: [
        "node",
        "scripts/auto-pilot.mjs",
        "orchestrate",
        "init",
        "--workspace",
        workspace,
        "--isolated",
        "--manager-surface",
        "cursor",
      ],
      reason: `Selected/intended workspace appears to be "${workspace}"; start there instead of a halted default line.`,
    }
    : {
      label: "Init fresh manager run",
      argv: ["node", "scripts/auto-pilot.mjs", "orchestrate", "init", "--manager-surface", "cursor"],
      reason: "Start a fresh run rather than continuing a terminal/halted distraction run.",
    };
  const withoutDup = next.filter((item) => item?.label !== tip.label && item?.label !== initTip.label);
  return [tip, initTip, ...withoutDup];
}
