import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireLock, releaseLock } from "../scripts/lib/doc-store/locking.mjs";
import { classifyCommandPermission } from "../scripts/lib/permission-scope.mjs";

const DEAD_PID = 999_999_999;

function fixture(t, prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, "resource.lock");
}

test("a crashed reaper marker is recovered instead of blocking forever", async (t) => {
  const lockPath = fixture(t, "va-stale-reaper-");
  const reaperPath = `${lockPath}.reap`;
  fs.writeFileSync(reaperPath, JSON.stringify({
    pid: DEAD_PID,
    acquiredAt: "2020-01-01T00:00:00.000Z",
    ownerToken: "crashed-reaper",
  }));

  const held = await acquireLock(lockPath, { timeoutMs: 2_000 });
  const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(typeof owner.ownerToken, "string");
  assert.notEqual(owner.ownerToken, "crashed-reaper");
  assert.equal(fs.existsSync(reaperPath), false);
  await releaseLock(held);
});

test("a live reaper marker is neither stolen nor unlinked", async (t) => {
  const lockPath = fixture(t, "va-live-reaper-");
  const reaperPath = `${lockPath}.reap`;
  const marker = JSON.stringify({
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
    ownerToken: "live-reaper",
  });
  fs.writeFileSync(reaperPath, marker);

  await assert.rejects(() => acquireLock(lockPath, { timeoutMs: 50 }), /lock/i);
  assert.equal(fs.readFileSync(reaperPath, "utf8"), marker);
});

test("an empty lock left by a crashed legacy writer is safely recovered", async (t) => {
  const lockPath = fixture(t, "va-empty-lock-");
  fs.writeFileSync(lockPath, "");
  const stale = new Date(Date.now() - 5_000);
  fs.utimesSync(lockPath, stale, stale);

  const held = await acquireLock(lockPath, { timeoutMs: 2_000 });
  const owner = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(owner.pid, process.pid);
  assert.equal(typeof owner.ownerToken, "string");
  await releaseLock(held);
});

test("stale lock and reaper recovery remains mutually exclusive under contention", async (t) => {
  const lockPath = fixture(t, "va-reaper-contention-");
  fs.writeFileSync(lockPath, JSON.stringify({ pid: DEAD_PID, ownerToken: "dead-lock" }));
  fs.writeFileSync(`${lockPath}.reap`, JSON.stringify({ pid: DEAD_PID, ownerToken: "dead-reaper" }));
  let active = 0;
  let maxActive = 0;

  await Promise.all(Array.from({ length: 12 }, async () => {
    const held = await acquireLock(lockPath, { timeoutMs: 15_000 });
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    await releaseLock(held);
  }));

  assert.equal(maxActive, 1);
});

test("destructive long flags and filesystem APIs take precedence over allow rules", () => {
  const policy = {
    fileScopes: [{ path: ".", access: "read-write" }],
    commands: {
      allow: ["rm", "git", "node"],
      deny: [],
      destructiveRequiresOptIn: true,
      destructiveAllow: [],
    },
  };
  const commands = [
    "rm --recursive --force dist",
    "rm --force --recursive dist",
    "rm -r --force dist",
    "rm --recursive -f dist",
    "rm -Rv --force dist",
    "/bin/rm --force -R dist",
    "git clean --force -d",
    "git -C . clean -dfx",
    "node -e 'fs.promises.rm(\"dist\", { recursive: true })'",
    "node -e 'fs.promises.rmdir(\"dist\")'",
    "node -e 'fs.rm(\"dist\", () => {})'",
    "node -e 'rmSync(\"dist\", { recursive: true })'",
    "node -e 'rmdir(\"dist\", () => {})'",
  ];

  for (const command of commands) {
    assert.equal(
      classifyCommandPermission(command, policy).action,
      "requires-opt-in",
      command
    );
  }

  assert.equal(classifyCommandPermission("rm --force one-file.txt", policy).action, "allow");
});

test("destructive commands are denied when opt-in is disabled unless explicitly exempted", () => {
  const policy = {
    fileScopes: [{ path: ".", access: "read-write" }],
    commands: {
      allow: ["git"],
      deny: [],
      destructiveRequiresOptIn: false,
      destructiveAllow: [],
    },
  };
  assert.equal(classifyCommandPermission("git clean --force", policy).action, "deny");

  policy.commands.destructiveAllow.push("git clean --force");
  assert.equal(classifyCommandPermission("git clean --force", policy).action, "allow");
});
