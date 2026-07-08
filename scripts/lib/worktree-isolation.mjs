import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);

export const DEFAULT_WORKTREE_ISOLATION = Object.freeze({
  enabled: false,
  rootDir: ".va/worktrees",
  branchPrefix: "va-track",
  cleanup: "keep",
});

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeRefPart(value) {
  return String(value ?? "")
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "track";
}

export function resolveTrackWorktreePath(root, config, runId, taskId) {
  const normalized = { ...DEFAULT_WORKTREE_ISOLATION, ...(config ?? {}) };
  return path.resolve(
    root,
    normalized.rootDir,
    sanitizeRefPart(runId),
    sanitizeRefPart(taskId)
  );
}

function splitLines(value) {
  return String(value ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function isWorktreeRuntimeFile(file) {
  const normalized = String(file ?? "").replace(/\\/g, "/");
  return normalized.startsWith(".va-auto-pilot/orchestration/")
    || normalized.startsWith(".va-auto-pilot/evidence/");
}

function readConfig(configPath) {
  const resolved = path.resolve(configPath ?? ".va-auto-pilot/config.yaml");
  if (!fs.existsSync(resolved)) {
    return {};
  }
  try {
    const parsed = parseYaml(fs.readFileSync(resolved, "utf8"));
    return isObject(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} [configPath]
 * @returns {{ enabled: boolean, rootDir: string, branchPrefix: string, cleanup: string }}
 */
export function readWorktreeIsolationConfig(configPath) {
  const config = readConfig(configPath);
  const raw = isObject(config.worktreeIsolation) ? config.worktreeIsolation : {};
  return {
    ...DEFAULT_WORKTREE_ISOLATION,
    ...Object.fromEntries(Object.entries(raw).filter(([, value]) => value !== undefined && value !== null)),
  };
}

async function git(args, cwd, timeout = 60_000) {
  return execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout,
  });
}

async function isGitWorktree(worktreePath) {
  try {
    const result = await git(["rev-parse", "--is-inside-work-tree"], worktreePath, 10_000);
    return result.stdout.trim() === "true";
  } catch {
    return false;
  }
}

export async function prepareTrackWorktree({ workDir, runId, taskId, config }) {
  const normalized = { ...DEFAULT_WORKTREE_ISOLATION, ...(config ?? {}) };
  if (normalized.enabled !== true) {
    return { enabled: false, status: "disabled" };
  }

  const root = (await git(["rev-parse", "--show-toplevel"], workDir, 10_000)).stdout.trim() || workDir;
  const targetPath = resolveTrackWorktreePath(root, normalized, runId, taskId);
  const branch = `${sanitizeRefPart(normalized.branchPrefix)}/${sanitizeRefPart(taskId)}-${sanitizeRefPart(runId).slice(0, 24)}`;

  if (fs.existsSync(targetPath)) {
    if (await isGitWorktree(targetPath)) {
      return {
        enabled: true,
        status: "ready",
        reused: true,
        path: targetPath,
        branch,
      };
    }
    const entries = fs.readdirSync(targetPath);
    if (entries.length > 0) {
      throw new Error(`worktree path exists and is not a git worktree: ${targetPath}`);
    }
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  await git(["worktree", "add", "-B", branch, targetPath, "HEAD"], root, 120_000);
  return {
    enabled: true,
    status: "ready",
    reused: false,
    path: targetPath,
    branch,
  };
}

export async function commitTrackWorktreeResult({ task, worktree }) {
  if (!worktree?.enabled || !worktree.path) {
    return { committed: false, skipped: true, reason: "worktree isolation disabled", hash: "" };
  }

  const changed = [
    ...splitLines((await git(["diff", "--name-only", "--relative", "HEAD", "--"], worktree.path)).stdout),
    ...splitLines((await git(["ls-files", "--others", "--exclude-standard"], worktree.path)).stdout),
  ];
  const files = [...new Set(changed)]
    .filter((file) => !isWorktreeRuntimeFile(file))
    .sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    return { committed: false, skipped: true, reason: "worktree clean", hash: "", files: [] };
  }

  await git(["add", "--all", "--", ...files], worktree.path);
  await execFileAsync("git", [
    "-c", "user.name=VA Auto-Pilot",
    "-c", "user.email=va-auto-pilot@example.invalid",
    "commit",
    "-m", `wip(track): ${task?.id ?? "task"} ${String(task?.title ?? "").trim()}`.trim(),
  ], {
    cwd: worktree.path,
    encoding: "utf8",
    timeout: 120_000,
  });
  const head = await git(["rev-parse", "HEAD"], worktree.path, 10_000);
  return {
    committed: true,
    skipped: false,
    reason: "",
    hash: head.stdout.trim(),
    files,
  };
}

export async function squashMergeTrackCommit({ workDir, track }) {
  const commit = track?.worktree?.resultCommit;
  if (!commit) {
    return { merged: false, skipped: true, reason: "no worktree result commit", hash: "" };
  }
  await git(["merge", "--squash", commit], workDir, 120_000);
  return { merged: true, skipped: false, reason: "", hash: commit };
}
