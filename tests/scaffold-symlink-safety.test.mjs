import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliPath = path.join(repoRoot, "bin/va-auto-pilot.mjs");
const packageVersion = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")
).version;

function runCli(...args) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    cwd: repoRoot,
    encoding: "utf8"
  });
}

function makeFixture(t, name) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), `va-${name}-`));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const projectDir = path.join(fixtureRoot, "project");
  const outsideDir = path.join(fixtureRoot, "outside");
  fs.mkdirSync(projectDir);
  fs.mkdirSync(outsideDir);
  return { projectDir, outsideDir };
}

function symlinkOrSkip(t, target, destination, type) {
  try {
    fs.symlinkSync(target, destination, type);
    return true;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && ["EACCES", "EPERM", "ENOSYS"].includes(error.code)) {
      t.skip(`symbolic links unavailable: ${error.message}`);
      return false;
    }
    throw error;
  }
}

function installLegacyFixture(projectDir) {
  const stateDir = path.join(projectDir, ".va-auto-pilot");
  fs.mkdirSync(stateDir);
  fs.writeFileSync(path.join(stateDir, "config.yaml"), "projectPrefix: SAFE\n", "utf8");
  fs.writeFileSync(path.join(stateDir, "version.json"), JSON.stringify({
    packageVersion: "0.0.0",
    schemaVersion: 1,
    installedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z"
  }, null, 2) + "\n", "utf8");
}

test("init --force refuses a final destination symlink without changing its external target", (t) => {
  const { projectDir, outsideDir } = makeFixture(t, "init-final-symlink");
  const sentinelPath = path.join(outsideDir, "sentinel.json");
  const original = "external sentinel must remain unchanged\n";
  fs.writeFileSync(sentinelPath, original, "utf8");
  if (!symlinkOrSkip(t, sentinelPath, path.join(projectDir, "package.json"), "file")) {
    return;
  }

  const result = runCli("init", projectDir, "--force");

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Unsafe destination is a symbolic link/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), original);
  assert.ok(fs.lstatSync(path.join(projectDir, "package.json")).isSymbolicLink());
});

test("init --force refuses a symlinked destination parent without writing outside the project", (t) => {
  const { projectDir, outsideDir } = makeFixture(t, "init-parent-symlink");
  const sentinelPath = path.join(outsideDir, "auto-pilot.mjs");
  const original = "external script sentinel\n";
  fs.writeFileSync(sentinelPath, original, "utf8");
  if (!symlinkOrSkip(t, outsideDir, path.join(projectDir, "scripts"), "dir")) {
    return;
  }

  const result = runCli("init", projectDir, "--force");

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Unsafe destination parent is a symbolic link/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), original);
});

test("upgrade --force refuses a symlinked sentinel without changing its external target", (t) => {
  const { projectDir, outsideDir } = makeFixture(t, "upgrade-final-symlink");
  installLegacyFixture(projectDir);
  const sentinelPath = path.join(outsideDir, "upgrade-sentinel.txt");
  const original = "external upgrade sentinel\n";
  fs.writeFileSync(sentinelPath, original, "utf8");
  const upgradeMarker = path.join(projectDir, ".va-auto-pilot/.upgrade-in-progress");
  if (!symlinkOrSkip(t, sentinelPath, upgradeMarker, "file")) {
    return;
  }

  const result = runCli("upgrade", projectDir, "--force");

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Unsafe destination is a symbolic link/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), original);
  assert.ok(fs.lstatSync(upgradeMarker).isSymbolicLink());
});

test("upgrade refuses a symlinked scripts directory before writing outside the project", (t) => {
  const { projectDir, outsideDir } = makeFixture(t, "upgrade-parent-symlink");
  installLegacyFixture(projectDir);
  fs.rmSync(path.join(projectDir, "scripts"), { recursive: true, force: true });
  const sentinelPath = path.join(outsideDir, "auto-pilot.mjs");
  const original = "external script sentinel\n";
  fs.writeFileSync(sentinelPath, original, "utf8");
  if (!symlinkOrSkip(t, outsideDir, path.join(projectDir, "scripts"), "dir")) {
    return;
  }

  const result = runCli("upgrade", projectDir);

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /Unsafe destination parent is a symbolic link/);
  assert.equal(fs.readFileSync(sentinelPath, "utf8"), original);
  assert.equal(fs.existsSync(path.join(projectDir, ".va-auto-pilot/.upgrade-in-progress")), false);
});

test("normal init and upgrade still succeed with safe project paths", (t) => {
  const { projectDir } = makeFixture(t, "scaffold-normal");
  const initResult = runCli("init", projectDir);
  assert.equal(initResult.status, 0, initResult.stderr);

  const versionPath = path.join(projectDir, ".va-auto-pilot/version.json");
  const installed = JSON.parse(fs.readFileSync(versionPath, "utf8"));
  installed.packageVersion = "0.0.0";
  fs.writeFileSync(versionPath, JSON.stringify(installed, null, 2) + "\n", "utf8");

  const upgradeResult = runCli("upgrade", projectDir);
  assert.equal(upgradeResult.status, 0, upgradeResult.stderr);
  assert.equal(JSON.parse(fs.readFileSync(versionPath, "utf8")).packageVersion, packageVersion);
});
