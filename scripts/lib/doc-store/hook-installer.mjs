import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const DOC_STORE_PRE_COMMIT_MARKER = "# doc-store managed pre-commit hook";
export const DOC_STORE_PRE_COMMIT_BACKUP = "pre-commit.doc-store-prev";

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(targetPath) {
  try {
    return await fs.readFile(targetPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function resolveHooksDir(projectRoot) {
  const root = path.resolve(projectRoot);
  const hooksDir = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: root,
    encoding: "utf8"
  }).trim();
  return path.resolve(root, hooksDir);
}

export function resolveHookPaths(projectRoot = process.cwd()) {
  const resolvedRoot = path.resolve(projectRoot);
  const hooksDir = resolveHooksDir(resolvedRoot);
  return {
    projectRoot: resolvedRoot,
    hooksDir,
    hookPath: path.join(hooksDir, "pre-commit"),
    backupHookPath: path.join(hooksDir, DOC_STORE_PRE_COMMIT_BACKUP)
  };
}

export function isManagedPreCommitHook(content) {
  return typeof content === "string" && content.includes(DOC_STORE_PRE_COMMIT_MARKER);
}

function buildManagedPreCommitHook({ nodePath }) {
  const cliPath = fileURLToPath(new URL("../../doc-store-cli.mjs", import.meta.url));
  return `#!/usr/bin/env bash
set -euo pipefail
${DOC_STORE_PRE_COMMIT_MARKER}

HOOK_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
REPO_ROOT="$(git rev-parse --show-toplevel)"
PREV_HOOK="$HOOK_DIR/${DOC_STORE_PRE_COMMIT_BACKUP}"

if [ -x "$PREV_HOOK" ]; then
  "$PREV_HOOK" "$@"
fi

cd "$REPO_ROOT"
exec ${shellQuote(nodePath)} ${shellQuote(cliPath)} enforce-staged "$@"
`;
}

export async function installPreCommitHook(projectRoot = process.cwd(), options = {}) {
  const { nodePath } = options;
  const paths = resolveHookPaths(projectRoot);
  const hookContent = await readTextIfExists(paths.hookPath);
  const backupExists = await pathExists(paths.backupHookPath);

  await fs.mkdir(paths.hooksDir, { recursive: true });

  if (hookContent !== null && isManagedPreCommitHook(hookContent)) {
    await fs.chmod(paths.hookPath, 0o755);
    return {
      ok: true,
      action: "already-installed",
      preservedExistingHook: backupExists,
      ...paths
    };
  }

  if (hookContent !== null) {
    if (backupExists) {
      throw new Error(`Refusing to install doc-store hook: backup already exists at ${paths.backupHookPath}`);
    }
    await fs.rename(paths.hookPath, paths.backupHookPath);
  }

  await fs.writeFile(paths.hookPath, buildManagedPreCommitHook({ nodePath: nodePath ?? process.execPath }), "utf8");
  await fs.chmod(paths.hookPath, 0o755);

  return {
    ok: true,
    action: hookContent === null ? "installed" : "installed-with-backup",
    preservedExistingHook: hookContent !== null || backupExists,
    ...paths
  };
}

export async function uninstallPreCommitHook(projectRoot = process.cwd()) {
  const paths = resolveHookPaths(projectRoot);
  const hookContent = await readTextIfExists(paths.hookPath);
  const backupExists = await pathExists(paths.backupHookPath);

  if (hookContent === null) {
    if (backupExists) {
      return {
        ok: true,
        action: "backup-present-without-managed-hook",
        preservedExistingHook: true,
        ...paths
      };
    }
    return {
      ok: true,
      action: "not-installed",
      preservedExistingHook: false,
      ...paths
    };
  }

  if (!isManagedPreCommitHook(hookContent)) {
    return {
      ok: true,
      action: "not-installed",
      preservedExistingHook: backupExists,
      ...paths
    };
  }

  await fs.rm(paths.hookPath, { force: true });
  if (backupExists) {
    await fs.rename(paths.backupHookPath, paths.hookPath);
    await fs.chmod(paths.hookPath, 0o755);
    return {
      ok: true,
      action: "uninstalled-restored-backup",
      preservedExistingHook: true,
      ...paths
    };
  }

  return {
    ok: true,
    action: "uninstalled",
    preservedExistingHook: false,
    ...paths
  };
}
