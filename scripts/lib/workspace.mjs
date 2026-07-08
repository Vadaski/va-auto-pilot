import fs from "node:fs";
import path from "node:path";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./pilot-state.mjs";

/**
 * Workspace = isolation boundary that owns the task backlog (sprint-state)
 * and its derived board/journal/pitfalls paths. A Run binds to a Workspace.
 *
 * Workspace types:
 *  - "shared":    backlog lives at the project root (default paths). Multiple
 *                 runs share one backlog — the "协作" (cooperative) mode.
 *  - "isolated":  backlog lives under .va-auto-pilot/workspaces/<name>/, fully
 *                 independent — the "独立冲刺线" (independent sprint) mode.
 *
 * Execution-tree isolation (per-run git worktree) is orthogonal and handled by
 * worktree-isolation; it composes with either workspace type. In shared mode the
 * default execution tree is isolated anyway (see batch 4), so concurrent runs on
 * a shared backlog do not stomp each other's working tree.
 *
 * This module is a *routing layer only* — it resolves which paths a run sees.
 * It deliberately does NOT move sprint-state.json's default location, so the
 * zero-config single-run experience is unchanged (Kimi's recommendation).
 */

export const WORKSPACE_SCHEMA_VERSION = 1;

/** @returns {string} the directory holding all workspace metadata */
export function resolveWorkspacesRoot(workDir = process.cwd()) {
  return path.resolve(workDir, ".va-auto-pilot", "workspaces");
}

/** @returns {string} the workspace.json path for a given workspace name */
export function resolveWorkspaceDir(workDir, name) {
  return path.resolve(resolveWorkspacesRoot(workDir), sanitizeWorkspaceName(name));
}

function sanitizeWorkspaceName(name) {
  const cleaned = String(name ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "default";
}

export const DEFAULT_WORKSPACE_NAME = "default";

/**
 * Resolve the effective path set for a workspace. Pure: reads workspace.json if
 * present, else falls back to defaults. Used by buildOrchestrationOpts to route
 * every downstream command (and every spawned sprint-board subprocess) to the
 * correct backlog.
 *
 * @param {string} workDir
 * @param {{ name?: string, isolated?: boolean, fallback?: { stateFile: string, boardFile: string, journalFile: string, pitfallsFile: string } }} [options]
 * @returns {{ name: string, type: "shared"|"isolated", stateFile: string, boardFile: string, journalFile: string, pitfallsFile: string, dir: string, existed: boolean }}
 */
export function resolveWorkspacePaths(workDir, options = {}) {
  const name = sanitizeWorkspaceName(options.name ?? DEFAULT_WORKSPACE_NAME);
  const fallback = options.fallback ?? {
    stateFile: ".va-auto-pilot/sprint-state.json",
    boardFile: "docs/todo/sprint.md",
    journalFile: "docs/todo/run-journal.md",
    pitfallsFile: ".va-auto-pilot/pitfalls.json",
  };
  const wsDir = resolveWorkspaceDir(workDir, name);
  const wsFile = path.join(wsDir, "workspace.json");

  if (!fs.existsSync(wsFile)) {
    // No persisted workspace → resolve by intent. Isolated requested (or name is
    // not "default") → workspace-scoped paths. Otherwise → project-root defaults.
    const isolated = options.isolated === true || name !== DEFAULT_WORKSPACE_NAME;
    return {
      name,
      type: isolated ? "isolated" : "shared",
      stateFile: isolated ? path.join(wsDir, "sprint-state.json") : path.resolve(workDir, fallback.stateFile),
      boardFile: isolated ? path.join(wsDir, "sprint.md") : path.resolve(workDir, fallback.boardFile),
      journalFile: isolated ? path.join(wsDir, "run-journal.md") : path.resolve(workDir, fallback.journalFile),
      pitfallsFile: isolated ? path.join(wsDir, "pitfalls.json") : path.resolve(workDir, fallback.pitfallsFile),
      dir: wsDir,
      existed: false,
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(wsFile, "utf8"));
    const type = parsed?.type === "isolated" ? "isolated" : "shared";
    return {
      name,
      type,
      stateFile: parsed?.stateFile || path.resolve(workDir, fallback.stateFile),
      boardFile: parsed?.boardFile || path.resolve(workDir, fallback.boardFile),
      journalFile: parsed?.journalFile || path.resolve(workDir, fallback.journalFile),
      pitfallsFile: parsed?.pitfallsFile || path.resolve(workDir, fallback.pitfallsFile),
      dir: wsDir,
      existed: true,
    };
  } catch {
    return resolveWorkspacePaths(workDir, { ...options, name });
  }
}

/**
 * Persist a workspace definition so its type is stable across runs. Called on
 * init when the user explicitly opts into a workspace (e.g. --isolated-tree or
 * a named workspace).
 */
export async function writeWorkspace(workDir, definition) {
  const name = sanitizeWorkspaceName(definition?.name ?? DEFAULT_WORKSPACE_NAME);
  const wsDir = resolveWorkspaceDir(workDir, name);
  fs.mkdirSync(wsDir, { recursive: true });
  const wsFile = path.join(wsDir, "workspace.json");
  const value = {
    schemaVersion: WORKSPACE_SCHEMA_VERSION,
    name,
    type: definition?.type === "isolated" ? "isolated" : "shared",
    stateFile: definition?.stateFile ?? "",
    boardFile: definition?.boardFile ?? "",
    journalFile: definition?.journalFile ?? "",
    pitfallsFile: definition?.pitfallsFile ?? "",
    executionTree: definition?.executionTree ?? "shared",
    baseRef: definition?.baseRef ?? "",
    createdAt: definition?.createdAt ?? "",
  };
  await withPilotFileLock(wsFile, async () => {
    writeJsonFileAtomicSync(wsFile, value);
  });
  return value;
}
