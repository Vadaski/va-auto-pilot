import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import { autoCommitTask, commitPaths } from "../scripts/auto-pilot-loop.mjs";

function initRepository(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  assert.equal(git(["init", "-q"]).status, 0);
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "base.txt"), "base\n");
  assert.equal(git(["add", "base.txt"]).status, 0);
  assert.equal(git(["commit", "-qm", "base"]).status, 0);
  return { root, git };
}

async function waitForFile(filePath, timeoutMs = 20_000) {
  const startedAt = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - startedAt >= timeoutMs) {
      throw new Error(`timed out waiting for ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("commitPaths serializes concurrent commits before hooks and HEAD updates", async (t) => {
  if (process.platform === "win32") {
    t.skip("the synchronization hook uses POSIX shell commands");
    return;
  }
  const { root, git } = initRepository("va-concurrent-commit-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");

  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, [
    "#!/bin/sh",
    "critical=\"$PWD/.hook-critical\"",
    "mkdir \"$critical\" 2>/dev/null || exit 91",
    "sleep 0.2",
    "rmdir \"$critical\"",
    "",
  ].join("\n"), { mode: 0o755 });

  const opts = { workDir: root, env: process.env };
  const [first, second] = await Promise.all([
    commitPaths("feat: commit task a", ["task-a.txt"], opts),
    commitPaths("feat: commit task b", ["task-b.txt"], opts),
  ]);

  assert.equal(first.committed, true);
  assert.equal(second.committed, true);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
  assert.equal(git(["status", "--short", "--", "task-a.txt", "task-b.txt"]).stdout, "");
  assert.equal(fs.existsSync(path.join(root, ".hook-critical")), false);
});

test("commitPaths leaves HEAD and the real index unchanged when the index cannot be locked", async () => {
  const { root, git } = initRepository("va-index-transaction-");
  fs.writeFileSync(path.join(root, "approved.txt"), "approved\n");
  const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();
  const indexBefore = git(["ls-files", "--stage"]).stdout;
  const indexLock = path.join(root, ".git", "index.lock");
  fs.writeFileSync(indexLock, "held by another git process\n");

  try {
    await assert.rejects(
      () => commitPaths("feat: should not half commit", ["approved.txt"], {
        workDir: root,
        env: process.env,
        commitIndexLockTimeoutMs: 75,
      }),
      (error) => error?.code === "GIT_INDEX_LOCKED"
    );
  } finally {
    fs.rmSync(indexLock, { force: true });
  }

  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), headBefore);
  assert.equal(git(["ls-files", "--stage"]).stdout, indexBefore);
  assert.match(git(["status", "--short", "--", "approved.txt"]).stdout, /\?\? approved\.txt/);
});

test("a later commit recovers a durable index snapshot before building its own index", async () => {
  const { root, git } = initRepository("va-index-recovery-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  let rejectFirstPublish = true;
  const first = await commitPaths("feat: durable task a", ["task-a.txt"], {
    workDir: root,
    env: process.env,
    renameIndexFile(source, target) {
      if (rejectFirstPublish) {
        rejectFirstPublish = false;
        throw new Error("injected index publish failure");
      }
      fs.renameSync(source, target);
    },
  });

  assert.equal(first.committed, true);
  assert.equal(first.indexRefresh.ok, false);
  assert.equal(fs.existsSync(first.indexRefresh.recoveryFile), true);

  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");
  const second = await commitPaths("feat: task b after recovery", ["task-b.txt"], {
    workDir: root,
    env: process.env,
  });

  assert.equal(second.committed, true);
  assert.equal(second.indexRefresh.ok, true);
  assert.equal(fs.existsSync(first.indexRefresh.recoveryFile), false);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
  assert.equal(git(["status", "--short", "--", "task-a.txt", "task-b.txt"]).stdout, "");
});

test("baseline rollback never removes an external commit that advanced HEAD", async (t) => {
  if (process.platform === "win32") {
    t.skip("the synchronization hook uses POSIX shell commands");
    return;
  }
  const { root, git } = initRepository("va-baseline-cas-");
  const baselinePath = path.join(root, "baseline.txt");
  const taskPath = path.join(root, "task.txt");
  const baselineContent = "dirty before task\n";
  fs.writeFileSync(baselinePath, baselineContent);
  const baselineSnapshot = { exists: true, content: Buffer.from(baselineContent) };
  fs.writeFileSync(baselinePath, "dirty after task\n");
  fs.writeFileSync(taskPath, "task change\n");

  const hookReady = path.join(root, ".git", "task-hook-ready");
  const hookContinue = path.join(root, ".git", "task-hook-continue");
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, [
    "#!/bin/sh",
    "count_file=.git/va-hook-count",
    "count=0",
    "test -f \"$count_file\" && count=$(cat \"$count_file\")",
    "count=$((count + 1))",
    "printf '%s\\n' \"$count\" > \"$count_file\"",
    "test \"$count\" -eq 1 && exit 0",
    "touch .git/task-hook-ready",
    "while test ! -f .git/task-hook-continue; do sleep 0.02; done",
    "exit 1",
    "",
  ].join("\n"), { mode: 0o755 });

  const taskResult = autoCommitTask(
    { id: "AP-001", title: "CAS-safe baseline rollback", source: "test" },
    {
      workDir: root,
      env: process.env,
      stateFile: path.join(root, ".va-auto-pilot", "sprint-state.json"),
      boardFile: path.join(root, "docs", "todo", "sprint.md"),
      journalFile: path.join(root, "docs", "todo", "run-journal.md"),
      pitfallsFile: path.join(root, ".va-auto-pilot", "pitfalls.json"),
      taskBaselines: new Map([["AP-001", {
        files: new Set(["baseline.txt"]),
        snapshots: new Map([["baseline.txt", baselineSnapshot]]),
      }]]),
      dryRun: false,
      noCommit: false,
    }
  ).then(
    (value) => ({ value, error: null }),
    (error) => ({ value: null, error })
  );

  try {
    await waitForFile(hookReady);
    fs.writeFileSync(path.join(root, "external.txt"), "external\n");
    assert.equal(git(["add", "external.txt"]).status, 0);
    assert.equal(git(["commit", "--no-verify", "-qm", "external", "--only", "--", "external.txt"]).status, 0);
  } finally {
    fs.writeFileSync(hookContinue, "continue\n");
  }

  const outcome = await taskResult;
  assert.equal(outcome.value, null);
  assert.match(outcome.error?.message ?? "", /baseline rollback skipped safely: HEAD advanced/);
  assert.equal(git(["show", "HEAD:external.txt"]).stdout, "external\n");
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
  assert.equal(git(["show", "HEAD^:baseline.txt"]).stdout, baselineContent);
});
