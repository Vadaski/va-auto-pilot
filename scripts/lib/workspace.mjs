import fs from "node:fs";
import path from "node:path";
import { withPilotFileLock, writeJsonFileAtomicSync } from "./pilot-state.mjs";
import { assertSafeIdentifier } from "./identifiers.mjs";

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
const WORKSPACE_STATE_FILE_NAME = "sprint-state.json";

function isInsideDir(parent, target) {
  const relative = path.relative(parent, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** @returns {string} the directory holding all workspace metadata */
export function resolveWorkspacesRoot(workDir = process.cwd()) {
  return path.resolve(workDir, ".va-auto-pilot", "workspaces");
}

/** @returns {string} the workspace.json path for a given workspace name */
export function resolveWorkspaceDir(workDir, name) {
  const root = resolveWorkspacesRoot(workDir);
  const workspaceName = sanitizeWorkspaceName(name);
  const resolved = path.resolve(root, workspaceName);
  if (!resolved.startsWith(`${root}${path.sep}`)) {
    throw new Error(`workspace path escapes the managed workspace root: ${workspaceName}`);
  }
  return resolved;
}

/**
 * Resolve the isolated workspace directory from a managed sprint-state path.
 * Returns null for the default integration sprint-state.
 *
 * @param {string} stateFile
 * @returns {string | null}
 */
export function resolveWorkspaceDirFromStateFile(stateFile) {
  const resolved = path.resolve(stateFile);
  if (path.basename(resolved) !== WORKSPACE_STATE_FILE_NAME) {
    return null;
  }
  const workspaceDir = path.dirname(resolved);
  const workspacesDir = path.dirname(workspaceDir);
  const pilotDir = path.dirname(workspacesDir);
  if (path.basename(workspacesDir) !== "workspaces" || path.basename(pilotDir) !== ".va-auto-pilot") {
    return null;
  }
  return workspaceDir;
}

function resolveWorkspaceDirFromManagedPath(filePath) {
  let current = path.resolve(filePath);
  while (true) {
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    if (path.basename(parent) === "workspaces"
        && path.basename(path.dirname(parent)) === ".va-auto-pilot") {
      return current;
    }
    current = parent;
  }
}

function resolveProjectRootFromWorkspaceDir(workspaceDir) {
  return path.dirname(path.dirname(path.dirname(workspaceDir)));
}

/**
 * Resolve the project root that owns a managed sprint-state path.
 *
 * @param {string} stateFile
 * @param {string} [workDir]
 * @returns {string}
 */
export function resolveProjectRootFromStateFile(stateFile, workDir = process.cwd()) {
  const resolved = path.resolve(stateFile);
  const workspaceDir = resolveWorkspaceDirFromStateFile(resolved);
  if (workspaceDir) {
    return resolveProjectRootFromWorkspaceDir(workspaceDir);
  }
  if (path.basename(resolved) === WORKSPACE_STATE_FILE_NAME
      && path.basename(path.dirname(resolved)) === ".va-auto-pilot") {
    return path.dirname(path.dirname(resolved));
  }
  return path.resolve(workDir);
}

/**
 * Resolve a workspace-aware sibling artifact path. When `stateFile` points to an
 * isolated workspace backlog, omitted sibling paths must stay under that same
 * workspace instead of silently falling back to the integration root.
 *
 * @param {string} stateFile
 * @param {string} workspaceRelative
 * @param {string} projectRelative
 * @param {string} [workDir]
 * @returns {string}
 */
export function resolveWorkspaceSiblingPath(
  stateFile,
  workspaceRelative,
  projectRelative,
  workDir = process.cwd()
) {
  const workspaceDir = resolveWorkspaceDirFromStateFile(stateFile);
  if (workspaceDir) {
    return path.join(workspaceDir, workspaceRelative);
  }
  return path.resolve(workDir, projectRelative);
}

/**
 * Validate that managed artifact paths do not mix an isolated workspace root
 * with integration-root paths. This prevents `--state-file` from rebinding only
 * one artifact while sibling writes still target the default tree.
 *
 * @param {{ stateFile: string, boardFile?: string, journalFile?: string, pitfallsFile?: string, historyFile?: string, metaFile?: string }} paths
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateWorkspaceArtifactRoots(paths) {
  const errors = [];
  const stateFile = path.resolve(paths.stateFile);
  const workspaceDir = resolveWorkspaceDirFromStateFile(stateFile);
  if (!workspaceDir) {
    for (const [label, filePath] of Object.entries(paths)) {
      if (label === "stateFile" || !filePath) {
        continue;
      }
      const otherWorkspaceDir = resolveWorkspaceDirFromManagedPath(filePath);
      if (otherWorkspaceDir) {
        errors.push(`${label} uses isolated workspace root ${otherWorkspaceDir} while stateFile stays on the integration root`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  const projectRoot = resolveProjectRootFromWorkspaceDir(workspaceDir);
  for (const [label, filePath] of Object.entries(paths)) {
    if (label === "stateFile" || !filePath) {
      continue;
    }
    const resolved = path.resolve(filePath);
    const otherWorkspaceDir = resolveWorkspaceDirFromManagedPath(resolved);
    if (otherWorkspaceDir && otherWorkspaceDir !== workspaceDir) {
      errors.push(`${label} targets a different workspace root: expected ${workspaceDir}, got ${otherWorkspaceDir}`);
      continue;
    }
    if (!otherWorkspaceDir
        && isInsideDir(projectRoot, resolved)
        && !isInsideDir(workspaceDir, resolved)) {
      errors.push(`${label} falls back to integration-root path ${resolved} while stateFile is isolated under ${workspaceDir}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

function sanitizeWorkspaceName(name) {
  const cleaned = String(name ?? "").trim();
  return assertSafeIdentifier(cleaned || "default", "workspace name");
}

export const DEFAULT_WORKSPACE_NAME = "default";

function resolveUnpersistedWorkspacePaths(workDir, name, isolated, fallback) {
  const wsDir = resolveWorkspaceDir(workDir, name);
  return {
    name,
    type: /** @type {"isolated" | "shared"} */ (isolated ? "isolated" : "shared"),
    stateFile: isolated ? path.join(wsDir, "sprint-state.json") : path.resolve(workDir, fallback.stateFile),
    boardFile: isolated ? path.join(wsDir, "sprint.md") : path.resolve(workDir, fallback.boardFile),
    journalFile: isolated ? path.join(wsDir, "run-journal.md") : path.resolve(workDir, fallback.journalFile),
    pitfallsFile: isolated ? path.join(wsDir, "pitfalls.json") : path.resolve(workDir, fallback.pitfallsFile),
    dir: isolated ? wsDir : path.resolve(workDir),
    existed: false,
  };
}

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
  const isolated = options.isolated === true || name !== DEFAULT_WORKSPACE_NAME;

  if (!fs.existsSync(wsFile)) {
    // No persisted workspace → resolve by intent. Isolated requested (or name is
    // not "default") → workspace-scoped paths. Otherwise → project-root defaults.
    return resolveUnpersistedWorkspacePaths(workDir, name, isolated, fallback);
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
      dir: type === "isolated" ? wsDir : path.resolve(workDir),
      existed: true,
    };
  } catch {
    // A corrupt persisted definition must not recurse forever. Fall back to the
    // caller's explicit routing intent so the CLI can still diagnose/recover it.
    return resolveUnpersistedWorkspacePaths(workDir, name, isolated, fallback);
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
