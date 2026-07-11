import assert from "node:assert/strict";
import crypto from "node:crypto";
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

function createInterruptedIndexTransaction(root, git, { advanceHead }) {
  const parent = git(["rev-parse", "HEAD"]).stdout.trim();
  const candidateIndex = path.join(root, ".git", `candidate-index-${process.pid}-${Date.now()}`);
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  const candidateGit = (args, options = {}) => spawnSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_INDEX_FILE: candidateIndex },
    ...options,
  });
  assert.equal(candidateGit(["read-tree", parent]).status, 0);
  assert.equal(candidateGit(["add", "--", "task-a.txt"]).status, 0);
  const tree = candidateGit(["write-tree"]);
  assert.equal(tree.status, 0);
  const commit = candidateGit(["commit-tree", tree.stdout.trim(), "-p", parent], {
    input: "feat: interrupted task a\n",
  });
  assert.equal(commit.status, 0);
  const commitHash = commit.stdout.trim();
  const recoveryFile = path.join(
    root,
    ".git",
    `va-auto-pilot-index-recovery-${commitHash}-${crypto.randomUUID()}`
  );
  const indexLock = path.join(root, ".git", "index.lock");
  fs.copyFileSync(candidateIndex, recoveryFile);
  fs.linkSync(recoveryFile, indexLock);
  fs.rmSync(candidateIndex, { force: true });
  if (advanceHead) {
    assert.equal(git(["update-ref", "HEAD", commitHash, parent]).status, 0);
  }
  return { parent, commitHash, recoveryFile, indexLock };
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

function createGitUpdateRefWrapper(root, mode) {
  const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  const binDir = path.join(root, `git-wrapper-${mode}`);
  fs.mkdirSync(binDir, { recursive: true });
  const wrapper = path.join(binDir, "git");
  const updateRefLines = mode === "after"
    ? [`  ${JSON.stringify(realGit)} "$@"`, "  exit 93"]
    : ["  exit 93"];
  fs.writeFileSync(wrapper, [
    "#!/bin/sh",
    "if test \"$1\" = update-ref; then",
    ...updateRefLines,
    "fi",
    `exec ${JSON.stringify(realGit)} "$@"`,
    "",
  ].join("\n"), { mode: 0o755 });
  return { ...process.env, PATH: `${binDir}:${process.env.PATH}` };
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
  assert.equal(fs.existsSync(path.join(root, ".git", "index.lock")), true);
  const recoveryStat = fs.statSync(first.indexRefresh.recoveryFile);
  const lockStat = fs.statSync(path.join(root, ".git", "index.lock"));
  assert.equal(recoveryStat.dev, lockStat.dev);
  assert.equal(recoveryStat.ino, lockStat.ino);

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

test("a later commit finishes a complete owned transaction after a crash before HEAD update", async () => {
  const { root, git } = initRepository("va-index-crash-before-ref-");
  const interrupted = createInterruptedIndexTransaction(root, git, { advanceHead: false });
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), interrupted.parent);

  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");
  const result = await commitPaths("feat: task b after aborted transaction", ["task-b.txt"], {
    workDir: root,
    env: process.env,
    commitIndexLockTimeoutMs: 75,
  });

  assert.equal(result.committed, true);
  assert.equal(fs.existsSync(interrupted.recoveryFile), false);
  assert.equal(fs.existsSync(interrupted.indexLock), false);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
  assert.equal(git(["status", "--short", "--", "task-a.txt", "task-b.txt"]).stdout, "");
});

test("a later commit discards a partial owned index written before HEAD update", async () => {
  const { root, git } = initRepository("va-index-crash-partial-before-ref-");
  const interrupted = createInterruptedIndexTransaction(root, git, { advanceHead: false });
  fs.truncateSync(interrupted.recoveryFile, 7);
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");

  const result = await commitPaths("feat: task b after partial transaction", ["task-b.txt"], {
    workDir: root,
    env: process.env,
  });

  assert.equal(result.committed, true);
  assert.equal(fs.existsSync(interrupted.recoveryFile), false);
  assert.equal(fs.existsSync(interrupted.indexLock), false);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "2");
  assert.match(git(["status", "--short", "--", "task-a.txt"]).stdout, /\?\? task-a\.txt/);
  assert.equal(git(["status", "--short", "--", "task-b.txt"]).stdout, "");
});

test("a later commit publishes its owned index lock after a crash following HEAD update", async () => {
  const { root, git } = initRepository("va-index-crash-after-ref-");
  const interrupted = createInterruptedIndexTransaction(root, git, { advanceHead: true });
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), interrupted.commitHash);

  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");
  const result = await commitPaths("feat: task b after committed transaction", ["task-b.txt"], {
    workDir: root,
    env: process.env,
    commitIndexLockTimeoutMs: 75,
  });

  assert.equal(result.committed, true);
  assert.equal(fs.existsSync(interrupted.recoveryFile), false);
  assert.equal(fs.existsSync(interrupted.indexLock), false);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "3");
  assert.equal(git(["status", "--short", "--", "task-a.txt", "task-b.txt"]).stdout, "");
});

test("index crash recovery refuses a byte-identical foreign Git index lock", async () => {
  const { root, git } = initRepository("va-index-crash-foreign-lock-");
  const interrupted = createInterruptedIndexTransaction(root, git, { advanceHead: true });
  const candidate = fs.readFileSync(interrupted.recoveryFile);
  fs.rmSync(interrupted.indexLock);
  fs.writeFileSync(interrupted.indexLock, candidate);
  const foreignHandle = fs.openSync(interrupted.indexLock, "r+");
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");

  try {
    await assert.rejects(
      () => commitPaths("feat: must fail closed", ["task-b.txt"], {
        workDir: root,
        env: process.env,
        commitIndexLockTimeoutMs: 75,
      }),
      (error) => error?.code === "INDEX_RECOVERY_REQUIRED"
    );
  } finally {
    fs.closeSync(foreignHandle);
  }

  assert.equal(fs.existsSync(interrupted.recoveryFile), true);
  assert.equal(fs.existsSync(interrupted.indexLock), true);
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), interrupted.commitHash);
});

test("index crash recovery refuses a symlink that aliases its owner marker", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation may require elevated privileges on Windows");
    return;
  }
  const { root, git } = initRepository("va-index-crash-symlink-lock-");
  const interrupted = createInterruptedIndexTransaction(root, git, { advanceHead: true });
  fs.rmSync(interrupted.indexLock);
  fs.symlinkSync(interrupted.recoveryFile, interrupted.indexLock);
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");

  await assert.rejects(
    () => commitPaths("feat: reject symlink lock", ["task-b.txt"], {
      workDir: root,
      env: process.env,
    }),
    (error) => error?.code === "INDEX_RECOVERY_REQUIRED"
  );

  assert.equal(fs.lstatSync(interrupted.indexLock).isSymbolicLink(), true);
  assert.equal(fs.existsSync(interrupted.recoveryFile), true);
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), interrupted.commitHash);
});

test("index recovery never overwrites user staging after its owned lock was removed", async () => {
  const { root, git } = initRepository("va-index-recovery-user-stage-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  const first = await commitPaths("feat: durable task a", ["task-a.txt"], {
    workDir: root,
    env: process.env,
    renameIndexFile() {
      throw new Error("injected index publish failure");
    },
  });
  assert.equal(first.committed, true);
  assert.equal(first.indexRefresh.ok, false);

  fs.rmSync(path.join(root, ".git", "index.lock"));
  fs.writeFileSync(path.join(root, "user-staged.txt"), "user\n");
  assert.equal(git(["add", "user-staged.txt"]).status, 0);
  const stagedBefore = git(["diff", "--cached", "--name-only"]).stdout;
  const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();
  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");

  await assert.rejects(
    () => commitPaths("feat: must preserve user staging", ["task-b.txt"], {
      workDir: root,
      env: process.env,
    }),
    (error) => error?.code === "INDEX_RECOVERY_REQUIRED"
  );

  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), headBefore);
  assert.equal(git(["diff", "--cached", "--name-only"]).stdout, stagedBefore);
  assert.match(stagedBefore, /user-staged\.txt/);
  assert.equal(fs.existsSync(first.indexRefresh.recoveryFile), true);
});

test("finalize recognizes a publish that succeeded before its wrapper threw", async () => {
  const { root, git } = initRepository("va-index-publish-then-throw-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  const result = await commitPaths("feat: publish then throw", ["task-a.txt"], {
    workDir: root,
    env: process.env,
    renameIndexFile(source, target) {
      fs.renameSync(source, target);
      throw new Error("injected post-rename failure");
    },
  });

  assert.equal(result.committed, true);
  assert.equal(result.indexRefresh.ok, true);
  assert.equal(result.indexRefresh.recoveryFile, "");
  assert.equal(git(["status", "--short", "--", "task-a.txt"]).stdout, "");
  assert.equal(fs.readdirSync(path.join(root, ".git")).some((name) => (
    name.startsWith("va-auto-pilot-index-recovery-")
  )), false);
});

test("directory fsync failure after index rename preserves recovery evidence", async () => {
  const { root, git } = initRepository("va-index-directory-fsync-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  let syncCalls = 0;
  const first = await commitPaths("feat: durable rename with failed dir sync", ["task-a.txt"], {
    workDir: root,
    env: process.env,
    fsyncIndexDirectory() {
      syncCalls += 1;
      if (syncCalls === 2) {
        throw Object.assign(new Error("injected directory fsync failure"), { code: "EIO" });
      }
    },
  });

  assert.equal(first.committed, true);
  assert.equal(first.indexRefresh.ok, false);
  assert.equal(fs.existsSync(first.indexRefresh.recoveryFile), true);
  assert.equal(fs.existsSync(path.join(root, ".git", "index.lock")), false);
  assert.equal(git(["status", "--short", "--", "task-a.txt"]).stdout, "");

  fs.writeFileSync(path.join(root, "task-b.txt"), "b\n");
  const second = await commitPaths("feat: recover after directory sync", ["task-b.txt"], {
    workDir: root,
    env: process.env,
  });
  assert.equal(second.committed, true);
  assert.equal(fs.existsSync(first.indexRefresh.recoveryFile), false);
  assert.equal(git(["status", "--short", "--", "task-a.txt", "task-b.txt"]).stdout, "");
});

test("real-index publication loops until a short write is complete", async () => {
  const { root, git } = initRepository("va-index-short-write-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  let writes = 0;
  const result = await commitPaths("feat: tolerate short index writes", ["task-a.txt"], {
    workDir: root,
    env: process.env,
    writeIndexChunk(fd, buffer, offset, length, position) {
      writes += 1;
      return fs.writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
    },
  });

  assert.equal(result.committed, true);
  assert.equal(result.indexRefresh.ok, true);
  assert.ok(writes > 1);
  assert.equal(git(["status", "--short", "--", "base.txt", "task-a.txt"]).stdout, "");
  assert.match(git(["ls-files", "--stage", "--", "task-a.txt"]).stdout, /task-a\.txt/);
});

test("real-index publication verifies bytes before advancing HEAD", async () => {
  const { root, git } = initRepository("va-index-corrupt-write-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();

  await assert.rejects(
    () => commitPaths("feat: reject corrupt index write", ["task-a.txt"], {
      workDir: root,
      env: process.env,
      writeIndexChunk(fd, buffer, offset, length, position) {
        fs.writeSync(fd, buffer, offset, Math.max(1, Math.floor(length / 2)), position);
        return length;
      },
    }),
    (error) => error?.code === "INDEX_CANDIDATE_WRITE_FAILED"
  );

  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), headBefore);
  assert.equal(fs.existsSync(path.join(root, ".git", "index.lock")), false);
  assert.equal(fs.readdirSync(path.join(root, ".git")).some((name) => (
    name.startsWith("va-auto-pilot-index-recovery-")
  )), false);
  assert.match(git(["status", "--short", "--", "task-a.txt"]).stdout, /\?\? task-a\.txt/);
});

test("update-ref success is recovered when the command reports a later error", async (t) => {
  if (process.platform === "win32") {
    t.skip("the injected Git wrapper uses a POSIX shell script");
    return;
  }
  const { root, git } = initRepository("va-update-ref-after-error-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  const result = await commitPaths("feat: ambiguous update-ref success", ["task-a.txt"], {
    workDir: root,
    env: createGitUpdateRefWrapper(root, "after"),
  });

  assert.equal(result.committed, true);
  assert.equal(result.indexRefresh.ok, true);
  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), result.hash);
  assert.equal(git(["status", "--short", "--", "task-a.txt"]).stdout, "");
  assert.equal(fs.existsSync(path.join(root, ".git", "index.lock")), false);
});

test("update-ref failure before the ref change rolls back its owned index artifacts", async (t) => {
  if (process.platform === "win32") {
    t.skip("the injected Git wrapper uses a POSIX shell script");
    return;
  }
  const { root, git } = initRepository("va-update-ref-before-error-");
  fs.writeFileSync(path.join(root, "task-a.txt"), "a\n");
  const headBefore = git(["rev-parse", "HEAD"]).stdout.trim();
  await assert.rejects(
    () => commitPaths("feat: rejected update-ref", ["task-a.txt"], {
      workDir: root,
      env: createGitUpdateRefWrapper(root, "before"),
    }),
    (error) => error?.code === "COMMIT_CONTEXT_STALE"
  );

  assert.equal(git(["rev-parse", "HEAD"]).stdout.trim(), headBefore);
  assert.equal(fs.existsSync(path.join(root, ".git", "index.lock")), false);
  assert.equal(fs.readdirSync(path.join(root, ".git")).some((name) => (
    name.startsWith("va-auto-pilot-index-recovery-")
  )), false);
});

test("commitPaths creates the first commit in an unborn SHA-256 repository", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "va-sha256-unborn-"));
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
  const initialized = git(["init", "-q", "--object-format=sha256"]);
  if (initialized.status !== 0) {
    t.skip("installed Git does not support SHA-256 repositories");
    return;
  }
  assert.equal(git(["config", "user.email", "test@example.invalid"]).status, 0);
  assert.equal(git(["config", "user.name", "Test"]).status, 0);
  fs.writeFileSync(path.join(root, "first.txt"), "first\n");

  const result = await commitPaths("feat: first sha256 commit", ["first.txt"], {
    workDir: root,
    env: process.env,
  });
  assert.equal(result.committed, true);
  assert.equal(result.hash.length, 64);
  assert.equal(git(["rev-list", "--count", "HEAD"]).stdout.trim(), "1");
  assert.equal(git(["status", "--short"]).stdout, "");
});

test("commitPaths preserves non-ASCII filenames in the real index", async () => {
  const { root, git } = initRepository("va-unicode-index-path-");
  const filename = "测试 文件.txt";
  fs.writeFileSync(path.join(root, filename), "unicode\n");
  const result = await commitPaths("feat: unicode filename", [filename], {
    workDir: root,
    env: process.env,
  });

  assert.equal(result.committed, true);
  assert.equal(git(["status", "--porcelain=v1", "-z"]).stdout, "");
  assert.equal(git(["ls-files", "-z", "--", filename]).stdout, `${filename}\0`);
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
